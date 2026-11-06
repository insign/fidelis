import { strict as assert } from "node:assert"
import { test } from "node:test"
import { footerKey, footerLabel, panelLines, shouldApply, toastFor } from "../src/view.ts"

const status = (state: string, extra = {}) => ({ sessionID: "s", state, revision: 1, updatedAt: Date.now(), ...extra })

test("footer labels follow the shared state machine", () => {
  assert.equal(footerLabel(undefined), "🛡️ Fidelis")
  assert.equal(footerLabel(status("READY")), "🛡️ Fidelis")
  assert.equal(footerLabel(status("AUDITING", { phase: "compiling" })), "🛡️ Compiling")
  assert.equal(footerLabel(status("RUNNING")), "🛡️ Monitoring")
  assert.equal(footerLabel(status("AUDITING")), "🔍 Auditing")
  assert.equal(footerLabel(status("CORRECTING")), "🔧 Correcting")
  assert.equal(footerLabel(status("APPROVED")), "✅ Approved")
  assert.equal(footerLabel(status("WAITING_USER")), "⏸️ Waiting for user")
  assert.equal(footerLabel(status("WAITING_USER", { actionable: 1 })), "⚠️ Violations")
  assert.equal(footerLabel(status("AUDIT_INCOMPLETE")), "⚠️ Audit incomplete")
  assert.equal(footerLabel(status("STOPPED")), "⛔ Stopped")
})

test("plain text labels carry no emoji", () => {
  for (const state of ["READY", "RUNNING", "AUDITING", "CORRECTING", "APPROVED", "WAITING_USER", "AUDIT_INCOMPLETE", "STOPPED"]) {
    assert.match(footerLabel(status(state), true), /^[\x20-\x7e]+$/)
  }
})

test("incomplete or unknown never reads as approved", () => {
  assert.equal(footerKey(status("AUDIT_INCOMPLETE")), "incomplete")
  assert.notEqual(footerLabel(status("AUDIT_INCOMPLETE")), "✅ Approved")
})

test("a dead audit does not spin forever", () => {
  assert.equal(footerKey(status("AUDITING", { updatedAt: 0 }), Date.now()), "idle")
})

test("toasts: only meaningful transitions, stable dedupe key, no sensitive text", () => {
  for (const transition of ["human", "auditing", "judging", "compiling", "update"]) assert.equal(toastFor({ sessionID: "s", transition }, "important"), null)
  const toast = toastFor({ sessionID: "s", auditID: "a", transition: "correct" }, "important")!
  assert.equal(toast.key, "s:a:correct")
  assert.equal(toastFor({ sessionID: "s", auditID: "a", transition: "correct" }, "off"), null)
  assert.equal(toastFor({ sessionID: "s", transition: "clean" }, "important"), null)
  assert.ok(toastFor({ sessionID: "s", transition: "clean" }, "all"))
  assert.ok(!/AGENTS|\/home|token/i.test(toast.message))
})

test("reordered events cannot roll status back", () => {
  assert.equal(shouldApply(status("APPROVED", { revision: 5 }), status("AUDITING", { revision: 4 })), false)
  assert.equal(shouldApply(undefined, status("AUDITING")), true)
  assert.equal(shouldApply(status("AUDITING", { revision: 4 }), status("APPROVED", { revision: 5 })), true)
})

test("panel handles empty history and shows evidence, not raw transcript", () => {
  assert.equal(panelLines(undefined)[0].text, "No audits for this session yet.")
  const lines = panelLines(status("STOPPED", {
    reason: "limit",
    audits: [{ at: 0, state: "STOPPED", metrics: { cacheHit: true, judgeCalls: 2 }, findings: [
      { status: "VIOLATED", ruleID: "R-1", repair: "safe", quote: "Run review.", explanation: "Judged breached.", evidence: ["e1"] },
      { status: "NOT_APPLICABLE", ruleID: "R-2", quote: "hidden", explanation: "n/a", evidence: [] },
    ] }],
  })).map((line) => line.text).join("\n")
  assert.ok(lines.includes("VIOLATED R-1 [repair: safe]"))
  assert.ok(lines.includes("evidence: e1"))
  assert.ok(lines.includes("checklist cached"))
  assert.ok(!lines.includes("R-2"))
})
