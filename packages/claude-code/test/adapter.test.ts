import { strict as assert } from "node:assert"
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import { buildEvidence, compareVersions, discoverInstructions, parseTranscript } from "../src/adapter.ts"
import { outputFor } from "../src/cli.ts"

const prompt = (uuid: string, extra = {}) => ({ type: "user", uuid, timestamp: "2026-11-05T10:00:00Z", message: { role: "user", content: `ask ${uuid}` }, ...extra })
const human = (uuid: string) => prompt(uuid, { origin: { kind: "human" }, turnOrigin: "human", promptSource: "typed" })
const toolUse = (uuid: string, id: string) => ({ type: "assistant", uuid, timestamp: "2026-11-05T10:00:01Z", message: { content: [{ type: "thinking", thinking: "secret thought" }, { type: "tool_use", id, name: "Bash", input: { command: "git commit" } }] } })
const toolResult = (id: string, is_error = false) => ({ type: "user", uuid: `r-${id}`, timestamp: "2026-11-05T10:00:02Z", message: { content: [{ type: "tool_result", tool_use_id: id, content: "ok", is_error }] } })
const text = (uuid: string, value: string) => ({ type: "assistant", uuid, timestamp: "2026-11-05T10:00:03Z", message: { content: [{ type: "text", text: value }] } })

test("origins: human, SDK, task notification and stop feedback are told apart; a mid-turn steer stays evidence", () => {
  const parsed = parseTranscript([
    human("h"),
    prompt("sdk", { turnOrigin: "sdk", promptSource: "sdk" }),
    prompt("task", { origin: { kind: "task-notification" }, turnOrigin: "task_notification", promptSource: "system" }),
    prompt("meta", { isMeta: true }),
    { type: "attachment", uuid: "q", attachment: { type: "queued_command", humanTurn: true, origin: { kind: "human" }, source_uuid: "src", prompt: "steer" } },
    { type: "attachment", uuid: "f", attachment: { type: "hook_additional_context", hookEvent: "Stop", content: ["[Fidelis audit] fix"] } },
  ])
  assert.deepEqual(parsed.messages, [{ id: "h", origin: "human" }, { id: "sdk", origin: "sdk" }, { id: "task", origin: "synthetic" }])
  assert.ok(parsed.events.some((event) => event.id === "src" && event.kind === "user" && event.text === "steer"))
  assert.ok(parsed.events.some((event) => event.kind === "fidelis"))
})

test("evidence window starts at the last prompt and stays cumulative through stop feedback", () => {
  const parsed = parseTranscript([human("old"), toolUse("a0", "t0"), toolResult("t0"), human("new"), toolUse("a1", "t1"), toolResult("t1", true), text("a2", "done"), { type: "attachment", uuid: "f", attachment: { type: "hook_additional_context", hookEvent: "Stop", content: ["fix it"] } }, text("a3", "fixed")])
  assert.equal(parsed.userRequest, "ask new")
  assert.deepEqual(parsed.history.map((event) => event.kind), ["user", "tool"])
  assert.deepEqual(parsed.events.map((event) => event.kind), ["user", "tool", "assistant", "fidelis", "assistant"])
  assert.equal(parsed.events[1].status, "failed")
  assert.ok(!JSON.stringify(parsed.events).includes("secret thought"))
})

test("recorded instructions are the effective set; later records win without duplicates", () => {
  const parsed = parseTranscript([
    { type: "attachment", uuid: "i", attachment: { type: "instructions", files: [{ path: "/p/AGENTS.md", type: "Project", content: "v1" }, { path: "/u/CLAUDE.md", type: "User", content: "u" }] } },
    { type: "attachment", uuid: "n", attachment: { type: "nested_memory", path: "/p/sub/AGENTS.md", content: { content: "n" } } },
    { type: "attachment", uuid: "j", attachment: { type: "instructions", files: [{ path: "/p/AGENTS.md", type: "Project", content: "v2" }] } },
  ])
  assert.deepEqual(parsed.sources.map((source) => [source.path, source.text, source.scope]), [["/p/AGENTS.md", "v2", "project"], ["/u/CLAUDE.md", "u", "user"], ["/p/sub/AGENTS.md", "n", "nested"]])
})

test("nested AGENTS.md arrives through the tool-call hook; other hook output is not a source", () => {
  const parsed = parseTranscript([
    { type: "attachment", uuid: "n", attachment: { type: "hook_additional_context", hookName: "tool.call", hookEvent: "PostToolUse", content: ["Contents of /p/sub/AGENTS.md:\n\n- gamma\n"] } },
    { type: "attachment", uuid: "o", attachment: { type: "hook_additional_context", hookName: "tool.call", hookEvent: "PostToolUse", content: ["Contents of /etc/passwd:\n\nroot"] } },
    { type: "attachment", uuid: "p", attachment: { type: "hook_additional_context", hookName: "other", hookEvent: "PostToolUse", content: ["Contents of /x/AGENTS.md:\n\nno"] } },
  ])
  assert.deepEqual(parsed.sources.map((source) => [source.path, source.text]), [["/p/sub/AGENTS.md", "- gamma\n"]])
})

const POSIX_PATHS = { skip: process.platform === "win32" }
const fixture = () => {
  // Discovery resolves symlinks, and macOS keeps its temp directory behind one.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "fidelis-cc-")))
  const home = join(root, "home")
  const repo = join(root, "repo")
  const cwd = join(repo, "pkg")
  mkdirSync(join(home, ".claude"), { recursive: true })
  mkdirSync(cwd, { recursive: true })
  return { root, home, repo, cwd, env: { HOME: home, CLAUDE_CONFIG_DIR: join(home, ".claude") } as NodeJS.ProcessEnv }
}
const names = (sources: { path: string }[], root: string) => sources.map((source) => source.path.replace(`${root}/`, ""))

test("fallback matrix: AGENTS.md alone loads; CLAUDE.md suppresses it by default", POSIX_PATHS, () => {
  const { root, repo, cwd, env } = fixture()
  writeFileSync(join(repo, "AGENTS.md"), "a")
  assert.deepEqual(names(discoverInstructions(cwd, "2.1.318", env), root), ["repo/AGENTS.md"])
  assert.deepEqual(discoverInstructions(cwd, "2.1.276", env), [])
  writeFileSync(join(repo, "CLAUDE.md"), "c")
  assert.deepEqual(names(discoverInstructions(cwd, "2.1.318", env), root), ["repo/CLAUDE.md"])
})

test("fallback matrix: the combined setting loads both, once each", POSIX_PATHS, () => {
  const { root, home, repo, cwd, env } = fixture()
  writeFileSync(join(repo, "AGENTS.md"), "a")
  writeFileSync(join(repo, "CLAUDE.md"), "@AGENTS.md")
  writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ pluginConfigs: { "cc-plugin-agents-md@builtin": { options: { instructionFiles: "claude-md-and-agents-md" } } } }))
  assert.deepEqual(names(discoverInstructions(cwd, "2.1.318", env), root), ["repo/CLAUDE.md", "repo/AGENTS.md"])
})

test("fallback: imports recurse, code spans do not import, scoped rules wait", POSIX_PATHS, () => {
  const { root, repo, cwd, env } = fixture()
  writeFileSync(join(repo, "CLAUDE.md"), "see @docs/a.md and `@docs/not.md`")
  mkdirSync(join(repo, "docs"))
  writeFileSync(join(repo, "docs", "a.md"), "@b.md")
  writeFileSync(join(repo, "docs", "b.md"), "b")
  writeFileSync(join(repo, "docs", "not.md"), "n")
  mkdirSync(join(repo, ".claude", "rules"), { recursive: true })
  writeFileSync(join(repo, ".claude", "rules", "eager.md"), "e")
  writeFileSync(join(repo, ".claude", "rules", "scoped.md"), "---\npaths:\n  - src/**\n---\ns")
  assert.deepEqual(names(discoverInstructions(cwd, "2.1.318", env), root), ["repo/CLAUDE.md", "repo/docs/a.md", "repo/docs/b.md", "repo/.claude/rules/eager.md"])
})

test("fallback: a symlinked instruction file is not double-counted", POSIX_PATHS, () => {
  const { repo, cwd, env } = fixture()
  writeFileSync(join(repo, "AGENTS.md"), "a")
  symlinkSync(join(repo, "AGENTS.md"), join(repo, "CLAUDE.md"))
  assert.equal(discoverInstructions(cwd, "2.1.318", env).length, 1)
})

test("evidence adds the hook's final reply when the transcript lags; dangling tools mean incomplete", () => {
  const { root } = fixture()
  const path = join(root, "t.jsonl")
  writeFileSync(path, [human("h"), toolUse("a", "t1"), toolResult("t1")].map((record) => JSON.stringify(record)).join("\n"))
  const done = buildEvidence(path, "final words").evidence
  assert.equal(done.complete, true)
  assert.equal(done.events.at(-1)!.text, "final words")
  writeFileSync(path, [human("h"), toolUse("a", "t1")].map((record) => JSON.stringify(record)).join("\n"))
  assert.equal(buildEvidence(path, "x").evidence.complete, false)
  assert.equal(buildEvidence(join(root, "missing.jsonl"), "x").evidence.complete, false)
})

test("subagent tools are attributed and kept to the window", () => {
  const { root } = fixture()
  const path = join(root, "s.jsonl")
  writeFileSync(path, [human("h")].map((record) => JSON.stringify(record)).join("\n"))
  mkdirSync(join(root, "s", "subagents"), { recursive: true })
  const sub = [{ type: "user", uuid: "su", timestamp: "2026-11-05T10:00:00Z", message: { content: "task" } }, { ...toolUse("sa", "st"), timestamp: "2026-11-05T10:00:05Z" }, { ...toolResult("st"), timestamp: "2026-11-05T10:00:06Z" }]
  writeFileSync(join(root, "s", "subagents", "agent-1.jsonl"), sub.map((record) => JSON.stringify(record)).join("\n"))
  const tool = buildEvidence(path, "").evidence.events.find((event) => event.actor === "subagent")!
  assert.equal(tool.id, "agent-1.jsonl:st")
  assert.equal(tool.status, "completed")
})

test("stop output: correction continues, waits and clean turns do not block", () => {
  assert.deepEqual(outputFor({ action: "correct", state: "CORRECTING", auditID: "a", text: "fix" }), { hookSpecificOutput: { hookEventName: "Stop", additionalContext: "fix" } })
  assert.equal(outputFor({ action: "wait", state: "WAITING_USER", auditID: "a", reason: "r" }), null)
  assert.equal(outputFor({ action: "none", state: "APPROVED" }), null)
  assert.deepEqual(outputFor({ action: "none", state: "STOPPED", notice: "n" }), { systemMessage: "n" })
})

test("version compare", () => {
  assert.ok(compareVersions("2.1.277", "2.1.276") > 0)
  assert.equal(compareVersions("2.1.277", "2.1.277"), 0)
  assert.ok(compareVersions("2.1.3", "2.1.277") < 0)
})
