import { randomUUID } from "node:crypto"
import type { AuditMetrics, AuditRecord, Config, Evidence, ExecEvent, Finding, Host, InstructionSource, Outcome, SessionState, StateName } from "./types.ts"
import { consentProblem } from "./config.ts"
import { getChecklist, resolveSources } from "./compiler.ts"
import { judge, LEDGER_MARK } from "./judge.ts"
import { transition, type MachineEvent } from "./machine.ts"
import type { DecisionModel, GenerateText } from "./providers.ts"
import { redact } from "./redact.ts"
import { canonical, sha256, type Store } from "./store.ts"

export const FIDELIS_MARKER = "[Fidelis audit: automated message, not from the user]"
const AUDIT_STALE_MS = 15 * 60_000
const MAX_TRACKED = 500
const LEDGER_CLIP = 2000
const LEDGER_MAX = 1000

export type MessageOrigin = "human" | "sdk" | "synthetic" | "fidelis" | "agent" | "unknown"

export function correctionReport(auditID: string, findings: Finding[]): string {
  const lines = [FIDELIS_MARKER, `Audit ${auditID}. This is not new user authorization.`, ""]
  findings.forEach((finding, index) => {
    lines.push(`${index + 1}. Rule ${finding.ruleID} (${finding.obligation}) from ${finding.source}: "${finding.quote}"`)
    lines.push(`   Observed: ${finding.explanation}`)
    if (finding.repair === "unrepairable") lines.push("   This cannot be undone. State it plainly in your reply and do any feasible compensating work; do not pretend the order of events changed.")
    else lines.push(`   Allowed repair: ${finding.repairHint || "the smallest change that satisfies the rule"}.`)
  })
  lines.push("", "Fix only what is listed. If a repair needs something the user has not authorized, ask the user and stop instead.")
  return lines.join("\n")
}

export function userNotice(findings: Finding[]): string {
  return findings.map((finding) => `${finding.ruleID}: ${finding.explanation}`).join("\n")
}

export interface CompletionInput {
  /** null means the host did not reveal what it loaded: never read that as "no rules". */
  sources: InstructionSource[] | null
  evidence: Evidence
  /** Host identity of the final turn, e.g. the last assistant message ID. */
  boundaryKey: string
}

export interface AuditorOptions {
  store: Store
  host: Host
  config: Config
  options?: Record<string, unknown>
  compiler: GenerateText | null
  judge: DecisionModel | null
  onChange?: (state: SessionState, transition: string) => void
}

export class Auditor {
  private readonly o: AuditorOptions

  constructor(options: AuditorOptions) {
    this.o = options
  }

  private save(sessionID: string, change: (state: SessionState) => void, label = "update") {
    const state = this.o.store.update(sessionID, change)
    this.o.onChange?.(state, label)
    return state
  }

  /** Only a verified human message opens a turn or releases a wait. A known ID never counts twice. */
  userMessage(sessionID: string, message: { id: string; origin: MessageOrigin }): boolean {
    const trusted = message.origin === "human" || (message.origin === "sdk" && this.o.config.trustSdkPrompts)
    const current = this.o.store.read(sessionID)
    // An SDK prompt may open a turn but can never release a wait or a stop.
    const opensTurn = message.origin === "sdk" && current.state !== "WAITING_USER" && current.state !== "STOPPED"
    if ((!trusted && !opensTurn) || current.humanIDs.includes(message.id)) return false
    this.save(
      sessionID,
      (state) => {
        if (state.humanIDs.includes(message.id)) return
        state.humanIDs = [...state.humanIDs, message.id].slice(-MAX_TRACKED)
        state.state = transition(state.state, "human")
        state.turn += 1
        state.corrections = 0
        state.disclosed = []
        state.findings = []
        state.violationKey = undefined
        state.audit = undefined
        state.reason = undefined
        state.phase = null
      },
      "human",
    )
    return true
  }

  /** A turn that failed or was interrupted has no completed boundary to audit: nothing is running any more. */
  executionEnded(sessionID: string) {
    if (this.o.store.read(sessionID).state !== "RUNNING") return
    this.save(sessionID, (state) => {
      if (state.state === "RUNNING") state.state = "READY"
    }, "ended")
  }

  /** The agent never received the correction, so nothing is being corrected. */
  deliveryFailed(sessionID: string, reason: string) {
    this.save(
      sessionID,
      (state) => {
        if (state.state !== "CORRECTING") return
        state.state = "AUDIT_INCOMPLETE"
        state.reason = `The correction could not be delivered: ${reason}`
      },
      "incomplete",
    )
  }

  /** Merge host events with the ledger so compaction cannot erase evidence the audit still needs. */
  retain(sessionID: string, events: ExecEvent[]): ExecEvent[] {
    const store = this.o.store
    const raw = this.o.config.storeRawTranscript
    const merged = new Map(store.readLedger(sessionID).map((event) => [event.id, event]))
    for (const event of events) merged.set(event.id, event)
    const ordered = [...merged.values()].sort((a, b) => (a.at ?? 0) - (b.at ?? 0) || a.seq - b.seq).map((event, seq) => ({ ...event, seq }))
    const clipField = (value?: string) => {
      if (value === undefined) return undefined
      const clean = redact(value)
      return raw || clean.length <= LEDGER_CLIP ? clean : clean.slice(0, LEDGER_CLIP) + LEDGER_MARK
    }
    store.writeLedger(
      sessionID,
      ordered.slice(-LEDGER_MAX).map((event) => ({ ...event, text: clipField(event.text), output: clipField(event.output), input: clipField(typeof event.input === "string" || event.input === undefined ? (event.input as string | undefined) : JSON.stringify(event.input)) })),
    )
    return ordered
  }

  async complete(sessionID: string, input: CompletionInput): Promise<Outcome> {
    const { store, config } = this.o
    if (!config.enabled || !config.auditOnCompletion) return { action: "none", state: store.read(sessionID).state, reason: "auditing disabled" }
    const started = Date.now()
    // Hash what identifies the turn, not timestamps or transcript flush order, so a replayed callback matches.
    const acted = input.evidence.events.filter((event) => event.kind === "tool" || event.kind === "fidelis").map((event) => [event.id, event.status ?? ""])
    const boundaryID = sha256(canonical({ key: input.boundaryKey, acted, reply: input.evidence.finalReply }))
    const auditID = randomUUID()
    let skip: Outcome | undefined
    const begin = this.save(
      sessionID,
      (state) => {
        const inFlight = state.audit && state.audit.boundaryID === boundaryID && started - state.audit.startedAt < AUDIT_STALE_MS
        if (state.boundaries.includes(boundaryID) || inFlight) {
          skip = { action: "none", state: state.state, duplicate: true }
          return
        }
        const next = transition(state.state, "complete")
        if (next !== "AUDITING") {
          // Locked: no audit and no push until a verified human turn.
          state.boundaries = [...state.boundaries, boundaryID].slice(-MAX_TRACKED)
          skip = { action: "none", state: next, reason: state.reason }
          return
        }
        state.state = next
        state.phase = "judging"
        state.audit = { id: auditID, boundaryID, turn: state.turn, startedAt: started }
      },
      "auditing",
    )
    if (skip) return skip

    const metrics: AuditMetrics = { cacheHit: false, compilerCalls: 0, judgeCalls: 0, tokens: 0, costUSD: 0, latencyMs: 0, uncertain: 0 }
    const finish = (event: MachineEvent, reason: string | undefined, findings: Finding[], extra: Partial<SessionState> = {}): StateName | null => {
      metrics.latencyMs = Date.now() - started
      metrics.uncertain = findings.filter((finding) => finding.status === "UNKNOWN").length
      let current = false
      const final = this.save(
        sessionID,
        (state) => {
          current = state.audit?.id === auditID
          if (!current) return
          Object.assign(state, extra)
          state.state = transition("AUDITING", event)
          state.phase = null
          state.audit = undefined
          state.reason = reason
          state.findings = findings
          state.lastAuditID = auditID
          state.boundaries = [...state.boundaries, boundaryID].slice(-MAX_TRACKED)
          state.spentUSD += metrics.costUSD
        },
        event,
      )
      if (!current) return null
      const record: AuditRecord = { auditID, boundaryID, turn: begin.turn, at: Date.now(), state: final.state, reason, findings, metrics, corrections: final.corrections }
      store.appendAudit(sessionID, record)
      return final.state
    }
    const stale = (): Outcome => ({ action: "none", state: store.read(sessionID).state, reason: "audit superseded by a newer turn" })
    const incomplete = (reason: string, findings: Finding[] = []): Outcome => {
      const state = finish("incomplete", reason, findings)
      return state ? { action: "none", state, reason, notice: `Fidelis audit incomplete: ${reason}` } : stale()
    }

    if (config.maxAuditCostUSD !== null && begin.spentUSD >= config.maxAuditCostUSD) {
      const reason = `Audit budget of $${config.maxAuditCostUSD} is exhausted.`
      const state = finish("stop", reason, [])
      return state ? { action: "none", state, reason, notice: `Fidelis stopped: ${reason}` } : stale()
    }

    if (!input.sources) return incomplete("The host did not reveal which instructions it loaded.")
    const sources = resolveSources(input.sources)
    if (sources.length === 0) {
      const reason = "No effective instructions to audit."
      const state = finish("clean", reason, [])
      return state ? { action: "none", state, reason } : stale()
    }
    const options = this.o.options ?? {}
    const compileConsent = consentProblem(config.compilerModel, options, config)
    const compiled = await getChecklist({
      store,
      host: this.o.host,
      sources,
      config,
      generate: compileConsent ? null : this.o.compiler,
      onCompile: () => this.save(sessionID, (state) => void (state.phase = "compiling"), "compiling"),
    })
    metrics.cacheHit = compiled.cacheHit
    metrics.compilerCalls = compiled.calls
    metrics.tokens = compiled.tokens
    metrics.costUSD = compiled.costUSD
    if (!compiled.checklist) return incomplete(compileConsent && !compiled.cacheHit ? compileConsent : (compiled.reason ?? "Checklist unavailable."))
    this.save(sessionID, (state) => void (state.phase = "judging"), "judging")

    const judgeConsent = consentProblem(config.judgeModel, options, config)
    if (judgeConsent) return incomplete(judgeConsent)
    if (!this.o.judge) return incomplete("No decision model is available.")

    let verdict
    try {
      verdict = await judge({
        checklist: compiled.checklist,
        evidence: input.evidence,
        prior: begin.findings.filter((finding) => finding.status === "VIOLATED"),
        model: this.o.judge,
        config,
        overBudget: () => config.maxAuditCostUSD !== null && begin.spentUSD + metrics.costUSD >= config.maxAuditCostUSD,
        onUsage: (tokens, costUSD) => {
          metrics.tokens += tokens
          metrics.costUSD += costUSD
        },
      })
    } catch (error) {
      return incomplete(`Judge failed: ${(error as Error).message}`)
    }
    metrics.judgeCalls = verdict.calls

    return this.route(verdict.findings, verdict.waiting, compiled.checklist.dropped.length, begin, auditID, finish, stale, incomplete)
  }

  /** Deterministic routing. Model output only suggests; these branches decide. */
  private route(
    findings: Finding[],
    waiting: boolean,
    dropped: number,
    begin: SessionState,
    auditID: string,
    finish: (event: MachineEvent, reason: string | undefined, findings: Finding[], extra?: Partial<SessionState>) => StateName | null,
    stale: () => Outcome,
    incomplete: (reason: string, findings: Finding[]) => Outcome,
  ): Outcome {
    const violated = findings.filter((finding) => finding.status === "VIOLATED")
    const open = violated.filter((finding) => !finding.resolved)
    const forUser = open.filter((finding) => finding.repair === "user")
    if (waiting || forUser.length) {
      const reason = forUser.length ? `Repair needs user authorization: ${forUser.map((finding) => finding.ruleID).join(", ")}.` : "The agent is waiting for a user decision."
      const state = finish("wait", reason, findings)
      return state ? { action: "wait", state, auditID, reason, notice: violated.length ? `Fidelis findings:\n${userNotice(violated)}` : undefined } : stale()
    }
    // A rule disclosed as unrepairable is never corrected again, even if the model later calls it repairable.
    const undisclosed = open.filter((finding) => !begin.disclosed.includes(finding.ruleID))
    if (undisclosed.length) {
      if (begin.corrections >= this.o.config.maxCorrections) {
        const reason = `Correction limit of ${this.o.config.maxCorrections} reached with unresolved violations.`
        const state = finish("stop", reason, findings)
        return state ? { action: "none", state, reason, notice: `Fidelis stopped: ${reason}\n${userNotice(undisclosed)}` } : stale()
      }
      const state = finish("correct", undefined, findings, {
        corrections: begin.corrections + 1,
        disclosed: [...begin.disclosed, ...undisclosed.filter((finding) => finding.repair === "unrepairable").map((finding) => finding.ruleID)],
      })
      return state ? { action: "correct", state, auditID, text: correctionReport(auditID, undisclosed) } : stale()
    }
    if (open.length) {
      const reason = "Only already disclosed unrepairable violations remain."
      const state = finish("stop", reason, findings)
      return state ? { action: "none", state, reason, notice: `Fidelis findings:\n${userNotice(open)}` } : stale()
    }
    const unknown = findings.filter((finding) => finding.status === "UNKNOWN")
    if (unknown.length) return incomplete(`${unknown.length} rule(s) could not be assessed.`, findings)
    // A rule the compiler produced but validation rejected was never judged, so this cannot be a clean pass.
    if (dropped) return incomplete(`${dropped} compiled rule(s) failed validation and were not assessed.`, findings)
    const reason = violated.length ? `${violated.length} violation(s) on record, repaired or acknowledged after correction.` : undefined
    const state = finish("clean", reason, findings)
    return state ? { action: "none", state, reason, notice: violated.length ? `Fidelis findings:\n${userNotice(violated)}` : undefined } : stale()
  }

  status(sessionID: string) {
    const state = this.o.store.read(sessionID)
    return {
      sessionID,
      state: state.state,
      phase: state.phase,
      reason: state.reason,
      revision: state.revision,
      updatedAt: state.updatedAt,
      auditID: state.audit?.id ?? state.lastAuditID ?? null,
      corrections: state.corrections,
      actionable: state.findings.filter((finding) => finding.status === "VIOLATED" && !finding.resolved).length,
      audits: this.o.store.audits(sessionID, 20),
    }
  }
}
