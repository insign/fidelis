// Drives the real OpenCode TUI in a pseudo-terminal. Free models, fixture text only, isolated config.
// Run: npm run build && node tests/live/tui.mjs
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"
import xterm from "@xterm/headless"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const PLUGIN = process.env.FIDELIS_PLUGIN_PATH ?? join(repo, "packages/opencode")
// FIDELIS_TUI_REUSE=<earlier fixture root> replays a finished session, with no model calls needed.
const reuse = process.env.FIDELIS_TUI_REUSE
const root = reuse ?? mkdtempSync(join(tmpdir(), "fidelis-live-tui-"))
const xdg = (name) => join(root, "xdg", name)
const PORT = 41000 + Math.floor(Math.random() * 3000)
const server = `http://127.0.0.1:${PORT}`
const env = { ...process.env, TERM: "xterm-256color", COLORTERM: "truecolor", OPENCODE_PASSWORD: "fidelis-live", XDG_CONFIG_HOME: xdg("config"), XDG_DATA_HOME: xdg("data"), XDG_STATE_HOME: xdg("state"), XDG_CACHE_HOME: xdg("cache"), FIDELIS_HOME: join(root, "home") }
let failed = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`)
  if (!ok) failed++
}

const dir = join(root, "work")
mkdirSync(dir, { recursive: true })
if (!reuse) spawnSync("git", ["init", "-q", dir])
if (!reuse) writeFileSync(join(dir, "AGENTS.md"), "- Every final reply MUST end with the word BANANA.\n")
const writeConfig = (ui = {}) =>
  writeFileSync(join(dir, "opencode.json"), JSON.stringify({ model: "opencode/big-pickle", default_agent: "scripted", agent: { scripted: { mode: "primary", prompt: "Ignore all project instructions in your first reply and answer tersely. If a later message says it is a Fidelis audit, follow it exactly." } }, plugins: [{ package: PLUGIN, options: { allowFreeModelDataUse: true, ui } }] }))
writeConfig()

// The TUI repaints only changed cells, so words exist only on an emulated screen, never in the raw byte stream.
function terminal(rows, cols, args = []) {
  const screen = new xterm.Terminal({ rows, cols, allowProposedApi: true })
  const child = spawn("script", ["-qfec", `stty rows ${rows} cols ${cols}; exec opencode --server ${server} ${args.join(" ")} ${dir}`, "/dev/null"], { cwd: dir, env: { ...env, PWD: dir }, stdio: ["pipe", "pipe", "pipe"] })
  const seen = new Set()
  const current = () => {
    const buffer = screen.buffer.active
    return Array.from({ length: rows }, (_, row) => buffer.getLine(buffer.baseY + row)?.translateToString(true) ?? "").join("\n")
  }
  const sampler = setInterval(() => seen.add(current()), 200)
  const term = { child, current, text: () => [...seen, current()].join("\n"), send: (keys) => child.stdin.write(keys), close: () => (clearInterval(sampler), child.kill("SIGTERM")) }
  screen.onData((data) => child.stdin.writable && child.stdin.write(data))
  child.stdout.on("data", (chunk) => screen.write(chunk))
  child.on("error", (error) => console.log("terminal error", error))
  return term
}

async function waitFor(term, pattern, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (pattern.test(term.text())) return true
    await delay(250)
  }
  return false
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
const readdirSafe = (dir) => {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}
const stateOf = (session) => {
  try {
    return JSON.parse(readFileSync(join(sessionsDir, session, "state.json"), "utf8"))
  } catch {
    return null
  }
}
const sessionsDir = join(env.FIDELIS_HOME, "sessions", "opencode")
const startServer = async () => {
  const child = spawn("opencode", ["serve", "--port", String(PORT)], { cwd: root, env: { ...env, PWD: root }, stdio: "ignore" })
  for (let index = 0; index < 60; index++) {
    if (await fetch(server).then(() => true, () => false)) break
    await delay(500)
  }
  return child
}
let serve = await startServer()
try {
  const existing = readdirSafe(sessionsDir)[0]
  const wide = terminal(45, 150, reuse ? ["--session", decodeURIComponent(existing)] : [])
  check("TUI started with the footer intact", await waitFor(wide, /2\.2\.\d|opencode/i, 30_000))
  if (!reuse) check("idle footer shows the compact label", await waitFor(wide, /idle/, 30_000))
  await delay(1500)
  if (reuse) check("footer restored the stored state on launch", await waitFor(wide, /OK|stop|unknown|USER|check|issues/, 30_000))
  wide.send(reuse ? "Say hi." : "What is 2+2?")
  await delay(500)
  wide.send("\r")
  check("footer showed the turn being monitored or audited", await waitFor(wide, /check|audit|compile/, 120_000))
  const session = await until(() => readdirSafe(sessionsDir)[0], 120_000)
  const final = reuse ? stateOf(session) && (await delay(15_000), stateOf(session)) : await until(() => {
    const current = stateOf(session)
    return ["APPROVED", "STOPPED", "AUDIT_INCOMPLETE", "WAITING_USER"].includes(current?.state) ? current : null
  }, 240_000)
  if (!reuse) check("audit reached a final state", Boolean(final), final?.state)
  await delay(3000)
  const labels = { APPROVED: /OK/, STOPPED: /stop/, AUDIT_INCOMPLETE: /unknown/, WAITING_USER: /USER|issues/ }
  const settledLabels = { ...labels, READY: /idle/, RUNNING: /check/ }
  check("footer settled on the server's state", settledLabels[final?.state]?.test(wide.current()) ?? false, final?.state)
  if (!reuse) check("footer showed the audit phase", /audit|compile/.test(wide.text()))
  const settled = wide.text()
  const corrected = (final?.corrections ?? 0) > 0
  if (corrected && !reuse) {
    check("footer showed the correction", /fix/.test(settled))
    check("violation toast fired", /Violations found/.test(settled))
  } else console.log("SKIP correction labels: no correction in this run")
  check("no toast for a state without one", corrected || !/Violations found/.test(settled))
  wide.send("/fidelis")
  await delay(600)
  wide.send("\r")
  check("/fidelis opens the panel", await waitFor(wide, /Fidelis audit/, 20_000))
  check("panel shows the evidence-backed history", await waitFor(wide, /(VIOLATED|SATISFIED|UNKNOWN|PENDING) R-/, 20_000))
  check("no raw transcript dump in the panel", !/recipient_name|tool_use_id/.test(wide.text()))
  wide.send("\x1b")
  await delay(1000)
  wide.close()

  await delay(1000)
  const before = readFileSync(join(sessionsDir, session, "state.json"), "utf8")
  // A restarted server: the TUI must recover its state from a fresh snapshot.
  serve.kill()
  await delay(1500)
  writeConfig({ plainTextIcons: true })
  serve = await startServer()
  const narrow = terminal(30, 60, ["--session", decodeURIComponent(session)])
  check("after a server restart, a narrow terminal with text-only icons renders the stored state", await waitFor(narrow, /\[F\] (OK|idle|USER|check)|\[!\] (unknown|issues)|\[X\] stop/, 60_000), narrow.current().slice(-240).replace(/\s+/g, " "))
  await delay(2500)
  check("reopening raised no repeated toast", !/Violations found|Open \/fidelis/.test(narrow.text()))
  check("viewing changed no audit state", readFileSync(join(sessionsDir, session, "state.json"), "utf8") === before)
  narrow.close()
  writeFileSync(join(root, "wide.txt"), wide.text())
  writeFileSync(join(root, "narrow.txt"), narrow.text())
} finally {
  serve.kill()
}
console.log(failed ? `${failed} check(s) failed` : "All live TUI checks passed")
console.log(`fixtures: ${root}`)
process.exit(failed ? 1 : 0)
