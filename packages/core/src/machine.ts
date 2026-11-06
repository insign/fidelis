import type { StateName } from "./types.ts"

export type MachineEvent = "human" | "complete" | "clean" | "wait" | "correct" | "incomplete" | "stop"

const FROM_AUDIT: Partial<Record<MachineEvent, StateName>> = {
  clean: "APPROVED",
  wait: "WAITING_USER",
  correct: "CORRECTING",
  incomplete: "AUDIT_INCOMPLETE",
  stop: "STOPPED",
}

/** Pure transition table. An event with no effect in a state leaves the state unchanged. */
export function transition(state: StateName, event: MachineEvent): StateName {
  if (event === "human") return "RUNNING"
  if (event === "complete") return state === "WAITING_USER" || state === "STOPPED" ? state : "AUDITING"
  return state === "AUDITING" ? (FROM_AUDIT[event] ?? state) : state
}
