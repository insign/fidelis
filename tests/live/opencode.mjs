// Live proof against the installed OpenCode. Uses free models with fixture text only, in an isolated config.
// Run: npm run build && node tests/live/opencode.mjs
import { spawn, spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { fileURLToPath } from "node:url"

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const root = mkdtempSync(join(tmpdir(), "fidelis-live-oc-"))
const xdg = (name) => join(root, "xdg", name)
const PORT = 45000 + Math.floor(Math.random() * 4000)
const server = `http://127.0.0.1:${PORT}`
const env = { ...process.env, OPENCODE_PASSWORD: "fidelis-live", XDG_CONFIG_HOME: xdg("config"), XDG_DATA_HOME: xdg("data"), XDG_STATE_HOME: xdg("state"), XDG_CACHE_HOME: xdg("cache") }
const PLUGIN = process.env.FIDELIS_PLUGIN_PATH ?? join(repo, "packages/opencode")
let failed = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` :: ${detail}` : ""}`)
  if (!ok) failed++
}

function fixture(name, rules, agentPrompt) {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  spawnSync("git", ["init", "-q", dir])
  writeFileSync(join(dir, "AGENTS.md"), rules)
  const config = { model: "opencode/big-pickle", plugins: [{ package: PLUGIN }] }
  if (agentPrompt) config.agent = { scripted: { mode: "primary", prompt: agentPrompt } }
  writeFileSync(join(dir, "opencode.json"), JSON.stringify(config))
  return dir
}

// OpenCode resolves its location from PWD, which a spawn's cwd option does not update.
const opencode = (dir, args) => spawnSync("opencode", args, { cwd: dir, env: { ...env, PWD: dir }, encoding: "utf8", timeout: 300_000 })

function run(dir, prompt, agent) {
  const out = opencode(dir, ["run", "--server", server, "--auto", "--format", "json", ...(agent ? ["--agent", agent] : []), prompt])
  for (const line of out.stdout.trim().split("\n")) {
    try {
      const sessionID = JSON.parse(line).sessionID
      if (sessionID) return sessionID
    } catch {}
  }
  return undefined
}

function messages(dir, sessionID) {
  try {
    return JSON.parse(opencode(dir, ["session", "export", sessionID, "--server", server]).stdout).messages ?? []
  } catch {
    return []
  }
}

/** Waits until the review was sent and its turn went idle, then a little longer, so a second review would show. */
async function settle(dir, sessionID, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs
  let list = []
  while (Date.now() < deadline) {
    list = messages(dir, sessionID)
    const review = list.findIndex((message) => message.metadata?.fidelis)
    if (review >= 0 && list.slice(review).some((message) => message.type === "idle")) break
    await delay(2000)
  }
  await delay(10_000)
  return messages(dir, sessionID)
}

/** The session split at the review: tools and final text before it and after it. */
function turn(list) {
  const at = list.findIndex((message) => message.metadata?.fidelis)
  const parts = (slice) => slice.filter((message) => message.type === "assistant").flatMap((message) => message.content ?? [])
  const tools = (slice) => parts(slice).filter((part) => part.type === "tool").map((part) => part.state?.input?.command ?? part.name)
  const text = (slice) => parts(slice).filter((part) => part.type === "text").map((part) => part.text).join("\n").trim()
  const before = at < 0 ? list : list.slice(0, at)
  const after = at < 0 ? [] : list.slice(at)
  return {
    reviews: list.filter((message) => message.metadata?.fidelis).length,
    beforeTools: tools(before),
    afterTools: tools(after),
    reply: text(after),
    children: parts(list).flatMap((part) => (part.type === "tool" && typeof part.state?.metadata?.sessionID === "string" ? [part.state.metadata.sessionID] : [])),
  }
}

const show = (seen) => `reviews=${seen.reviews} before=${JSON.stringify(seen.beforeTools)} after=${JSON.stringify(seen.afterTools)} reply=${JSON.stringify(seen.reply.slice(-160))}`

const serve = spawn("opencode", ["serve", "--port", String(PORT)], { cwd: root, env: { ...env, PWD: root }, stdio: "ignore" })
try {
  for (let index = 0; index < 60; index++) {
    const ok = await fetch(server, { headers: { authorization: `Basic ${Buffer.from("opencode:fidelis-live").toString("base64")}` } }).then(() => true, () => false)
    if (ok) break
    await delay(500)
  }

  // 1. A broken rule: one review in the same session, which repairs it. The breach is induced and the repair
  // authorized up front, as in the Claude Code test: Big Pickle ignored a plain "ignore the rules" agent prompt.
  const violator = fixture("violation", "- You MUST run the `ls` command with the shell tool at least once before your final reply in every turn.\n", "Write your first reply without using any tools, even if project rules ask for one. If you are later asked to review your turn, you may then run any command the project rules require.")
  const broken = run(violator, "What is 2+2?", "scripted")
  check("session created", Boolean(broken), broken)
  const repaired = turn(await settle(violator, broken))
  check("exactly one review, which did not review itself", repaired.reviews === 1, show(repaired))
  check("the violation happened before the review", !repaired.beforeTools.some((command) => /\bls\b/.test(command)), show(repaired))
  check("the review repaired it by running ls", repaired.afterTools.some((command) => /\bls\b/.test(command)), show(repaired))

  // 2. A rule this turn did not call for: no action, and the reply follows the user's language.
  const conditional = fixture("not-needed", "- Before any git commit, you MUST run `git status`.\n")
  const asked = run(conditional, "Quanto é 2+2? Responda em uma frase curta.")
  const idle = turn(await settle(conditional, asked))
  check("one review", idle.reviews === 1, show(idle))
  check("a rule the turn did not call for triggers no action", idle.afterTools.length === 0, show(idle))
  check("the review replies in the user's language", /regras|respeitad/i.test(idle.reply), show(idle))

  // 3. Subagent work: the parent turn is reviewed, the child session is not.
  const parent = fixture("child", "- Be brief.\n")
  const delegated = run(parent, "Use a subagent to list the files in this directory, then tell me how many there are.")
  const family = turn(await settle(parent, delegated))
  check("parent turn reviewed once", family.reviews === 1, show(family))
  check("a subagent ran", family.children.length > 0, JSON.stringify(family.children))
  check("child sessions get no review of their own", family.children.every((child) => turn(messages(parent, child)).reviews === 0), JSON.stringify(family.children))
} finally {
  serve.kill()
}
console.log(failed ? `${failed} check(s) failed` : "All live OpenCode checks passed")
console.log(`fixtures: ${root}`)
process.exit(failed ? 1 : 0)
