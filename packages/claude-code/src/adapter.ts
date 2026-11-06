import { spawn } from "node:child_process"
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, dirname, isAbsolute, join, resolve } from "node:path"
import type { Config, Evidence, ExecEvent, GenerateText, InstructionSource, MessageOrigin } from "fidelis"

const PROMPT_ORIGINS = new Set<MessageOrigin>(["human", "sdk"])

function originOf(record: any): MessageOrigin {
  if (record.origin?.kind === "human" || record.turnOrigin === "human") return "human"
  if (record.turnOrigin === "sdk" || record.promptSource === "sdk") return "sdk"
  return "synthetic"
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((part: any) => (typeof part === "string" ? part : part?.type === "text" ? part.text : "")).filter(Boolean).join("\n")
}

const toMillis = (stamp: unknown) => (typeof stamp === "string" ? Date.parse(stamp) : undefined)

export function readJsonl(path: string): any[] {
  try {
    return readFileSync(path, "utf8").split("\n").flatMap((line) => {
      if (!line.trim()) return []
      try {
        return [JSON.parse(line)]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export interface ParsedTranscript {
  sources: InstructionSource[]
  messages: { id: string; origin: MessageOrigin }[]
  events: ExecEvent[]
  /** Events from the most recent human or SDK prompt onward. */
  userRequest: string
  history: ExecEvent[]
  danglingTools: string[]
  version?: string
}

/** Effective instructions come from what the host recorded, so nothing is inferred from file existence. */
export function parseTranscript(records: any[], actor: "agent" | "subagent" = "agent"): ParsedTranscript {
  const events: ExecEvent[] = []
  const messages: ParsedTranscript["messages"] = []
  const tools = new Map<string, ExecEvent>()
  const sourceMap = new Map<string, InstructionSource>()
  let userRequest = ""
  let windowStart = 0
  let version: string | undefined
  let priority = 0

  const addSource = (path: string, scope: string, text: unknown) => {
    if (typeof path !== "string" || typeof text !== "string") return
    sourceMap.set(path, { path, scope, priority: sourceMap.get(path)?.priority ?? priority++, text })
  }

  for (const record of records) {
    const at = toMillis(record.timestamp)
    version ??= record.version
    if (record.type === "attachment") {
      const attachment = record.attachment ?? {}
      if (attachment.type === "instructions") for (const file of attachment.files ?? []) addSource(file.path, String(file.type ?? "unknown").toLowerCase(), file.content)
      if (attachment.type === "nested_memory" || attachment.type === "memory") addSource(attachment.path, "nested", attachment.content?.content ?? attachment.content)
      if (attachment.type === "queued_command" && attachment.humanTurn === true && attachment.origin?.kind === "human") {
        // Evidence only: a mid-turn steer must not restart the turn or its correction budget.
        events.push({ id: attachment.source_uuid ?? record.uuid, seq: 0, at, kind: "user", text: textOf(attachment.prompt) })
      }
      if (attachment.type === "hook_additional_context" && attachment.hookEvent === "Stop") events.push({ id: record.uuid, seq: 0, at, kind: "fidelis", text: textOf(attachment.content) })
      // Observed on 2.1.318: the built-in AGENTS.md reader injects nested files through a tool-call hook.
      if (attachment.type === "hook_additional_context" && attachment.hookName === "tool.call") {
        const nested = textOf(attachment.content).match(/^Contents of (\S*AGENTS\.md):\n\n([\s\S]*)$/)
        if (nested) addSource(nested[1], "nested", nested[2])
      }
      continue
    }
    if (record.type === "user" && !record.isMeta) {
      const content = record.message?.content
      const results = Array.isArray(content) ? content.filter((part: any) => part?.type === "tool_result") : []
      for (const result of results) {
        const tool = tools.get(result.tool_use_id)
        if (!tool) continue
        tool.output = textOf(result.content)
        tool.status = result.is_error ? "failed" : "completed"
      }
      if (results.length) continue
      const origin = originOf(record)
      messages.push({ id: record.uuid, origin })
      if (PROMPT_ORIGINS.has(origin)) {
        userRequest = textOf(content)
        windowStart = events.length
      }
      events.push({ id: record.uuid, seq: 0, at, kind: PROMPT_ORIGINS.has(origin) ? "user" : "system", text: textOf(content) })
      continue
    }
    if (record.type === "assistant") {
      for (const part of record.message?.content ?? []) {
        if (part?.type === "text" && part.text) events.push({ id: `${record.uuid}:text`, seq: 0, at, kind: "assistant", actor, text: part.text })
        if (part?.type === "tool_use") {
          const tool: ExecEvent = { id: part.id, seq: 0, at, kind: "tool", actor, name: part.name, input: part.input, status: "running" }
          tools.set(part.id, tool)
          events.push(tool)
        }
      }
    }
  }
  const windowed = events.slice(windowStart)
  return {
    sources: [...sourceMap.values()],
    messages,
    events: windowed,
    userRequest,
    history: events.slice(0, windowStart).filter((event) => event.kind !== "fidelis"),
    danglingTools: windowed.filter((event) => event.kind === "tool" && event.status === "running").map((event) => event.id),
    version,
  }
}

/** Sidechain transcripts of this session, attributed and limited to the audited window. */
export function subagentEvents(transcriptPath: string, since: number): ExecEvent[] {
  const dir = join(dirname(transcriptPath), basename(transcriptPath, ".jsonl"), "subagents")
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((name) => name.endsWith(".jsonl"))
    .flatMap((name) => {
      const { events } = parseTranscript(readJsonl(join(dir, name)).map((record) => ({ ...record, isMeta: record.type === "user" && !Array.isArray(record.message?.content) ? true : record.isMeta })), "subagent")
      return events.filter((event) => event.kind === "tool" && (event.at ?? 0) >= since).map((event) => ({ ...event, id: `${name}:${event.id}` }))
    })
}

export function buildEvidence(transcriptPath: string, finalReply: string): { parsed: ParsedTranscript; evidence: Evidence } {
  const records = readJsonl(transcriptPath)
  const parsed = parseTranscript(records)
  const since = parsed.events[0]?.at ?? 0
  const events = [...parsed.events, ...subagentEvents(transcriptPath, since)]
  const lastText = [...parsed.events].reverse().find((event) => event.kind === "assistant")
  if (lastText?.text?.trim() !== finalReply.trim() && finalReply) events.push({ id: `final:${records.length}`, seq: 0, at: Date.now(), kind: "assistant", actor: "agent", text: finalReply })
  events.sort((a, b) => (a.at ?? 0) - (b.at ?? 0)).forEach((event, seq) => (event.seq = seq))
  const gaps: string[] = []
  if (records.length === 0) gaps.push("transcript unavailable")
  if (parsed.danglingTools.length) gaps.push(`${parsed.danglingTools.length} tool result(s) not yet recorded`)
  return { parsed, evidence: { userRequest: parsed.userRequest, events, history: parsed.history, finalReply, complete: gaps.length === 0, gaps } }
}

// Fallback for hosts that do not record loaded instructions. Follows the documented load matrix.
const IMPORT = /(?:^|\s)@((?:\\ |[^\s`])+)/g

function expandImports(path: string, text: string, depth: number, out: Map<string, { scope: string; text: string }>, scope: string) {
  if (depth > 4) return
  const stripped = text.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "")
  for (const match of stripped.matchAll(IMPORT)) {
    const target = match[1].replace(/\\ /g, " ")
    const absolute = target.startsWith("~/") ? join(homedir(), target.slice(2)) : isAbsolute(target) ? target : resolve(dirname(path), target)
    addFile(absolute, depth + 1, out, scope)
  }
}

function addFile(path: string, depth: number, out: Map<string, { scope: string; text: string }>, scope: string) {
  if (!existsSync(path)) return
  let real: string
  try {
    real = realpathSync(path)
    if (out.has(real)) return
    const text = readFileSync(real, "utf8")
    out.set(real, { scope, text })
    expandImports(real, text, depth, out, scope)
  } catch {
    // An unreadable instruction file is not loaded by the host either.
  }
}

export function instructionMode(env: NodeJS.ProcessEnv = process.env): string {
  const settingsPath = join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "settings.json")
  try {
    const configs = JSON.parse(readFileSync(settingsPath, "utf8")).pluginConfigs ?? {}
    return (configs["cc-plugin-agents-md@builtin"] ?? configs["agents-md@builtin"])?.options?.instructionFiles ?? "claude-md-or-agents-md"
  } catch {
    return "claude-md-or-agents-md"
  }
}

function rulesIn(dir: string): string[] {
  if (!existsSync(dir)) return []
  return readdirSync(dir, { recursive: true, encoding: "utf8" })
    .filter((name) => name.endsWith(".md"))
    .sort()
    .map((name) => join(dir, name))
    .filter((path) => !/^---[\s\S]*?\npaths:/.test(readFileSync(path, "utf8")))
}

export function discoverInstructions(cwd: string, version: string | undefined, env: NodeJS.ProcessEnv = process.env): InstructionSource[] {
  const mode = instructionMode(env)
  const home = env.HOME ?? homedir()
  const config = env.CLAUDE_CONFIG_DIR ?? join(home, ".claude")
  const out = new Map<string, { scope: string; text: string }>()
  const chain: string[] = []
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    chain.unshift(dir)
    if (dir === dirname(dir)) break
  }
  if (mode === "managed-only") return []
  addFile(join(config, "CLAUDE.md"), 0, out, "user")
  for (const rule of rulesIn(join(config, "rules"))) addFile(rule, 0, out, "user")
  const claudeNames = ["CLAUDE.md", ".claude/CLAUDE.md", "CLAUDE.local.md"]
  const hasClaude = chain.some((dir) => dir !== home && claudeNames.some((name) => existsSync(join(dir, name))))
  const native = !version || compareVersions(version, "2.1.277") >= 0
  const loadAgents = native && (mode === "claude-md-and-agents-md" || (mode === "claude-md-or-agents-md" && !hasClaude))
  for (const dir of chain) {
    if (dir !== home) for (const name of claudeNames) addFile(join(dir, name), 0, out, name.includes("local") ? "local" : "project")
    if (loadAgents) for (const name of ["AGENTS.md", ".claude/AGENTS.md"]) addFile(join(dir, name), 0, out, "project")
    for (const rule of rulesIn(join(dir, ".claude", "rules"))) addFile(rule, 0, out, "project")
  }
  return [...out].map(([path, value], priority) => ({ path, scope: value.scope, priority, text: value.text }))
}

export function compareVersions(a: string, b: string): number {
  const left = a.split(".").map(Number)
  const right = b.split(".").map(Number)
  for (let index = 0; index < 3; index++) if ((left[index] ?? 0) !== (right[index] ?? 0)) return (left[index] ?? 0) - (right[index] ?? 0)
  return 0
}

/** Nested Claude isolated from settings, hooks, tools and project instructions so it cannot recurse. */
export function claudeGenerate(model: string, effort: string, config: Pick<Config, "timeoutMs">, command = process.env.FIDELIS_CLAUDE_BIN ?? "claude"): GenerateText {
  return (prompt, schema) =>
    new Promise((done, fail) => {
      const args = ["-p", "--model", model, "--output-format", "json", "--no-session-persistence", "--setting-sources", "", "--settings", '{"disableAllHooks":true}', "--tools", "", "--disable-slash-commands", "--strict-mcp-config", "--system-prompt", "You output only the requested JSON."]
      if (effort && effort !== "default") args.push("--effort", effort)
      if (schema) args.push("--json-schema", JSON.stringify(schema))
      const child = spawn(command, args, { cwd: tmpdir(), env: { ...process.env, FIDELIS_NESTED: "1" }, stdio: ["pipe", "pipe", "pipe"], timeout: config.timeoutMs })
      let stdout = ""
      let stderr = ""
      child.stdout.on("data", (chunk) => (stdout += chunk))
      child.stderr.on("data", (chunk) => (stderr += chunk))
      child.on("error", (error: NodeJS.ErrnoException) => fail(error.code === "ENOENT" ? new Error(`${command} was not found. On Windows, an npm .cmd install cannot be spawned directly: set FIDELIS_CLAUDE_BIN to claude.exe.`) : error))
      // A child that exits before reading the prompt raises EPIPE here; "close" reports the real failure.
      child.stdin.on("error", () => {})
      child.on("close", (code) => {
        try {
          const result = JSON.parse(stdout)
          if (result.is_error) return fail(Object.assign(new Error(String(result.result ?? "claude reported an error").slice(0, 300)), { costUSD: result.total_cost_usd }))
          const usage = result.usage ?? {}
          done({
            text: result.structured_output ? JSON.stringify(result.structured_output) : String(result.result),
            tokens: (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0),
            costUSD: typeof result.total_cost_usd === "number" ? result.total_cost_usd : undefined,
          })
        } catch {
          fail(new Error(`claude exited ${code}: ${(stderr || stdout).slice(0, 300)}`))
        }
      })
      child.stdin.end(prompt)
    })
}
