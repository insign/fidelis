#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { Auditor, jevNative, resolveConfig, Store, textDecisions, type Outcome } from "@insign/fidelis"
import { buildEvidence, claudeGenerate, discoverInstructions, parseTranscript, readJsonl } from "./adapter.ts"

const HOOK_EVENTS = { SessionStart: 10, Stop: 900 }

function loadOptions(cwd: string, env = process.env) {
  const read = (path: string) => {
    try {
      return JSON.parse(readFileSync(path, "utf8"))
    } catch {
      return {}
    }
  }
  const user = read(join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "fidelis.json"))
  const project = read(join(cwd, ".claude", "fidelis.json"))
  return { ...user, ...project, ...(env.FIDELIS_CONFIG ? read(env.FIDELIS_CONFIG) : {}) }
}

export function makeAuditor(cwd: string, env = process.env) {
  const options = loadOptions(cwd, env)
  const config = resolveConfig("claude-code", options)
  const store = new Store("claude-code")
  const compiler = claudeGenerate(config.compilerModel, config.compilerEffort, config)
  // A Jev judge is used only when explicitly named and given a key. Otherwise Haiku, labeled self-reported.
  const key = env.TYPESAFE_API_KEY ?? env.FIDELIS_JEV_API_KEY
  const judge = config.judgeModel.startsWith("jev")
    ? key
      ? jevNative({ apiKey: key, model: config.judgeModel })
      : null
    : textDecisions(claudeGenerate(config.judgeModel, config.judgeEffort, config), config.judgeModel)
  return { config, store, auditor: new Auditor({ store, host: "claude-code", config, options, compiler, judge }) }
}

/** The transcript writer lags the hook. Give it a moment before reading the final records. */
function settle(path: string, finalReply: string) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const tail = readJsonl(path).filter((record) => record.type === "assistant").at(-1)
    const text = (tail?.message?.content ?? []).map((part: any) => part?.text ?? "").join("")
    if (text.trim() === finalReply.trim()) return
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 125)
  }
}

export async function handleStop(input: any, env = process.env): Promise<object | null> {
  if (input.agent_id) return null
  if ((input.background_tasks ?? []).some((task: any) => task.status === "running" || task.status === "pending")) return null
  const { auditor, config } = makeAuditor(input.cwd, env)
  if (!config.enabled) return null
  const finalReply = input.last_assistant_message ?? ""
  settle(input.transcript_path, finalReply)
  const { parsed, evidence } = buildEvidence(input.transcript_path, finalReply)
  for (const message of parsed.messages) auditor.userMessage(input.session_id, message)
  const sources = parsed.sources.length ? parsed.sources : discoverInstructions(input.cwd, parsed.version, env)
  const outcome = await auditor.complete(input.session_id, { sources, evidence, boundaryKey: `${input.prompt_id ?? ""}:${input.stop_hook_active === true}` })
  return outputFor(outcome)
}

export function outputFor(outcome: Outcome): object | null {
  if (outcome.action === "correct") return { hookSpecificOutput: { hookEventName: "Stop", additionalContext: outcome.text } }
  if (outcome.action === "wait") return outcome.notice ? { systemMessage: outcome.notice } : null
  return outcome.notice ? { systemMessage: outcome.notice } : null
}

async function hook() {
  // A nested compiler or judge process must never audit itself.
  if (process.env.FIDELIS_NESTED) return
  const input = JSON.parse(readFileSync(0, "utf8"))
  if (input.hook_event_name === "SessionStart") {
    const { store, config } = makeAuditor(input.cwd)
    store.cleanup(config.retentionDays)
    return
  }
  if (input.hook_event_name !== "Stop") return
  const output = await handleStop(input)
  if (output) process.stdout.write(JSON.stringify(output))
}

function settingsPath(project: boolean) {
  return project ? join(process.cwd(), ".claude", "settings.json") : join(process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json")
}

function install(remove: boolean, project: boolean) {
  const path = settingsPath(project)
  const settings = existsSync(path) ? JSON.parse(readFileSync(path, "utf8")) : {}
  const command = `node "${realpathSync(fileURLToPath(import.meta.url))}" hook`
  settings.hooks ??= {}
  for (const [event, timeout] of Object.entries(HOOK_EVENTS)) {
    const kept = (settings.hooks[event] ?? []).filter((entry: any) => !(entry.hooks ?? []).some((hook: any) => /fidelis/i.test(hook.command ?? "")))
    settings.hooks[event] = remove ? kept : [...kept, { hooks: [{ type: "command", command, timeout }] }]
    if (settings.hooks[event].length === 0) delete settings.hooks[event]
  }
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(`${path}.tmp`, JSON.stringify(settings, null, 2) + "\n")
  renameSync(`${path}.tmp`, path)
  console.log(`${remove ? "Removed Fidelis hooks from" : "Installed Fidelis hooks in"} ${path}`)
}

function status(sessionID: string | undefined) {
  if (!sessionID) return console.error("usage: fidelis-claude-code status <session-id>")
  const { auditor } = makeAuditor(process.cwd())
  console.log(JSON.stringify(auditor.status(sessionID), null, 2))
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, argument] = process.argv.slice(2)
  const project = process.argv.includes("--project")
  if (command === "hook") {
    await hook().catch((error) => {
      // A broken auditor must never wedge the session.
      process.stdout.write(JSON.stringify({ systemMessage: `Fidelis audit incomplete: ${String(error?.message ?? error).slice(0, 300)}` }))
    })
  } else if (command === "install") install(false, project)
  else if (command === "uninstall") install(true, project)
  else if (command === "status") status(argument)
  else console.error("usage: fidelis-claude-code <install|uninstall|status <session-id>|hook> [--project]")
}

export { parseTranscript }
