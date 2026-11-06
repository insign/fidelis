// Live proof against the installed Claude Code. Spends Haiku quota. Run: npm run build && node tests/live/claude.mjs
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const root = mkdtempSync(join(tmpdir(), "fidelis-live-cc-"))
const env = { ...process.env, FIDELIS_HOME: join(root, "home") }
let failed = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`)
  if (!ok) failed++
}

function fixture(name, rules) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  execFileSync("git", ["init", "-q", dir])
  writeFileSync(join(dir, "AGENTS.md"), rules)
  return dir
}

function run(dir, prompt, ...extra) {
  const args = ["-p", prompt, "--model", "claude-haiku-5-5", "--effort", "low", "--output-format", "json", "--setting-sources", "project", "--plugin-dir", join(repo, "packages/claude-code"), "--allowedTools", "Bash", ...extra]
  const out = spawnSync("claude", args, { cwd: dir, env, encoding: "utf8", timeout: 600_000 })
  return JSON.parse(out.stdout)
}

const sessionDir = (id) => join(env.FIDELIS_HOME, "sessions", "claude-code", encodeURIComponent(id))
const state = (id) => JSON.parse(readFileSync(join(sessionDir(id), "state.json"), "utf8"))
const audits = (id) => {
  try {
    return readFileSync(join(sessionDir(id), "audits.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

async function until(read, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const value = read()
    if (value) return value
    await delay(1000)
  }
  return null
}

const RULE = "- You MUST run the `ls` command with the Bash tool at least once before your final reply in every turn.\n"
const script = "--append-system-prompt"

// 1. Violation, correction through Stop feedback, clean re-audit, exactly one correction.
const violator = fixture("violation", RULE)
const first = run(violator, "What is 2+2?", script, "Answer the first message directly and use no tools. If you later receive Fidelis audit feedback, follow it.")
const firstAudits = audits(first.session_id)
check("violation produced a correction", firstAudits[0]?.state === "CORRECTING", JSON.stringify(firstAudits.map((audit) => audit.state)))
check("violated finding cites the original quote and evidence", firstAudits[0]?.findings.some((finding) => finding.status === "VIOLATED" && finding.quote.includes("ls") && finding.evidence.length === 1))
check("corrective turn re-audited and approved", firstAudits.at(-1)?.state === "APPROVED", firstAudits.at(-1)?.reason ?? "")
check("exactly one correction", state(first.session_id).corrections === 1, `corrections=${state(first.session_id).corrections}`)
check("first audit compiled, no cache", firstAudits[0]?.metrics.cacheHit === false && firstAudits[0]?.metrics.compilerCalls === 1)
check("confidence is labeled self-reported", firstAudits[0]?.findings.find((finding) => finding.status === "VIOLATED")?.confidenceKind === "self-reported")
check("nested compiler left no session recursion", firstAudits.length <= 3, `audits=${firstAudits.length}`)

// 2. Same rules, new session: checklist reused without a compiler call.
const compliant = run(violator, "List the files here with ls and tell me how many there are.")
const compliantAudits = audits(compliant.session_id)
check("new session reused the checklist", compliantAudits[0]?.metrics.cacheHit === true && compliantAudits[0]?.metrics.compilerCalls === 0)
check("compliant turn approved without correction", state(compliant.session_id).state === "APPROVED" && state(compliant.session_id).corrections === 0, state(compliant.session_id).state)

// 3. Replayed Stop callback: no second audit, no second correction.
const transcript = readFileSync(join(process.env.HOME, ".claude", "projects", compliant.session_id ? violator.replace(/[^A-Za-z0-9]/g, "-") : "", `${compliant.session_id}.jsonl`), "utf8")
check("transcript recorded the turn", transcript.includes(compliant.session_id))
const promptID = transcript.split("\n").filter(Boolean).map((line) => JSON.parse(line)).find((record) => record.type === "user" && record.promptId)?.promptId
const hookInput = { hook_event_name: "Stop", prompt_id: promptID, session_id: compliant.session_id, cwd: violator, transcript_path: join(process.env.HOME, ".claude", "projects", violator.replace(/[^A-Za-z0-9]/g, "-"), `${compliant.session_id}.jsonl`), last_assistant_message: compliant.result, stop_hook_active: false, background_tasks: [] }
const replay = () => spawnSync("node", [join(repo, "packages/claude-code/dist/cli.js"), "hook"], { input: JSON.stringify(hookInput), env, encoding: "utf8", timeout: 600_000 })
const before = audits(compliant.session_id).length
replay()
const mid = audits(compliant.session_id).length
const second = replay()
check("replayed callback is deduplicated", audits(compliant.session_id).length === before && mid === before && second.stdout === "", `audits ${before}->${mid}->${audits(compliant.session_id).length}`)

// 4. A necessary question: WAITING_USER, no push; automatic SDK turn stays locked.
const asker = fixture("waiting", "- You MUST ask the user before choosing an indentation style.\n")
const asked = run(asker, "Set up an editorconfig. You must ask me first whether I want tabs or spaces, then stop and wait for my answer.")
check("question leaves WAITING_USER", state(asked.session_id).state === "WAITING_USER", state(asked.session_id).state)
check("no automatic continuation", state(asked.session_id).corrections === 0)
const auditsBefore = audits(asked.session_id).length
const resumed = run(asker, "Automated ping: please continue.", "--resume", asked.session_id)
check("SDK-origin turn does not release the wait", state(resumed.session_id).state === "WAITING_USER" && audits(asked.session_id).length === auditsBefore, state(resumed.session_id).state)

// 5. A real human reply, typed in an interactive terminal, releases the wait exactly once.
const humans = state(asked.session_id).humanIDs.length
const term = spawn("script", ["-qfec", `stty rows 40 cols 120; exec claude --resume ${asked.session_id} --model claude-haiku-5-5 --effort low --setting-sources project --plugin-dir ${join(repo, "packages/claude-code")}`, "/dev/null"], { cwd: asker, env: { ...env, PWD: asker }, stdio: ["pipe", "pipe", "ignore"] })
let screen = ""
term.stdout.on("data", (chunk) => (screen += chunk))
await delay(6000)
// Accept the folder trust dialog for this throwaway fixture if it appears. "No, exit" is preselected.
if (/trust this folder/i.test(screen)) {
  term.stdin.write("\x1b[B")
  await delay(500)
  term.stdin.write("\r")
  await delay(4000)
}
term.stdin.write("Use spaces, thanks. Do not create any file; just confirm.")
await delay(800)
term.stdin.write("\r")
const replied = await until(() => {
  const current = state(asked.session_id)
  return current.humanIDs.length > humans && !["AUDITING", "RUNNING"].includes(current.state) ? current : null
}, 240_000)
term.kill("SIGTERM")
check("typed human reply released the wait once", replied?.humanIDs.length === humans + 1 && replied?.state !== "WAITING_USER", `${replied?.state} humans=${replied?.humanIDs.length}`)

// 6. Hook timeout: the host ends the hook, the turn still finishes, and the audit does not wedge the session.
const slow = fixture("timeout", "- Say hello.\n")
const slowBin = join(root, "slow-claude.sh")
writeFileSync(slowBin, "#!/bin/sh\nexec sleep 60\n", { mode: 0o755 })
const hookSettings = join(root, "timeout-settings.json")
writeFileSync(hookSettings, JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${join(repo, "packages/claude-code/dist/cli.js")}" hook`, timeout: 3 }] }] } }))
const started = Date.now()
const timedOut = spawnSync("claude", ["-p", "Say hello.", "--model", "claude-haiku-5-5", "--effort", "low", "--output-format", "json", "--setting-sources", "project", "--settings", hookSettings], { cwd: slow, env: { ...env, FIDELIS_CLAUDE_BIN: slowBin }, encoding: "utf8", timeout: 120_000 })
const slowResult = JSON.parse(timedOut.stdout)
check("hook timeout does not fail the turn", slowResult.is_error === false && Date.now() - started < 110_000, `${Date.now() - started} ms`)
check("timed-out audit claims nothing", state(slowResult.session_id).state === "AUDITING" && audits(slowResult.session_id).length === 0, state(slowResult.session_id).state)

console.log(failed ? `${failed} check(s) failed` : "All live Claude Code checks passed")
console.log(`fixtures: ${root}`)
process.exit(failed ? 1 : 0)
