import { Plugin } from "@opencode/plugin"
import { FIDELIS_MARKER, REVIEW_PROMPT } from "fidelis"
import { turnToReview } from "./adapter.ts"

/** The idle record can land just after the completion signal: one bounded re-read, never a silent skip. */
const BOUNDARY_RETRY_MS = 250

export default Plugin.define({
  id: "fidelis",
  async setup(ctx) {
    /** Last turn sent for review per session, so two completion signals for one turn send one review. */
    const reviewed = new Map<string, string>()
    const queue = new Map<string, Promise<void>>()
    const context = async (sessionID: string): Promise<readonly any[]> => (await ctx.session.context({ sessionID })) as any

    // Events carry no location and reach every instance, so ownership comes from the session itself. Child sessions
    // belong to a subagent, whose parent turn is reviewed instead.
    const owned = async (sessionID: string) => {
      try {
        const session: any = await ctx.session.get({ sessionID })
        return session.location?.directory === ctx.location.directory && !session.parentID
      } catch {
        return false
      }
    }

    const onFinished = async (sessionID: string) => {
      if (!(await owned(sessionID))) return
      let turn = turnToReview(await context(sessionID))
      if (!turn) {
        await new Promise((done) => setTimeout(done, BOUNDARY_RETRY_MS))
        turn = turnToReview(await context(sessionID))
      }
      if (!turn || reviewed.get(sessionID) === turn) return
      reviewed.set(sessionID, turn)
      await ctx.session.prompt({ sessionID, text: REVIEW_PROMPT, delivery: "queue", metadata: { fidelis: { origin: "fidelis" } } } as any)
    }

    const enqueue = (sessionID: string) => {
      const next = (queue.get(sessionID) ?? Promise.resolve()).then(() => onFinished(sessionID)).catch((error) => console.error(`${FIDELIS_MARKER} ${String(error?.message ?? error)}`))
      queue.set(sessionID, next)
    }

    // Completion is not the only way a turn ends: an idle session is the same boundary. Background work this session
    // owns keeps running and wakes the hook again.
    const idle = await ctx.session.hook("experimental.idle", (event: any) => {
      const sessionID = event?.sessionID
      if (!sessionID || (event.background ?? []).some((item: any) => item?.sessionID === sessionID)) return
      enqueue(sessionID)
    })

    const abort = new AbortController()
    void (async () => {
      for await (const event of ctx.event.subscribe({ signal: abort.signal, types: ["session.execution.succeeded", "session.deleted"] }) as AsyncIterable<any>) {
        const sessionID = event.data?.sessionID
        if (!sessionID) continue
        if (event.type === "session.execution.succeeded") enqueue(sessionID)
        else {
          reviewed.delete(sessionID)
          queue.delete(sessionID)
        }
      }
    })().catch((error) => {
      if (!abort.signal.aborted) console.error(`${FIDELIS_MARKER} event stream ended: ${String(error?.message ?? error)}`)
    })

    return async () => {
      abort.abort()
      await idle.dispose()
    }
  },
})
