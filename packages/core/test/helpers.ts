import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { Answer, DecisionModel, Question } from "../src/providers.ts"
import type { Checklist, Evidence, ExecEvent, Rule } from "../src/types.ts"
import { Store } from "../src/store.ts"

export const tempDir = () => mkdtempSync(join(tmpdir(), "fidelis-test-"))
export const store = () => new Store("opencode", tempDir())

export function rule(partial: Partial<Rule> = {}): Rule {
  return {
    id: "R-1",
    quote: "Run review before commit.",
    source: "/p/AGENTS.md",
    obligation: "TEMPORAL",
    applicability: "code changes",
    trigger: "",
    deadline: "before commit",
    exceptions: [],
    expectedEvidence: "review before commit",
    counterEvidence: "commit before review",
    repairHint: "run the review now",
    priority: 1,
    supersedable: false,
    supersededBy: null,
    conflictsWith: [],
    ...partial,
  }
}

export const checklist = (rules: Rule[]): Checklist => ({ schema: 1, fingerprint: "f", model: "m", compiledAt: 0, rules, dropped: [] })

export const event = (id: string, seq: number, extra: Partial<ExecEvent> = {}): ExecEvent => ({ id, seq, kind: "tool", name: "shell", status: "completed", ...extra })

export const evidence = (events: ExecEvent[], extra: Partial<Evidence> = {}): Evidence => ({ userRequest: "change it", events, finalReply: "done", complete: true, gaps: [], ...extra })

/** Scripted decision model: answers by question-name suffix. Records every call. */
export function scripted(answers: Record<string, number | string>, overrides: Record<string, Answer> = {}) {
  const calls: Question[][] = []
  const model: DecisionModel = {
    id: "scripted",
    confidenceKind: "decision",
    async ask(_state, questions) {
      calls.push(questions)
      const out: Record<string, Answer> = {}
      for (const question of questions) {
        const suffix = question.name.replace(/^r\d+_/, "")
        if (overrides[question.name]) out[question.name] = overrides[question.name]
        else if (question.type === "choice") out[question.name] = { choice: String(answers[suffix] ?? question.choices[0]?.value), p: 0.9 }
        else if (typeof answers[suffix] === "number") out[question.name] = { p: answers[suffix] as number }
      }
      return { answers: out, tokens: 10, costUSD: 0.001 }
    },
  }
  return { model, calls }
}

export const CLEAN = { turn_waiting: 0.01, applies: 0.99, deadline: 0.99, violated: 0.02, satisfied: 0.97, absence: 0.1, repairable: 0.9, user: 0.05 }
export const BREACH = { ...CLEAN, violated: 0.98, satisfied: 0.02, repaired: 0.1 }
