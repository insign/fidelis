import { strict as assert } from "node:assert"
import { test } from "node:test"
import { buildEvidence, childSessions, effectiveSources, finalBoundary, messageOrigin, parseInstructionBlocks, toEvents, windowOf } from "../src/adapter.ts"

// Shapes captured from a real OpenCode 2.2.5 session.
const user = (id: string, metadata?: object) => ({ id, type: "user", text: `ask ${id}`, metadata, time: { created: 1 } })
const assistant = (id: string, finish: string, content: any[]) => ({ id, type: "assistant", finish, content, time: { created: 2 } })
const idle = (id = "idle", outcome = "succeeded") => ({ id, type: "idle", outcome, time: { created: 3 } })
const tool = (id: string, status = "completed", extra = {}) => ({ type: "tool", id, name: "shell", state: { status, input: { command: "ls" }, content: [{ type: "text", text: "out" }], ...extra }, time: { created: 2 } })
const reply = (text: string) => ({ type: "text", text })

test("instruction blocks keep path identity", () => {
  const blocks = parseInstructionBlocks("Instructions from: /g/AGENTS.md\n- a\n\n\nInstructions from: /p/AGENTS.md\n# t\n\n- b\n")
  assert.deepEqual(blocks, [{ path: "/g/AGENTS.md", text: "- a" }, { path: "/p/AGENTS.md", text: "# t\n\n- b" }])
})

test("nested instructions survive after their message is compacted away", () => {
  const nested = new Map<string, string>()
  const synthetic = { type: "synthetic", metadata: { instruction: { paths: ["/p/sub/AGENTS.md"] } }, text: "Instructions from: /p/sub/AGENTS.md\n- c" }
  const first = effectiveSources("Instructions from: /p/AGENTS.md\n- b", [synthetic], nested)
  assert.deepEqual(first.map((source) => source.path), ["/p/AGENTS.md", "/p/sub/AGENTS.md"])
  const later = effectiveSources("Instructions from: /p/AGENTS.md\n- b", [], nested)
  assert.equal(later.length, 2)
})

test("a synthetic message without instruction metadata is not a source", () => {
  assert.equal(effectiveSources(undefined, [{ type: "synthetic", text: "Instructions from: /evil\n- x" }], new Map()).length, 0)
})

test("completion candidate without a final turn is not a boundary", () => {
  assert.equal(finalBoundary([]), null)
  assert.equal(finalBoundary([user("u"), idle()]), null)
  assert.equal(finalBoundary([user("u"), assistant("a", "tool-calls", [tool("t")]), idle()]), null)
  assert.equal(finalBoundary([user("u"), assistant("a", "stop", [reply("hi")])]), null)
  assert.equal(finalBoundary([user("u"), assistant("a", "stop", [reply("hi")]), idle("i", "failed")]), null)
  assert.equal(finalBoundary([user("u"), assistant("a", "stop", [tool("t", "running"), reply("hi")]), idle()]), null)
  assert.equal(finalBoundary([assistant("a", "stop", [reply("old")]), user("u"), idle()]), null)
})

test("finished turn yields a stable boundary keyed by the final assistant message", () => {
  const boundary = finalBoundary([user("u"), assistant("a", "tool-calls", [tool("t")]), assistant("b", "stop", [{ type: "reasoning", text: "hidden" }, reply("done")]), idle()])
  assert.deepEqual(boundary, { key: "b", finalReply: "done" })
})

test("origin gate: only unmarked user records are human", () => {
  assert.equal(messageOrigin(user("u")), "human")
  assert.equal(messageOrigin(user("u", { fidelis: { origin: "fidelis" } })), "fidelis")
  assert.equal(messageOrigin({ type: "synthetic" }), "synthetic")
  assert.equal(messageOrigin({ type: "assistant" }), "agent")
})

test("evidence is cumulative across a correction and excludes reasoning", () => {
  const messages = [user("old"), assistant("x", "stop", [reply("old")]), idle("i0"), user("u"), assistant("a", "stop", [{ type: "reasoning", text: "secret thought" }, tool("t"), reply("first")]), idle("i1"), user("c", { fidelis: {} }), assistant("b", "stop", [reply("fixed")]), idle("i2")]
  const window = windowOf(messages)
  assert.equal(window[0].id, "u")
  const events = toEvents(window)
  assert.deepEqual(events.map((event) => event.kind), ["user", "tool", "assistant", "fidelis", "assistant"])
  assert.ok(!JSON.stringify(events).includes("secret thought"))
  assert.equal(events[1].status, "completed")
  assert.equal(events[1].output, "out")
})

test("failed tools and child sessions keep attribution", () => {
  const failing = toEvents([assistant("a", "stop", [{ ...tool("t", "error"), state: { status: "error", input: {}, error: { message: "boom" } } }])])
  assert.equal(failing[0].status, "failed")
  assert.equal(failing[0].output, "boom")
  assert.deepEqual(childSessions([assistant("a", "stop", [tool("t", "completed", { metadata: { sessionID: "ses_child" } })])]), ["ses_child"])
  assert.equal(toEvents([assistant("a", "stop", [tool("t")])], "subagent")[0].actor, "subagent")
})

test("earlier turns become history; the reply to a wait keeps the question in context", () => {
  const messages = [user("ask"), assistant("a", "stop", [reply("tabs or spaces?")]), idle("i0"), user("answer"), assistant("b", "stop", [tool("t"), reply("done")]), idle("i1")]
  const evidence = buildEvidence(messages, finalBoundary(messages)!, toEvents(messages), false)
  assert.equal(evidence.userRequest, "ask answer")
  assert.deepEqual(evidence.events.map((event) => event.id)[0], "answer")
  assert.deepEqual(evidence.history!.map((event) => event.kind), ["user", "assistant"])
})

test("when compaction removes the opening message, the ledger still separates earlier turns", () => {
  const messages = [{ type: "compaction" }, assistant("b", "stop", [reply("done")]), idle("i")]
  const retained = [{ id: "old", seq: 0, kind: "user" as const, text: "old ask" }, { id: "t0", seq: 1, kind: "tool" as const }, { id: "new", seq: 2, kind: "user" as const, text: "new ask" }, { id: "t1", seq: 3, kind: "tool" as const }]
  const evidence = buildEvidence(messages, finalBoundary(messages)!, retained, true)
  assert.equal(evidence.userRequest, "new ask")
  assert.deepEqual(evidence.history!.map((event) => event.id), ["old", "t0"])
  assert.deepEqual(evidence.events.map((event) => event.id), ["new", "t1"])
  assert.equal(evidence.complete, true)
  const unknown = buildEvidence(messages, finalBoundary(messages)!, [{ id: "t", seq: 0, kind: "tool" as const }], true)
  assert.equal(unknown.complete, false)
  assert.deepEqual(unknown.events, [])
  assert.deepEqual(unknown.history!.map((event) => event.id), ["t"])
})

test("compaction without a retained ledger marks evidence incomplete", () => {
  const messages = [{ type: "compaction" }, user("u"), assistant("a", "stop", [reply("r")]), idle()]
  const boundary = finalBoundary(messages)!
  assert.equal(buildEvidence(messages, boundary, toEvents(messages), false).complete, false)
  assert.equal(buildEvidence(messages, boundary, toEvents(messages), true).complete, true)
})
