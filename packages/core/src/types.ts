export type Host = "opencode" | "claude-code"

export interface InstructionSource {
  path: string
  scope: string
  /** Host load order. Later wins when the host defines precedence. */
  priority: number
  text: string
}

export const OBLIGATIONS = ["MUST", "MUST_NOT", "CONDITIONAL", "TEMPORAL", "STOP_CONDITION", "OTHER"] as const
export type Obligation = (typeof OBLIGATIONS)[number]

export interface Rule {
  id: string
  quote: string
  source: string
  obligation: Obligation
  applicability: string
  trigger: string
  deadline: string
  exceptions: string[]
  expectedEvidence: string
  counterEvidence: string
  repairHint: string
  priority: number
  supersedable: boolean
  supersededBy: string | null
  conflictsWith: string[]
}

export interface Checklist {
  schema: number
  fingerprint: string
  model: string
  compiledAt: number
  rules: Rule[]
  /** Model output rejected by validation, kept for traceability. */
  dropped: string[]
}

export type EventKind = "user" | "assistant" | "tool" | "fidelis" | "system"
export type EventStatus = "completed" | "failed" | "running" | "cancelled" | "unknown"

export interface ExecEvent {
  id: string
  seq: number
  at?: number
  kind: EventKind
  actor?: "agent" | "subagent"
  name?: string
  input?: unknown
  output?: string
  text?: string
  status?: EventStatus
}

export interface Evidence {
  userRequest: string
  /** The turn under audit: from the opening prompt through every corrective turn. */
  events: ExecEvent[]
  /** Earlier turns. Context for temporal rules, never a source of new accusations. */
  history?: ExecEvent[]
  finalReply: string
  /** True only when the source is known to hold every event of the window. */
  complete: boolean
  gaps: string[]
}

export type RuleStatus = "NOT_APPLICABLE" | "PENDING" | "SATISFIED" | "VIOLATED" | "UNKNOWN"
export type Repair = "safe" | "user" | "unrepairable"

export interface Finding {
  ruleID: string
  status: RuleStatus
  quote: string
  source: string
  obligation: Obligation
  explanation: string
  evidence: string[]
  severity: "high" | "low"
  probability?: number
  confidenceKind?: "decision" | "self-reported"
  uncertainty?: string
  repair?: Repair
  repairHint?: string
  /** The breach stays on record; later events show it was repaired or honestly acknowledged. */
  resolved?: boolean
}

export type StateName =
  | "READY"
  | "RUNNING"
  | "AUDITING"
  | "CORRECTING"
  | "WAITING_USER"
  | "APPROVED"
  | "AUDIT_INCOMPLETE"
  | "STOPPED"

export type Phase = "compiling" | "judging" | null

export interface SessionState {
  host: Host
  sessionID: string
  state: StateName
  phase: Phase
  reason?: string
  revision: number
  updatedAt: number
  turn: number
  corrections: number
  humanIDs: string[]
  boundaries: string[]
  audit?: { id: string; boundaryID: string; turn: number; startedAt: number }
  lastAuditID?: string
  /** Rule IDs already reported as unrepairable: disclose once, never retry. */
  disclosed: string[]
  violationKey?: string
  findings: Finding[]
  spentUSD: number
}

export interface AuditMetrics {
  cacheHit: boolean
  compilerCalls: number
  judgeCalls: number
  tokens: number
  costUSD: number
  latencyMs: number
  uncertain: number
}

export interface AuditRecord {
  auditID: string
  boundaryID: string
  turn: number
  at: number
  state: StateName
  reason?: string
  findings: Finding[]
  metrics: AuditMetrics
  corrections: number
}

export type Outcome =
  | { action: "none"; state: StateName; duplicate?: boolean; reason?: string; notice?: string }
  | { action: "correct"; state: StateName; auditID: string; text: string }
  | { action: "wait"; state: StateName; auditID: string; reason: string; notice?: string }

export interface Config {
  enabled: boolean
  compilerModel: string
  compilerEffort: string
  judgeModel: string
  judgeEffort: string
  compilerPromptPath: string | null
  judgePromptPath: string | null
  auditOnCompletion: boolean
  maxCorrections: number
  minViolationConfidence: number
  maxAuditTokens: number
  maxAuditCostUSD: number | null
  cacheChecklist: boolean
  storeRawTranscript: boolean
  /** Explicit consent to send rules and evidence to a free model whose data may train it. */
  allowFreeModelDataUse: boolean
  /** Accept SDK-origin prompts as human replies. Off: only verified human records release a wait. */
  trustSdkPrompts: boolean
  timeoutMs: number
  retries: number
  retentionDays: number
  ui: { enabled: boolean; footer: boolean; notifications: "important" | "all" | "off"; auditPanel: boolean; plainTextIcons: boolean }
}
