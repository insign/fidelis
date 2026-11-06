/** Presentation only. Nothing here can change an audit or a routing decision. */
export interface Status {
  sessionID: string
  state: string
  phase?: string | null
  reason?: string
  revision: number
  updatedAt: number
  auditID?: string | null
  corrections?: number
  actionable?: number
  audits?: any[]
}

export interface UiOptions {
  enabled: boolean
  footer: boolean
  notifications: "important" | "all" | "off"
  auditPanel: boolean
  plainTextIcons: boolean
}

export const UI_DEFAULTS: UiOptions = { enabled: true, footer: true, notifications: "important", auditPanel: true, plainTextIcons: false }

const LABELS: Record<string, [string, string]> = {
  idle: ["🛡️ idle", "[F] idle"],
  compiling: ["🛡️ compile", "[F] compile"],
  monitoring: ["🛡️ check", "[F] check"],
  auditing: ["🔍 audit", "[F] audit"],
  correcting: ["🔧 fix", "[F] fix"],
  approved: ["✅ OK", "[F] OK"],
  violations: ["⚠️ issues", "[!] issues"],
  waiting: ["⏸️ USER", "[F] USER"],
  incomplete: ["⚠️ unknown", "[!] unknown"],
  stopped: ["⛔ stop", "[X] stop"],
}

const STALE_AUDIT_MS = 15 * 60_000

export function footerKey(status: Status | undefined, now = Date.now()): keyof typeof LABELS {
  if (!status) return "idle"
  if (status.phase === "compiling") return "compiling"
  switch (status.state) {
    case "RUNNING":
      return "monitoring"
    case "AUDITING":
      // No endless spinner for an audit that died with its process: a stale audit reads as unknown, never idle.
      return now - status.updatedAt > STALE_AUDIT_MS ? "incomplete" : "auditing"
    case "CORRECTING":
      return "correcting"
    case "APPROVED":
      return "approved"
    case "WAITING_USER":
      return (status.actionable ?? 0) > 0 ? "violations" : "waiting"
    case "AUDIT_INCOMPLETE":
      return "incomplete"
    case "STOPPED":
      return "stopped"
    default:
      return "idle"
  }
}

export function footerLabel(status: Status | undefined, plain = false, now = Date.now()): string {
  return LABELS[footerKey(status, now)][plain ? 1 : 0]
}

export interface ChangedEvent {
  sessionID: string
  auditID?: string | null
  transition: string
  actionable?: number
}

const TOASTS: Record<string, { title: string; message: string; variant: "warning" | "error" | "info" | "success"; level: "important" | "all" }> = {
  correct: { title: "Fidelis", message: "Violations found. Asking the agent to correct them. Open /fidelis for details.", variant: "warning", level: "important" },
  wait: { title: "Fidelis", message: "Waiting for you. Open /fidelis for details.", variant: "info", level: "important" },
  incomplete: { title: "Fidelis", message: "Audit incomplete. Open /fidelis for the reason.", variant: "error", level: "important" },
  stop: { title: "Fidelis", message: "Auditing stopped. Open /fidelis for the report.", variant: "error", level: "important" },
  clean: { title: "Fidelis", message: "Turn approved.", variant: "success", level: "all" },
}

/** One toast per session, audit and transition. Fixed text: no paths, prompts, rules or keys. */
export function toastFor(event: ChangedEvent, notifications: UiOptions["notifications"]) {
  const toast = TOASTS[event.transition]
  if (!toast || notifications === "off" || (toast.level === "all" && notifications !== "all")) return null
  return { key: `${event.sessionID}:${event.auditID ?? ""}:${event.transition}`, title: toast.title, message: toast.message, variant: toast.variant }
}

export function shouldApply(current: Status | undefined, next: Status): boolean {
  return (current?.revision ?? -1) <= next.revision
}

export interface PanelLine {
  text: string
  tone: "base" | "muted" | "warning"
}

const SHOWN = new Set(["VIOLATED", "UNKNOWN", "PENDING", "SATISFIED"])

/** Latest audit first. Read-only; viewing it approves nothing. */
export function panelLines(status: Status | undefined): PanelLine[] {
  if (!status || status.revision === 0) return [{ text: "No audits for this session yet.", tone: "muted" }]
  const lines: PanelLine[] = [{ text: `State: ${status.state}${status.phase ? ` (${status.phase})` : ""}`, tone: "base" }]
  if (status.reason) lines.push({ text: `Reason: ${status.reason}`, tone: "warning" })
  lines.push({ text: `Corrections this turn: ${status.corrections ?? 0}`, tone: "muted" })
  const audits = [...(status.audits ?? [])].reverse()
  if (audits.length === 0) lines.push({ text: "No completed audits yet.", tone: "muted" })
  for (const audit of audits) {
    const metrics = audit.metrics ?? {}
    lines.push({ text: "", tone: "muted" })
    lines.push({ text: `${new Date(audit.at).toISOString()} ${audit.state} (checklist ${metrics.cacheHit ? "cached" : "compiled"}, ${metrics.judgeCalls ?? 0} judge calls)`, tone: "base" })
    if (audit.reason) lines.push({ text: `  ${audit.reason}`, tone: "warning" })
    for (const finding of audit.findings ?? []) {
      if (!SHOWN.has(finding.status)) continue
      lines.push({ text: `  ${finding.status} ${finding.ruleID}${finding.resolved ? " [repaired or acknowledged]" : finding.repair ? ` [repair: ${finding.repair}]` : ""}`, tone: finding.status === "VIOLATED" ? "warning" : "base" })
      lines.push({ text: `    "${finding.quote}"`, tone: "muted" })
      lines.push({ text: `    ${finding.explanation}${finding.evidence?.length ? ` (evidence: ${finding.evidence.join(", ")})` : ""}`, tone: "muted" })
    }
  }
  return lines
}
