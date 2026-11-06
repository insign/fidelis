import { Plugin } from "@opencode/plugin"
import { Auditor, FIDELIS_MARKER, opencodeDecisions, resolveConfig, Store, type Finding, type SessionState } from "fidelis"
import { buildEvidence, childSessions, effectiveSources, finalBoundary, generateViaTempSession, messageOrigin, toEvents } from "./adapter.ts"
import { FidelisRpc } from "./rpc.ts"

const actionable = (findings: Finding[]) => findings.filter((finding) => finding.status === "VIOLATED" && !finding.resolved).length
/** A child session that never answers must cost evidence, never stall every later audit of the parent. */
const CHILD_TIMEOUT_MS = 10_000
/** The idle record can land just after the completion signal: one bounded re-read, never a silent skip. */
const BOUNDARY_RETRY_MS = 250

export default Plugin.define({
  id: "fidelis",
  async setup(ctx) {
    const options = (ctx.options ?? {}) as Record<string, unknown>
    const config = resolveConfig("opencode", options)
    if (!config.enabled) return

    const temp = new Set<string>()
    const ambient = new Map<string, string>()
    const nested = new Map<string, Map<string, string>>()
    const queue = new Map<string, Promise<void>>()
    const store = new Store("opencode")
    const nestedFor = (sessionID: string) => nested.get(sessionID) ?? nested.set(sessionID, new Map(Object.entries(store.readNested(sessionID)))).get(sessionID)!
    store.cleanup(config.retentionDays)

    // RPC output must be strict JSON: an undefined field is rejected as rpc.invalid_output.
    const rpc = await ctx.rpc.register(FidelisRpc, { ui: async () => config.ui, status: async (input: any) => JSON.parse(JSON.stringify(auditor.status(input.sessionID))) })
    const emit = (state: SessionState, transition: string) => {
      void rpc.events
        .emit("changed", { sessionID: state.sessionID, revision: state.revision, state: state.state, phase: state.phase, auditID: state.audit?.id ?? state.lastAuditID ?? null, transition, updatedAt: state.updatedAt, actionable: actionable(state.findings) })
        .catch(() => {})
    }
    const decisions = (ctx as any).experimental?.generate?.decisions
    const auditor = new Auditor({
      store,
      host: "opencode",
      config,
      options,
      compiler: (prompt) => generateViaTempSession(ctx, temp, config.compilerModel, prompt),
      judge: decisions ? opencodeDecisions(decisions.bind((ctx as any).experimental.generate), config.judgeModel) : null,
      onChange: emit,
    })

    const context = async (sessionID: string): Promise<readonly any[]> => (await ctx.session.context({ sessionID })) as any

    // Only the newest human message can open a turn; replaying history would outlive the bounded ID cache.
    const recordHumans = (sessionID: string, messages: readonly any[]) => {
      const newest = messages.filter((message) => messageOrigin(message) === "human").at(-1)
      if (newest) auditor.userMessage(sessionID, { id: newest.id, origin: "human" })
    }

    // Events carry no location and reach every instance, so ownership comes from the session itself.
    const owned = async (sessionID: string) => {
      if (temp.has(sessionID)) return false
      try {
        const session: any = await ctx.session.get({ sessionID })
        return session.location?.directory === ctx.location.directory && !session.parentID && !session.metadata?.fidelis
      } catch {
        return false
      }
    }

    // A child that never answers must cost evidence, not stall every later audit of this session.
    const childContext = async (id: string): Promise<readonly any[]> => {
      const empty: readonly any[] = []
      const timeout = new Promise<readonly any[]>((done) => setTimeout(() => done(empty), CHILD_TIMEOUT_MS))
      return Promise.race([context(id).catch(() => empty), timeout])
    }

    const retainAll = async (sessionID: string, messages: readonly any[]) => {
      const children = await Promise.all(childSessions(messages).map(async (id) => toEvents(await childContext(id), "subagent").filter((event) => event.kind === "tool").map((event) => ({ ...event, id: `${id}:${event.id}` }))))
      return auditor.retain(sessionID, [...toEvents(messages), ...children.flat()])
    }

    const onCompleted = async (sessionID: string) => {
      if (!(await owned(sessionID))) return
      let messages = await context(sessionID)
      let boundary = finalBoundary(messages)
      // The idle record can land just after the completion signal: one bounded re-read, never a silent skip.
      if (!boundary) {
        await new Promise((done) => setTimeout(done, BOUNDARY_RETRY_MS))
        messages = await context(sessionID)
        boundary = finalBoundary(messages)
      }
      if (!boundary) return
      recordHumans(sessionID, messages)
      const covered = store.readLedger(sessionID).length > 0
      const turn = store.read(sessionID).turn
      const retained = await retainAll(sessionID, messages)
      // A human message arrived while gathering evidence: this snapshot belongs to a finished turn.
      if (store.read(sessionID).turn !== turn) return
      const evidence = buildEvidence(messages, boundary, retained, covered)
      const known = nestedFor(sessionID)
      const sources = ambient.has(sessionID) ? effectiveSources(ambient.get(sessionID), messages, known) : null
      if (known.size) store.writeNested(sessionID, Object.fromEntries(known))
      const outcome = await auditor.complete(sessionID, { sources, evidence, boundaryKey: boundary.key })
      if (outcome.action === "correct") {
        try {
          await ctx.session.prompt({ sessionID, text: outcome.text, delivery: "queue", metadata: { fidelis: { origin: "fidelis", auditID: outcome.auditID } } } as any)
        } catch (error) {
          auditor.deliveryFailed(sessionID, String((error as Error)?.message ?? error))
        }
      }
    }

    const enqueue = (sessionID: string, run: () => Promise<void>) => {
      const next = (queue.get(sessionID) ?? Promise.resolve()).then(run).catch((error) => console.error(`${FIDELIS_MARKER} ${String(error?.message ?? error)}`))
      queue.set(sessionID, next)
    }

    const hooks = [
      await ctx.session.hook("context", (event: any) => {
        const listed = event.system.flatMap((part: any) => part.metadata?.experimental?.instructions ?? [])
        if (listed.length) ambient.set(event.sessionID, listed.find((item: any) => item.key === "core/instructions")?.text ?? "")
      }),
      await ctx.session.hook("compaction", async (event: any) => {
        if (!(await owned(event.sessionID))) return
        const messages = await context(event.sessionID)
        recordHumans(event.sessionID, messages)
        await retainAll(event.sessionID, messages)
        // Nested instructions live in messages this compaction is about to remove.
        const known = nestedFor(event.sessionID)
        effectiveSources(undefined, messages, known)
        if (known.size) store.writeNested(event.sessionID, Object.fromEntries(known))
      }),
      // Completion is not the only way a turn ends: an idle session is the same boundary, and complete() already
      // ignores a duplicate boundary. Background work still running means the hook will run again when it finishes.
      await ctx.session.hook("experimental.idle", (event: any) => {
        const sessionID = event?.sessionID
        if (!sessionID || temp.has(sessionID) || (event.background ?? []).length) return
        enqueue(sessionID, () => onCompleted(sessionID))
      }),
    ]

    const abort = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal, types: ["session.inbox.delivered", "session.execution.succeeded", "session.execution.failed", "session.execution.interrupted", "session.deleted"] }) as AsyncIterable<any>) {
        const sessionID = event.data?.sessionID
        if (!sessionID || temp.has(sessionID)) continue
        if (event.type === "session.execution.succeeded") enqueue(sessionID, () => onCompleted(sessionID))
        // Delivered, not started: the new message is not in the session context until then. Outside the
        // queue, so a new human turn invalidates a running audit before it can send a stale correction.
        else if (event.type === "session.inbox.delivered")
          void owned(sessionID)
            .then(async (mine) => {
              if (mine) recordHumans(sessionID, await context(sessionID))
            })
            .catch((error) => console.error(`${FIDELIS_MARKER} ${String(error?.message ?? error)}`))
        else if (event.type === "session.deleted") for (const map of [ambient, nested]) map.delete(sessionID)
        else
          enqueue(sessionID, async () => {
            if (await owned(sessionID)) auditor.executionEnded(sessionID)
          })
      }
    })().catch((error) => {
      if (!abort.signal.aborted) console.error(`${FIDELIS_MARKER} event stream ended: ${String(error?.message ?? error)}`)
    })

    return async () => {
      abort.abort()
      await Promise.all(hooks.map((hook) => hook.dispose()))
      await rpc.dispose?.()
    }
  },
})
