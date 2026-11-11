import { strict as assert } from "node:assert"
import { test } from "node:test"
import { finalBoundary, isReview, turnToReview } from "../src/adapter.ts"

// Shapes captured from a real OpenCode 2.2.5 session.
const user = (id: string, metadata?: object) => ({ id, type: "user", text: `ask ${id}`, metadata, time: { created: 1 } })
const review = (id: string) => user(id, { fidelis: { origin: "fidelis" } })
const assistant = (id: string, finish: string, content: any[]) => ({ id, type: "assistant", finish, content, time: { created: 2 } })
const idle = (id = "idle", outcome = "succeeded") => ({ id, type: "idle", outcome, time: { created: 3 } })
const tool = (id: string, status = "completed") => ({ type: "tool", id, name: "shell", state: { status, input: { command: "ls" } }, time: { created: 2 } })
const reply = (text: string) => ({ type: "text", text })

test("completion candidate without a final turn is not a boundary", () => {
  assert.equal(finalBoundary([]), null)
  assert.equal(finalBoundary([user("u"), idle()]), null)
  assert.equal(finalBoundary([user("u"), assistant("a", "tool-calls", [tool("t")]), idle()]), null)
  assert.equal(finalBoundary([user("u"), assistant("a", "stop", [reply("hi")])]), null)
  assert.equal(finalBoundary([user("u"), assistant("a", "stop", [reply("hi")]), idle("i", "failed")]), null)
  assert.equal(finalBoundary([user("u"), assistant("a", "stop", [tool("t", "running"), reply("hi")]), idle()]), null)
  assert.equal(finalBoundary([assistant("a", "stop", [reply("old")]), user("u"), idle()]), null)
})

test("a finished turn is keyed by its final assistant message", () => {
  assert.equal(finalBoundary([user("u"), assistant("a", "tool-calls", [tool("t")]), assistant("b", "stop", [reply("done")]), { type: "system" }, idle()]), "b")
})

test("a turn opened by the user is reviewed; the review's own turn is not", () => {
  const turn = [user("u"), assistant("a", "stop", [tool("t"), reply("done")]), idle("i0")]
  assert.equal(turnToReview(turn), "a")
  assert.equal(turnToReview([...turn, review("r"), assistant("b", "stop", [reply("All rules were respected.")]), idle("i1")]), null)
  assert.equal(turnToReview([...turn, review("r"), assistant("b", "stop", [reply("ok")]), idle("i1"), user("u2"), assistant("c", "stop", [reply("next")]), idle("i2")]), "c")
})

test("a turn whose opening message was compacted away is not reviewed", () => {
  assert.equal(turnToReview([{ type: "compaction" }, assistant("a", "stop", [reply("done")]), idle()]), null)
})

test("only records Fidelis marked count as the review", () => {
  assert.equal(isReview(review("r")), true)
  assert.equal(isReview(user("u")), false)
  assert.equal(isReview({ type: "synthetic", metadata: { fidelis: {} } }), false)
})
