import { strict as assert } from "node:assert"
import { readFileSync, statSync } from "node:fs"
import { join } from "node:path"
import { test } from "node:test"
import { Auditor, FIDELIS_MARKER } from "../src/auditor.ts"
import { checklistFingerprint, getChecklist, resolveSources, validateRules } from "../src/compiler.ts"
import { consentProblem, resolveConfig } from "../src/config.ts"
import { digest, EvidenceTooLarge, judge, LEDGER_MARK } from "../src/judge.ts"
import { transition } from "../src/machine.ts"
import { COMPILER_PROMPT } from "../src/prompts.ts"
import { jevNative, opencodeDecisions, parseJson, textDecisions, withRetry } from "../src/providers.ts"
import { redact } from "../src/redact.ts"
import { canonical, safeID, Store } from "../src/store.ts"
import type { InstructionSource } from "../src/types.ts"
import { BREACH, checklist, CLEAN, event, evidence, rule, scripted, store, tempDir } from "./helpers.ts"

const config = (extra = {}) => resolveConfig("opencode", { allowFreeModelDataUse: true, retries: 0, ...extra })
const SOURCE: InstructionSource = { path: "/p/AGENTS.md", scope: "project", priority: 1, text: "Run review before commit.\nNever push." }
const RAW_RULE = { id: "a", quote: "Run review before commit.", source: "/p/AGENTS.md", obligation: "TEMPORAL", applicability: "code", deadline: "commit", expectedEvidence: "x", counterEvidence: "y" }
const compilerOutput = JSON.stringify({ confidence: 0.9, rules: [RAW_RULE] })

function auditor(s: Store, model: any, extra: any = {}, compiler: any = async () => compilerOutput) {
  const changes: string[] = []
  return { changes, a: new Auditor({ store: s, host: "opencode", config: config(extra), compiler, judge: model, onChange: (_state, label) => changes.push(label) }) }
}
const completion = (events = [event("e1", 0, { input: { command: "git commit" } })], extra = {}) => ({ sources: [SOURCE], evidence: evidence(events, extra), boundaryKey: "m1" })

test("canonical encoding is unambiguous", () => {
  assert.notEqual(canonical(["ab", "c"]), canonical(["a", "bc"]))
  assert.equal(canonical({ b: 1, a: 2 }), canonical({ a: 2, b: 1 }))
})

test("session paths are sanitized", () => {
  assert.equal(safeID("../x/y"), "%2e%2e%2Fx%2Fy")
  assert.ok(!safeID("..").includes("."))
})

test("state files are private and atomic", { skip: process.platform === "win32" }, () => {
  const s = store()
  s.update("a/b", (state) => void (state.turn = 1))
  assert.equal(s.read("a/b").turn, 1)
  const file = join(s.dir, "sessions", "opencode", safeID("a/b"), "state.json")
  assert.equal(statSync(file).mode & 0o077, 0)
})

test("state machine table", () => {
  assert.equal(transition("READY", "human"), "RUNNING")
  assert.equal(transition("RUNNING", "complete"), "AUDITING")
  assert.equal(transition("CORRECTING", "complete"), "AUDITING")
  assert.equal(transition("WAITING_USER", "complete"), "WAITING_USER")
  assert.equal(transition("STOPPED", "complete"), "STOPPED")
  assert.equal(transition("AUDITING", "clean"), "APPROVED")
  assert.equal(transition("AUDITING", "wait"), "WAITING_USER")
  assert.equal(transition("AUDITING", "correct"), "CORRECTING")
  assert.equal(transition("AUDITING", "incomplete"), "AUDIT_INCOMPLETE")
  assert.equal(transition("AUDITING", "stop"), "STOPPED")
  assert.equal(transition("WAITING_USER", "human"), "RUNNING")
})

test("redaction removes common secrets", () => {
  const out = redact('token: abcd1234efgh Authorization: Bearer xyz sk-abcdefghijklmnopqrstuv password="hunter22"')
  for (const secret of ["abcd1234efgh", "xyz", "sk-abcdefghijklmnopqrstuv", "hunter22"]) assert.ok(!out.includes(secret), out)
})

test("sources dedupe and keep host order", () => {
  const out = resolveSources([{ path: "b", scope: "p", priority: 2, text: "B" }, { path: "a", scope: "u", priority: 1, text: "A" }, { path: "a", scope: "u", priority: 3, text: "A" }])
  assert.deepEqual(out.map((source) => source.path), ["a", "b"])
})

test("compiled once across sessions; each input change is a targeted miss", async () => {
  const s = store()
  let calls = 0
  const generate = async () => (calls++, compilerOutput)
  const get = (sources = [SOURCE], extra = {}) => getChecklist({ store: s, host: "opencode", sources, config: config(extra), generate })
  assert.equal((await get()).cacheHit, false)
  assert.equal((await get()).cacheHit, true)
  assert.equal(calls, 1)
  await get([{ ...SOURCE, text: `${SOURCE.text} Also.` }])
  assert.equal(calls, 2)
  await get([SOURCE], { compilerModel: "other/model" })
  assert.equal(calls, 3)
  const dir = tempDir()
  const promptPath = join(dir, "p.md")
  const { writeFileSync } = await import("node:fs")
  writeFileSync(promptPath, "custom prompt")
  await get([SOURCE], { compilerPromptPath: promptPath })
  assert.equal(calls, 4)
  const base = config()
  assert.notEqual(checklistFingerprint("opencode", [SOURCE], base, "x"), checklistFingerprint("claude-code", [SOURCE], base, "x"))
})

test("compiler rejects invented quotes and low confidence, never caches failure", async () => {
  const { rules, dropped } = validateRules({ rules: [RAW_RULE, { ...RAW_RULE, quote: "Invented rule." }, { ...RAW_RULE, obligation: "NOPE" }, { ...RAW_RULE }] }, [SOURCE])
  assert.equal(rules.length, 1)
  assert.equal(dropped.length, 2)
  const shortened = validateRules({ rules: [{ ...RAW_RULE, source: "AGENTS.md" }] }, [SOURCE])
  assert.equal(shortened.rules[0].source, SOURCE.path)
  const s = store()
  const low = await getChecklist({ store: s, host: "opencode", sources: [SOURCE], config: config(), generate: async () => JSON.stringify({ confidence: 0.1, rules: [RAW_RULE] }) })
  assert.ok(low.reason?.includes("too low"))
  const empty = await getChecklist({ store: s, host: "opencode", sources: [SOURCE], config: config(), generate: async () => JSON.stringify({ confidence: 1, rules: [] }) })
  assert.ok(empty.reason?.includes("no valid rules"))
  assert.equal(readChecklistCount(s), 0)
})

const readChecklistCount = (s: Store) => {
  const { readdirSync } = process.getBuiltinModule("node:fs")
  return readdirSync(join(s.dir, "checklists")).length
}

test("conflicts stay UNKNOWN on both sides, no fabricated violation", async () => {
  const { rules } = validateRules({ rules: [{ ...RAW_RULE, conflictsWith: ["b"] }, { ...RAW_RULE, id: "b", quote: "Never push." }] }, [SOURCE])
  assert.equal(rules.every((item) => item.conflictsWith.length === 1), true)
  const { model } = scripted(BREACH)
  const result = await judge({ checklist: checklist(rules), evidence: evidence([event("e1", 0)]), prior: [], model, config: config() })
  assert.deepEqual(result.findings.map((finding) => finding.status), ["UNKNOWN", "UNKNOWN"])
})

test("obligation still satisfiable is PENDING", async () => {
  const { model, calls } = scripted({ ...BREACH, deadline: 0.1 })
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e1", 0)]), prior: [], model, config: config() })
  assert.equal(result.findings[0].status, "PENDING")
  assert.equal(calls.flat().some((question) => question.name.endsWith("violated")), false)
})

test("temporal breach cites evidence even with a later review", async () => {
  const events = [event("commit", 0, { input: "git commit" }), event("review", 1, { input: "review" })]
  const { model } = scripted({ ...BREACH, cite: "commit" })
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence(events), prior: [], model, config: config() })
  assert.equal(result.findings[0].status, "VIOLATED")
  assert.deepEqual(result.findings[0].evidence, ["commit"])
})

test("terse final reply passes on tool evidence", async () => {
  const { model } = scripted({ ...CLEAN, cite: "review" })
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([event("review", 0)], { finalReply: "ok" }), prior: [], model, config: config() })
  assert.equal(result.findings[0].status, "SATISFIED")
})

test("missing records stay UNKNOWN, never guilty", async () => {
  const { model } = scripted({ ...BREACH, absence: 0.9 })
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e", 0)], { complete: false, gaps: ["no transcript"] }), prior: [], model, config: config() })
  assert.equal(result.findings[0].status, "UNKNOWN")
})

test("a breach with a fabricated citation is UNKNOWN", async () => {
  const { model } = scripted(BREACH, { r0_cite: { choice: "not-an-event" } })
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e", 0)]), prior: [], model, config: config() })
  assert.equal(result.findings[0].status, "UNKNOWN")
})

test("low-confidence breach is not acted on", async () => {
  const { model } = scripted({ ...BREACH, violated: 0.7 })
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e", 0)]), prior: [], model, config: config() })
  assert.equal(result.findings[0].status, "UNKNOWN")
})

test("ambiguous verdict over clipped evidence gets one recheck with raw spans", async () => {
  const big = "x".repeat(12_000)
  const states: string[] = []
  const inner = scripted({ ...BREACH, violated: 0.7, span: "e", cite: "e" })
  const model = { ...inner.model, ask(state: string, questions: any) {
    states.push(state)
    const recheck = questions.length === 1 && questions[0].name.endsWith("violated") && state.includes(big)
    return recheck ? Promise.resolve({ answers: { [questions[0].name]: { p: 0.99 } } }) : inner.model.ask(state, questions)
  } }
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e", 0, { output: big })]), prior: [], model, config: config({ maxAuditTokens: 2000 }) })
  assert.equal(result.findings[0].status, "VIOLATED")
  assert.ok(states.some((state) => state.includes(big)))
})

test("digest clips loudly and refuses silent loss", () => {
  const events = Array.from({ length: 50 }, (_, index) => event(`e${index}`, index, { output: "y".repeat(5000) }))
  const small = digest(evidence(events), [], 200_000)
  assert.ok(small.text.includes("[clipped"))
  assert.ok(small.text.includes("id=e49"))
  assert.throws(() => digest(evidence(events), [], 500), EvidenceTooLarge)
})

test("clean turn is APPROVED once; repeated callback does not re-audit", async () => {
  const s = store()
  const { model, calls } = scripted({ ...CLEAN, cite: "e1" })
  const { a } = auditor(s, model)
  a.userMessage("s", { id: "u1", origin: "human" })
  assert.equal((await a.complete("s", completion())).state, "APPROVED")
  const count = calls.length
  const again = await a.complete("s", completion())
  assert.equal(again.action, "none")
  assert.equal((again as any).duplicate, true)
  assert.equal(calls.length, count)
  assert.equal(s.audits("s").length, 1)
})

test("a replay with flushed text or new timestamps is the same boundary", async () => {
  const s = store()
  const { model, calls } = scripted({ ...CLEAN, cite: "e1" })
  const { a } = auditor(s, model)
  const tool = event("e1", 0, { at: 1 })
  await a.complete("s", completion([tool]))
  const count = calls.length
  const replay = await a.complete("s", completion([{ ...tool, at: 2 }, event("flushed", 1, { kind: "assistant", text: "done", at: 3 })]))
  assert.equal((replay as any).duplicate, true)
  assert.equal(calls.length, count)
})

test("an SDK prompt opens a turn but cannot release a wait or a stop", () => {
  const s = store()
  const { a } = auditor(s, scripted(CLEAN).model)
  assert.equal(a.userMessage("s", { id: "sdk1", origin: "sdk" }), true)
  s.update("s", (state) => void (state.state = "WAITING_USER"))
  assert.equal(a.userMessage("s", { id: "sdk2", origin: "sdk" }), false)
  s.update("s", (state) => void (state.state = "STOPPED"))
  assert.equal(a.userMessage("s", { id: "sdk3", origin: "sdk" }), false)
  assert.equal(a.userMessage("s", { id: "h", origin: "human" }), true)
})

test("restart does not replay a correction", async () => {
  const s = store()
  const { model } = scripted({ ...BREACH, cite: "e1" })
  const first = await auditor(s, model).a.complete("s", completion())
  assert.equal(first.action, "correct")
  const second = await auditor(s, model).a.complete("s", completion())
  assert.equal(second.action, "none")
})

test("correctable violation gets one request, then re-audit approves", async () => {
  const s = store()
  const bad = scripted({ ...BREACH, cite: "e1" })
  const first = await auditor(s, bad.model).a.complete("s", completion())
  assert.equal(first.action, "correct")
  assert.equal(first.state, "CORRECTING")
  assert.ok((first as any).text.startsWith(FIDELIS_MARKER))
  assert.ok((first as any).text.includes("Run review before commit."))
  const good = scripted({ ...CLEAN, cite: "e2" })
  const second = await auditor(s, good.model).a.complete("s", completion([event("e1", 0), event("e2", 1)]))
  assert.equal(second.state, "APPROVED")
  assert.equal(s.read("s").corrections, 1)
})

test("unrepairable violation is disclosed once, without a fix loop", async () => {
  const s = store()
  const { model } = scripted({ ...BREACH, repairable: 0.05, repaired: 0.1, cite: "e1" })
  const { a } = auditor(s, model)
  const first = await a.complete("s", completion())
  assert.equal(first.action, "correct")
  assert.ok((first as any).text.includes("cannot be undone"))
  const second = await a.complete("s", completion([event("e1", 0), event("e2", 1)]))
  assert.equal(second.action, "none")
  assert.equal(second.state, "STOPPED")
})

test("a disclosed rule is not corrected again when the model flips to repairable", async () => {
  const s = store()
  await auditor(s, scripted({ ...BREACH, repairable: 0.05, cite: "e1" }).model).a.complete("s", completion())
  const flipped = await auditor(s, scripted({ ...BREACH, repairable: 0.9, repaired: 0.1, cite: "e1" }).model).a.complete("s", completion([event("e1", 0), event("e2", 1)]))
  assert.equal(flipped.action, "none")
  assert.equal(s.read("s").corrections, 1)
})

test("a historical breach repaired after feedback stays on record and approves once", async () => {
  const s = store()
  const first = await auditor(s, scripted({ ...BREACH, repairable: 0.05, cite: "e1" }).model).a.complete("s", completion())
  assert.equal(first.action, "correct")
  const again = scripted({ ...BREACH, repaired: 0.95, cite: "e1", fix: "e2" })
  const second = await auditor(s, again.model).a.complete("s", completion([event("e1", 0), event("e2", 1)]))
  assert.equal(second.state, "APPROVED")
  assert.equal(s.read("s").corrections, 1)
  const finding = s.read("s").findings[0]
  assert.equal(finding.status, "VIOLATED")
  assert.equal(finding.resolved, true)
  assert.deepEqual(finding.evidence, ["e1", "e2"])
  assert.ok((second as any).notice.includes(finding.ruleID))
})

test("corrections are capped, then STOPPED with a report", async () => {
  const s = store()
  const { model } = scripted({ ...BREACH, repaired: 0.1, cite: "e0" })
  const { a } = auditor(s, model, { maxCorrections: 2 })
  const actions = []
  for (let index = 0; index < 4; index++) {
    actions.push((await a.complete("s", completion(Array.from({ length: index + 1 }, (_, seq) => event(`e${seq}`, seq))))).action)
  }
  assert.deepEqual(actions, ["correct", "correct", "none", "none"])
  assert.equal(s.read("s").state, "STOPPED")
})

test("waiting: no auto-continue; synthetic stays locked; real reply resumes once", async () => {
  const s = store()
  const { model, calls } = scripted({ ...CLEAN, turn_waiting: 0.95, cite: "e1" })
  const { a } = auditor(s, model)
  a.userMessage("s", { id: "u1", origin: "human" })
  const waited = await a.complete("s", completion())
  assert.equal(waited.action, "wait")
  assert.equal(s.read("s").state, "WAITING_USER")

  for (const origin of ["synthetic", "fidelis", "agent", "sdk", "unknown"] as const) assert.equal(a.userMessage("s", { id: `x-${origin}`, origin }), false)
  assert.equal(a.userMessage("s", { id: "u1", origin: "human" }), false)
  assert.equal(s.read("s").state, "WAITING_USER")

  const count = calls.length
  const locked = await a.complete("s", completion([event("e1", 0), event("e2", 1)]))
  assert.equal(locked.action, "none")
  assert.equal(locked.state, "WAITING_USER")
  assert.equal(calls.length, count)

  assert.equal(a.userMessage("s", { id: "u2", origin: "human" }), true)
  assert.equal(s.read("s").state, "RUNNING")
  assert.equal(a.userMessage("s", { id: "u2", origin: "human" }), false)
})

test("repair needing authority routes to the user, not the agent", async () => {
  const s = store()
  const { model } = scripted({ ...BREACH, user: 0.9, cite: "e1" })
  const outcome = await auditor(s, model).a.complete("s", completion())
  assert.equal(outcome.action, "wait")
  assert.equal(outcome.state, "WAITING_USER")
})

test("judge failure is explicit and bounded", async () => {
  const s = store()
  let calls = 0
  const model = { id: "x", confidenceKind: "decision" as const, ask: async () => (calls++, Promise.reject(new Error("boom"))) }
  const outcome = await new Auditor({ store: s, host: "opencode", config: config({ retries: 2, timeoutMs: 1000 }), compiler: async () => compilerOutput, judge: { ...model } }).complete("s", completion())
  assert.equal(outcome.state, "AUDIT_INCOMPLETE")
  assert.ok((outcome as any).notice.includes("boom"))
  assert.equal(calls, 3)
})

test("timeouts are enforced; auth errors do not retry", async () => {
  await assert.rejects(withRetry(() => new Promise(() => {}), { retries: 0, timeoutMs: 10 }), /timed out/)
  let calls = 0
  await assert.rejects(withRetry(async () => (calls++, Promise.reject(new Error("401 Unauthorized"))), { retries: 3, timeoutMs: 100, baseDelayMs: 1 }))
  assert.equal(calls, 1)
})

test("unknown verdicts never read as approved", async () => {
  const s = store()
  const { model } = scripted({ turn_waiting: 0, applies: 0.99, deadline: 0.99, violated: 0.1, satisfied: 0.2, absence: 0 })
  const outcome = await auditor(s, model).a.complete("s", completion())
  assert.equal(outcome.state, "AUDIT_INCOMPLETE")
})

test("no consent: default data-sharing model gets nothing, no paid fallback", async () => {
  const s = store()
  let compiled = 0
  const { model, calls } = scripted(CLEAN)
  const auditorNoConsent = new Auditor({ store: s, host: "opencode", config: resolveConfig("opencode"), compiler: async () => (compiled++, compilerOutput), judge: model })
  const outcome = await auditorNoConsent.complete("s", completion())
  assert.equal(outcome.state, "AUDIT_INCOMPLETE")
  assert.ok((outcome as any).reason.includes("allowFreeModelDataUse"))
  assert.equal(compiled, 0)
  assert.equal(calls.length, 0)
  const named = { compilerModel: "opencode/big-pickle" }
  assert.equal(consentProblem("opencode/big-pickle", named, resolveConfig("opencode", named)), null)
})

test("a failed turn leaves no stale RUNNING and never releases a wait", () => {
  const s = store()
  const { a } = auditor(s, scripted(CLEAN).model)
  a.userMessage("s", { id: "u", origin: "human" })
  a.executionEnded("s")
  assert.equal(s.read("s").state, "READY")
  s.update("s", (state) => void (state.state = "WAITING_USER"))
  a.executionEnded("s")
  assert.equal(s.read("s").state, "WAITING_USER")
})

test("unobservable instructions are incomplete, not vacuously approved", async () => {
  const s = store()
  const { model, calls } = scripted(CLEAN)
  const outcome = await auditor(s, model).a.complete("s", { ...completion(), sources: null })
  assert.equal(outcome.state, "AUDIT_INCOMPLETE")
  assert.equal(calls.length, 0)
  const none = await auditor(store(), model).a.complete("s", { ...completion(), sources: [] })
  assert.equal(none.state, "APPROVED")
})

test("budget exhaustion stops transparently", async () => {
  const s = store()
  const { model } = scripted({ ...CLEAN, cite: "e1" })
  const { a } = auditor(s, model, { maxAuditCostUSD: 0.0001 })
  await a.complete("s", completion())
  const outcome = await a.complete("s", completion([event("e1", 0), event("e2", 1)]))
  assert.equal(outcome.state, "STOPPED")
})

test("a human message during an audit discards the stale verdict", async () => {
  const s = store()
  let a: Auditor
  const inner = scripted({ ...BREACH, cite: "e1" })
  const model = { ...inner.model, async ask(state: string, questions: any) {
    a.userMessage("s", { id: "late", origin: "human" })
    return inner.model.ask(state, questions)
  } }
  a = auditor(s, model).a
  const outcome = await a.complete("s", completion())
  assert.equal(outcome.action, "none")
  assert.equal(s.read("s").state, "RUNNING")
})

test("ledger keeps evidence across compaction and holds redacted, clipped data", () => {
  const s = store()
  const { a } = auditor(s, scripted(CLEAN).model)
  a.retain("s", [event("old", 0, { at: 1, output: `token: supersecret99 ${"z".repeat(5000)}` })])
  const merged = a.retain("s", [event("new", 0, { at: 2 })])
  assert.deepEqual(merged.map((item) => item.id), ["old", "new"])
  const stored = readFileSync(join(s.dir, "sessions", "opencode", "s", "ledger.json"), "utf8")
  assert.ok(!stored.includes("supersecret99"))
  assert.ok(stored.length < 3000)
  a.userMessage("s", { id: "u", origin: "human" })
  assert.equal(s.readLedger("s").length, 2)
})

test("earlier turns are context: they can show compliance but cannot be accused", async () => {
  const history = [event("old-review", 0, { input: "review" })]
  const complied = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e", 1)], { history }), prior: [], model: scripted({ ...CLEAN, cite: "old-review" }).model, config: config() })
  assert.equal(complied.findings[0].status, "SATISFIED")
  assert.deepEqual(complied.findings[0].evidence, ["old-review"])
  const accused = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e", 1)], { history }), prior: [], model: scripted({ ...BREACH, cite: "old-review" }).model, config: config() })
  assert.equal(accused.findings[0].status, "UNKNOWN")
})

test("omitting old context is stated and blocks a breach that rests on absence", async () => {
  const history = Array.from({ length: 200 }, (_, index) => event(`h${index}`, index, { input: "y".repeat(100) }))
  const small = digest(evidence([event("e", 200)], { history }), [], 8000)
  assert.equal(small.complete, false)
  assert.ok(small.text.includes("older events omitted"))
  assert.ok(small.text.includes("id=h199"))
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e", 200)], { history }), prior: [], model: scripted({ ...BREACH, absence: 0.9, cite: "e" }).model, config: config({ maxAuditTokens: 2000 }) })
  assert.equal(result.findings[0].status, "UNKNOWN")
})

test("the ledger marks clipped text, clips tool input, and clipped text cannot prove absence", async () => {
  const s = store()
  const { a } = auditor(s, scripted(CLEAN).model)
  a.retain("s", [event("big", 0, { at: 1, input: { command: `token: supersecret99 ${"z".repeat(5000)}` } })])
  const stored = s.readLedger("s")[0]
  assert.equal(typeof stored.input, "string")
  assert.ok((stored.input as string).includes(LEDGER_MARK))
  assert.ok((stored.input as string).length < 2200)
  assert.ok(!(stored.input as string).includes("supersecret99"))
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([stored]), prior: [], model: scripted({ ...BREACH, absence: 0.9, cite: "big" }).model, config: config() })
  assert.equal(result.findings[0].status, "UNKNOWN")
  assert.ok(digest(evidence([stored]), [], 200_000).text.includes("INCOMPLETE"))
})

test("a failed correction delivery does not stay CORRECTING", async () => {
  const s = store()
  const { a } = auditor(s, scripted({ ...BREACH, cite: "e1" }).model)
  assert.equal((await a.complete("s", completion())).state, "CORRECTING")
  a.deliveryFailed("s", "boom")
  assert.equal(s.read("s").state, "AUDIT_INCOMPLETE")
  assert.ok(s.read("s").reason?.includes("boom"))
  a.deliveryFailed("s", "again")
  assert.ok(!s.read("s").reason?.includes("again"))
})

test("an unanswered wait question is incomplete, never a correction", async () => {
  const s = store()
  const { turn_waiting: _omit, ...answers } = { ...BREACH, cite: "e1" }
  const outcome = await auditor(s, scripted(answers).model).a.complete("s", completion())
  assert.equal(outcome.action, "none")
  assert.equal(outcome.state, "AUDIT_INCOMPLETE")
})

test("a compiler reply without a valid confidence is rejected", async () => {
  for (const confidence of [undefined, "high", 7, Number.NaN]) {
    const result = await getChecklist({ store: store(), host: "opencode", sources: [SOURCE], config: config(), generate: async () => JSON.stringify({ confidence, rules: [RAW_RULE] }) })
    assert.equal(result.checklist, undefined)
    assert.ok(result.reason?.includes("confidence"))
  }
})

test("supersededBy applies only to a supersedable rule", async () => {
  const winner = rule({ id: "R-2", quote: "Winner." })
  const mandatory = rule({ id: "R-1", supersededBy: "R-2", supersedable: false })
  const flexible = rule({ id: "R-3", quote: "Flexible.", supersededBy: "R-2", supersedable: true })
  const result = await judge({ checklist: checklist([mandatory, winner, flexible]), evidence: evidence([event("e", 0)]), prior: [], model: scripted({ ...CLEAN, cite: "e" }).model, config: config() })
  assert.equal(result.findings[0].status, "SATISFIED")
  assert.equal(result.findings[2].status, "NOT_APPLICABLE")
})

test("nested instruction text persists per session", () => {
  const s = store()
  assert.deepEqual(s.readNested("x"), {})
  s.writeNested("x", { "/p/sub/AGENTS.md": "- c" })
  assert.deepEqual(s.readNested("x"), { "/p/sub/AGENTS.md": "- c" })
})

test("a long private key never survives clipping, in the ledger or the digest", () => {
  const key = `-----BEGIN RSA PRIVATE KEY-----\n${"SECRETKEYDATA".repeat(800)}\n-----END RSA PRIVATE KEY-----`
  const s = store()
  const { a } = auditor(s, scripted(CLEAN).model)
  a.retain("s", [event("k", 0, { at: 1, output: key, input: { body: key }, text: key })])
  assert.ok(!JSON.stringify(s.readLedger("s")).includes("SECRETKEYDATA"))
  const out = digest(evidence([event("k", 0, { output: key, input: key, text: key })], { userRequest: key, finalReply: key }), [], 200_000)
  assert.ok(!out.text.includes("SECRETKEYDATA"))
  assert.ok(!redact(`-----BEGIN PRIVATE KEY-----\nABCDEF`).includes("ABCDEF"))
})

test("a breach resting on absence is proved against the full clipped span, or stays UNKNOWN", async () => {
  const long = event("r", 0, { output: `${"x".repeat(9000)} APPROVED` })
  const asked: string[] = []
  const inner = scripted({ ...BREACH, absence: 0.9, cite: "r", span: "r" })
  const model = { ...inner.model, ask(state: string, questions: any) {
    asked.push(state)
    return questions.length === 1 && questions[0].name.endsWith("violated") ? Promise.resolve({ answers: { [questions[0].name]: { p: state.includes("APPROVED") ? 0.05 : 0.98 } } }) : inner.model.ask(state, questions)
  } }
  const cleared = await judge({ checklist: checklist([rule()]), evidence: evidence([long]), prior: [], model: model as any, config: config({ maxAuditTokens: 2000 }) })
  assert.notEqual(cleared.findings[0].status, "VIOLATED")
  assert.ok(asked.some((state) => state.includes("APPROVED")))
  const huge = event("h", 0, { output: "y".repeat(40_000) })
  const unproven = await judge({ checklist: checklist([rule()]), evidence: evidence([huge]), prior: [], model: scripted({ ...BREACH, absence: 0.9, cite: "h", span: "h" }).model, config: config({ maxAuditTokens: 2000 }) })
  assert.equal(unproven.findings[0].status, "UNKNOWN")
})

test("a reported breach below the threshold can still be resolved, not left UNKNOWN", async () => {
  const prior = [{ ruleID: "R-1", status: "VIOLATED", quote: "q", source: "s", obligation: "MUST", explanation: "x", evidence: ["e"], severity: "high" }] as any
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([event("e", 0), event("f", 1)]), prior, model: scripted({ ...BREACH, violated: 0.85, absence: 0.1, repaired: 0.9, cite: "e", fix: "f" }).model, config: config() })
  assert.equal(result.findings[0].status, "VIOLATED")
  assert.equal(result.findings[0].resolved, true)
})

test("a partly rejected checklist is not cached and cannot approve", async () => {
  const s = store()
  const partial = JSON.stringify({ confidence: 0.9, rules: [RAW_RULE, { ...RAW_RULE, id: "b", quote: "Invented." }] })
  const { model } = scripted({ ...CLEAN, cite: "e1" })
  const outcome = await auditor(s, model, {}, async () => partial).a.complete("s", completion())
  assert.equal(outcome.state, "AUDIT_INCOMPLETE")
  assert.ok((outcome as any).reason.includes("failed validation"))
  assert.equal(readChecklistCount(s), 0)
})

test("the budget stops further judge calls and counts spend from a failed pipeline", async () => {
  const s = store()
  const { model, calls } = scripted({ ...CLEAN, cite: "e1" })
  const outcome = await auditor(s, { ...model, ask: async (state: string, questions: any) => ({ ...(await model.ask(state, questions)), costUSD: 1 }) }, { maxAuditCostUSD: 0.5 }).a.complete("s", completion())
  assert.equal(outcome.state, "AUDIT_INCOMPLETE")
  assert.ok((outcome as any).reason.includes("budget"))
  assert.equal(calls.length, 1)
  assert.equal(s.read("s").spentUSD, 1)
})

test("an invalid span choice is not a recheck: the absence-based breach stays UNKNOWN", async () => {
  const long = event("r", 0, { output: "x".repeat(9000) })
  const result = await judge({ checklist: checklist([rule()]), evidence: evidence([long]), prior: [], model: scripted({ ...BREACH, absence: 0.9, cite: "r" }, { r0_span: { choice: "not-an-event" } }).model, config: config({ maxAuditTokens: 2000 }) })
  assert.equal(result.findings[0].status, "UNKNOWN")
})

test("clipped history can be restored for a recheck", () => {
  const old = event("h", 0, { output: `${"x".repeat(500)} APPROVED` })
  assert.ok(!digest(evidence([event("e", 1)], { history: [old] }), [], 100_000).text.includes("APPROVED"))
  assert.ok(digest(evidence([event("e", 1)], { history: [old] }), [], 100_000, new Set(["h"])).text.includes("APPROVED"))
})

test("the whole final reply reaches the judge, or the audit is incomplete", () => {
  const reply = `${"x".repeat(20_000)} Which option do you want?`
  assert.ok(digest(evidence([event("e", 0)], { finalReply: reply }), [], 48_000).text.includes("Which option"))
  assert.throws(() => digest(evidence([event("e", 0)], { finalReply: reply }), [], 8_000), EvidenceTooLarge)
})

test("spend from a superseded audit stays on the session and stops further calls", async () => {
  const s = store()
  let a: Auditor
  let calls = 0
  const inner = scripted({ ...BREACH, cite: "e1" })
  const model = { ...inner.model, async ask(state: string, questions: any) {
    calls += 1
    a.userMessage("s", { id: "late", origin: "human" })
    return { ...(await inner.model.ask(state, questions)), costUSD: 0.25 }
  } }
  a = auditor(s, model).a
  const outcome = await a.complete("s", completion())
  assert.equal(outcome.action, "none")
  assert.equal(calls, 1)
  assert.equal(s.read("s").spentUSD, 0.25)
})

test("a cached checklist with rejected rules is not reused", async () => {
  const s = store()
  const base = config()
  const fingerprint = checklistFingerprint("opencode", [SOURCE], base, COMPILER_PROMPT)
  s.putChecklist({ schema: 1, fingerprint, model: "m", compiledAt: 0, rules: [], dropped: ["x"] })
  let calls = 0
  const result = await getChecklist({ store: s, host: "opencode", sources: [SOURCE], config: base, generate: async () => (calls++, compilerOutput) })
  assert.equal(calls, 1)
  assert.equal(result.cacheHit, false)
})

test("cleanup enforces retention", () => {
  const s = store()
  s.update("old", (state) => void (state.turn = 1))
  s.cleanup(30, Date.now() + 60 * 86_400_000)
  assert.equal(s.read("old").turn, 0)
})

test("OpenCode predicate transport maps probability; native noul maps noul", async () => {
  let sent: any
  const oc = opencodeDecisions(async (input) => ((sent = input), { answers: [{ type: "predicate", name: "a", probability: 0.8 }, { type: "choice", name: "b", choice: "e1", confidence: 0.6, probabilities: [] }, { type: "error", name: "c", reason: "refused" }], tokens: { input: 3, output: 2 }, cost: 0 }), "opencode/jev-1.13-free")
  const questions = [{ type: "predicate", name: "a", instructions: "q" }, { type: "choice", name: "b", instructions: "q", choices: [{ value: "e1", description: "d" }] }, { type: "predicate", name: "c", instructions: "q" }] as const
  const fromOc = await oc.ask("state", [...questions])
  assert.deepEqual(sent.model, { providerID: "opencode", id: "jev-1.13-free" })
  assert.equal(sent.questions[0].type, "predicate")
  assert.ok(!JSON.stringify(sent).includes("noul"))
  assert.deepEqual(fromOc.answers, { a: { p: 0.8 }, b: { choice: "e1", p: 0.6 }, c: { error: "refused" } })
  assert.equal(fromOc.tokens, 5)

  let body: any
  const native = jevNative({ apiKey: "k", fetch: (async (_url: string, init: any) => ((body = JSON.parse(init.body)), new Response(JSON.stringify({ answers: { a: { type: "noul", noul: 0.7 }, b: { type: "choice", choice: "e1", confidence: 1 } }, usage: { input_tokens: 1, output_tokens: 1 } })))) as any })
  const fromNative = await native.ask("state", [questions[0], questions[1]])
  assert.equal(body.state, "state")
  assert.equal(body.questions.a.type, "noul")
  assert.deepEqual(body.questions.b.criteria, { e1: "d" })
  assert.deepEqual(fromNative.answers, { a: { p: 0.7 }, b: { choice: "e1", p: 1 } })
})

test("text model answers are validated and labeled self-reported", async () => {
  const text = textDecisions(async () => '```json\n{"answers":{"a":{"p":0.4},"b":{"choice":"bad"},"c":{"p":7}}}\n```', "haiku")
  assert.equal(text.confidenceKind, "self-reported")
  const out = await text.ask("s", [{ type: "predicate", name: "a", instructions: "q" }, { type: "choice", name: "b", instructions: "q", choices: [{ value: "e1", description: "d" }] }, { type: "predicate", name: "c", instructions: "q" }])
  assert.deepEqual(out.answers.a, { p: 0.4 })
  assert.ok(out.answers.b.error)
  assert.ok(out.answers.c.error)
  assert.deepEqual(parseJson('text {"a":1} text'), { a: 1 })
})
