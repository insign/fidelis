import type { Evidence, ExecEvent, InstructionSource, MessageOrigin } from "fidelis"

const HEADER = /^Instructions from: (.+)$/gm

/** OpenCode renders loaded files as "Instructions from: <path>" blocks. Observed in core/instructions and nested synthetic messages. */
export function parseInstructionBlocks(text: string): { path: string; text: string }[] {
  const matches = [...text.matchAll(HEADER)]
  return matches.map((match, index) => ({
    path: match[1].trim(),
    text: text.slice(match.index + match[0].length, matches[index + 1]?.index ?? text.length).trim(),
  }))
}

export function messageOrigin(message: any): MessageOrigin {
  if (message.type !== "user") return message.type === "synthetic" ? "synthetic" : "agent"
  return message.metadata?.fidelis ? "fidelis" : "human"
}

export function effectiveSources(ambient: string | undefined, messages: readonly any[], nested: Map<string, string>): InstructionSource[] {
  const sources: InstructionSource[] = []
  for (const block of parseInstructionBlocks(ambient ?? "")) sources.push({ path: block.path, scope: "ambient", priority: sources.length, text: block.text })
  for (const message of messages) {
    if (message.type === "synthetic" && message.metadata?.instruction) for (const block of parseInstructionBlocks(message.text ?? "")) nested.set(block.path, block.text)
  }
  for (const [path, text] of nested) sources.push({ path, scope: "nested", priority: sources.length, text })
  return sources
}

const STATUS: Record<string, ExecEvent["status"]> = { completed: "completed", error: "failed", running: "running", streaming: "running", pending: "running" }

function toolOutput(state: any): string | undefined {
  const text = (state?.content ?? []).map((part: any) => part?.text ?? "").filter(Boolean).join("\n")
  return text || state?.error?.message
}

/** Normalize one session's messages. Reasoning is never read. */
export function toEvents(messages: readonly any[], actor: "agent" | "subagent" = "agent"): ExecEvent[] {
  const events: ExecEvent[] = []
  for (const message of messages) {
    const at = message.time?.created
    if (message.type === "user") events.push({ id: message.id, seq: 0, at, kind: message.metadata?.fidelis ? "fidelis" : "user", text: message.text })
    if (message.type === "shell") events.push({ id: message.id, seq: 0, at, kind: "tool", actor: "agent", name: "user-shell", input: message.command, output: message.output, status: "completed" })
    if (message.type !== "assistant") continue
    // Parts keep their order: a text part written after a tool cannot sort ahead of it.
    let last = at
    ;(message.content ?? []).forEach((part: any, index: number) => {
      last = Math.max(last ?? 0, part.time?.created ?? 0) || last
      if (part.type === "text" && part.text) events.push({ id: `${message.id}:text:${index}`, seq: events.length, at: last, kind: "assistant", actor, text: part.text })
      if (part.type === "tool") events.push({ id: part.id, seq: events.length, at: last, kind: "tool", actor, name: part.name, input: part.state?.input, output: toolOutput(part.state), status: STATUS[part.state?.status] ?? "unknown" })
    })
  }
  return events
}

export interface Boundary {
  key: string
  finalReply: string
}

/** session.execution.succeeded is only a candidate: require a finished final reply, no live tools, and the matching idle record. */
export function finalBoundary(messages: readonly any[]): Boundary | null {
  const meaningful = messages.filter((message) => message.type !== "system")
  const last = meaningful.at(-1)
  if (last?.type !== "idle" || last.outcome !== "succeeded") return null
  const assistant = [...meaningful].reverse().find((message) => message.type === "assistant")
  if (!assistant || assistant.finish !== "stop") return null
  if (meaningful.indexOf(assistant) < meaningful.findLastIndex((message) => message.type === "user")) return null
  if ((assistant.content ?? []).some((part: any) => part.type === "tool" && part.state?.status !== "completed" && part.state?.status !== "error")) return null
  const finalReply = (assistant.content ?? []).filter((part: any) => part.type === "text").map((part: any) => part.text).join("\n")
  return { key: assistant.id, finalReply }
}

export function windowOf(messages: readonly any[]): readonly any[] {
  const start = messages.findLastIndex((message) => messageOrigin(message) === "human")
  return start < 0 ? messages : messages.slice(start)
}

/** Child session IDs reported by tool metadata. Only causally linked children count as evidence. */
export function childSessions(messages: readonly any[]): string[] {
  const ids = new Set<string>()
  for (const message of messages) {
    if (message.type !== "assistant") continue
    for (const part of message.content ?? []) {
      const id = part.type === "tool" ? part.state?.metadata?.sessionID : undefined
      if (typeof id === "string") ids.add(id)
    }
  }
  return [...ids]
}

/** Partition from the ledger, which keeps the turn's opening message even after the host compacts it away. */
export function buildEvidence(messages: readonly any[], boundary: Boundary, retained: ExecEvent[], ledgerCovered: boolean): Evidence {
  const gaps: string[] = []
  if (messages.some((message) => message.type === "compaction") && !ledgerCovered) gaps.push("the host compacted history before Fidelis retained it")
  const start = retained.findLastIndex((event) => event.kind === "user")
  if (start < 0) gaps.push("the message that opened this turn is not available")
  return {
    userRequest: start < 0 ? "" : (retained[start].text ?? ""),
    // Unknown turn membership stays context: it can show compliance but can never be accused.
    events: start < 0 ? [] : retained.slice(start),
    history: start < 0 ? retained : retained.slice(0, start),
    finalReply: boundary.finalReply,
    complete: gaps.length === 0,
    gaps,
  }
}

/**
 * Text transport for the compiler. On 2.2.5 `ctx.experimental.generate.text` is refused for free models, while
 * `session.generate` on a session pinned to the model works, adds no messages and runs no tools.
 */
export async function generateViaTempSession(ctx: any, temp: Set<string>, model: string, prompt: string): Promise<string> {
  const slash = model.indexOf("/")
  const input = { title: "fidelis", model: { providerID: model.slice(0, slash), id: model.slice(slash + 1) }, metadata: { fidelis: { origin: "fidelis" } } }
  // The built-in plan agent keeps a user's custom default persona out of the compiler's context.
  const created = await ctx.session.create({ ...input, agent: "plan" }).catch(() => ctx.session.create(input))
  temp.add(created.id)
  try {
    const { text } = await ctx.session.generate({ sessionID: created.id, prompt })
    if (!text) throw new Error("model returned no text")
    return text
  } finally {
    await ctx.session.remove({ sessionID: created.id }).catch(() => {})
    temp.delete(created.id)
  }
}
