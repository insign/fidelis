import { strict as assert } from "node:assert"
import { spawnSync } from "node:child_process"
import { join } from "node:path"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { REVIEW_PROMPT } from "fidelis"
import { stopOutput, withHook, withoutOwnHook } from "../src/cli.ts"

const stop = (extra = {}) => ({ hook_event_name: "Stop", session_id: "s", stop_hook_active: false, background_tasks: [], ...extra })
const REVIEW = { hookSpecificOutput: { hookEventName: "Stop", additionalContext: REVIEW_PROMPT } }

test("a finished turn gets the review in the same session", () => {
  assert.deepEqual(stopOutput(stop()), REVIEW)
})

test("the stop that ends a continuation, including the review itself, is not reviewed again", () => {
  assert.equal(stopOutput(stop({ stop_hook_active: true })), null)
})

test("subagents, unfinished background work and other events get no review", () => {
  assert.equal(stopOutput(stop({ agent_id: "a1" })), null)
  assert.equal(stopOutput(stop({ background_tasks: [{ status: "running" }] })), null)
  assert.equal(stopOutput(stop({ background_tasks: [{ status: "pending" }] })), null)
  assert.deepEqual(stopOutput(stop({ background_tasks: [{ status: "completed" }] })), REVIEW)
  assert.equal(stopOutput({ ...stop(), hook_event_name: "SessionStart" }), null)
  assert.equal(stopOutput(null), null)
})

test("the hook command prints the review, and malformed input ends the turn quietly", () => {
  const cli = join(fileURLToPath(new URL(".", import.meta.url)), "..", "dist", "cli.js")
  const run = (input: string) => spawnSync(process.execPath, [cli, "hook"], { input, encoding: "utf8" })
  assert.deepEqual(JSON.parse(run(JSON.stringify(stop())).stdout), REVIEW)
  assert.equal(run(JSON.stringify(stop({ stop_hook_active: true }))).stdout, "")
  const broken = run("not json")
  assert.equal(broken.status, 0)
  assert.equal(broken.stdout, "")
})

test("install removes only the Fidelis hook, never its neighbors", () => {
  const own = { type: "command", command: 'node "/usr/lib/node_modules/fidelis-claude-code/dist/cli.js" hook' }
  const neighbor = { type: "command", command: "/home/fidelis/src/fidelis/notify.sh" }
  const groups = [{ hooks: [own] }, { hooks: [neighbor, own] }, { hooks: [neighbor] }]
  assert.deepEqual(withoutOwnHook(groups), [{ hooks: [neighbor] }, { hooks: [neighbor] }])
})

test("install adds one Stop hook and drops the SessionStart hook of earlier versions", () => {
  const command = 'node "/x/fidelis-claude-code/dist/cli.js" hook'
  const neighbor = { hooks: [{ type: "command", command: "notify.sh" }] }
  const old = { theme: "dark", hooks: { SessionStart: [{ hooks: [{ type: "command", command, timeout: 10 }] }], Stop: [neighbor, { hooks: [{ type: "command", command, timeout: 900 }] }] } }
  const installed = withHook(old, command, false)
  assert.equal(installed.theme, "dark")
  assert.equal(installed.hooks.SessionStart, undefined)
  assert.deepEqual(installed.hooks.Stop, [neighbor, { hooks: [{ type: "command", command, timeout: 10 }] }])
  assert.deepEqual(withHook(installed, command, false), installed)
  assert.deepEqual(withHook(installed, command, true).hooks, { Stop: [neighbor] })
})
