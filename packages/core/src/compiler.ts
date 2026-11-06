import { readFileSync } from "node:fs"
import type { Checklist, Config, Host, InstructionSource, Rule } from "./types.ts"
import { OBLIGATIONS } from "./types.ts"
import { COMPILER_PROMPT } from "./prompts.ts"
import { generated, parseJson, withRetry, type GenerateText } from "./providers.ts"
import { redact } from "./redact.ts"
import { canonical, sha256, type Store } from "./store.ts"

export const SCHEMA_VERSION = 1
export const COMPILER_VERSION = 1
const MIN_CONFIDENCE = 0.5

/** Ordered by the host's load order, without double-counting a file reached twice. */
export function resolveSources(sources: InstructionSource[]): InstructionSource[] {
  const seen = new Set<string>()
  return [...sources]
    .sort((a, b) => a.priority - b.priority)
    .filter((source) => {
      const key = source.path || sha256(source.text)
      if (seen.has(key) || !source.text.trim()) return false
      seen.add(key)
      return true
    })
}

export function compilerPrompt(config: Pick<Config, "compilerPromptPath">): string {
  return config.compilerPromptPath ? readFileSync(config.compilerPromptPath, "utf8") : COMPILER_PROMPT
}

export function checklistFingerprint(host: Host, sources: InstructionSource[], config: Pick<Config, "compilerModel" | "compilerEffort">, prompt: string): string {
  return sha256(
    canonical({
      schema: SCHEMA_VERSION,
      compiler: COMPILER_VERSION,
      host,
      sources: sources.map((source) => ({ path: source.path, scope: source.scope, priority: source.priority, text: source.text })),
      model: config.compilerModel,
      effort: config.compilerEffort,
      prompt: sha256(prompt),
    }),
  )
}

const normalize = (text: string) => text.replace(/\s+/g, " ").trim()
const isString = (value: unknown): value is string => typeof value === "string"

/** Schema check plus traceability: a rule whose quote is not verbatim in its source is rejected. */
export function validateRules(raw: any, sources: InstructionSource[]): { rules: Rule[]; dropped: string[] } {
  if (!raw || !Array.isArray(raw.rules)) throw new Error("compiler output lacks rules")
  const dropped: string[] = []
  const byQuote = new Map<string, Rule>()
  const localToStable = new Map<string, string>()
  const pending: { rule: Rule; raw: any }[] = []
  raw.rules.forEach((item: any, index: number) => {
    const label = String(item?.id ?? index)
    const valid =
      item &&
      isString(item.quote) &&
      isString(item.source) &&
      OBLIGATIONS.includes(item.obligation) &&
      ["applicability", "deadline", "expectedEvidence", "counterEvidence"].every((key) => isString(item[key]))
    if (!valid) return void dropped.push(`${label}: invalid shape`)
    // The verbatim quote is the traceability anchor. Models often shorten a path, so it may correct the source.
    const key = normalize(item.quote)
    const holds = (candidate: InstructionSource) => normalize(candidate.text).includes(key)
    const source = sources.find((candidate) => candidate.path === item.source && holds(candidate)) ?? sources.find(holds)
    if (!source || !key) return void dropped.push(`${label}: quote not verbatim`)
    const existing = byQuote.get(key)
    if (existing) return void localToStable.set(label, existing.id)
    const rule: Rule = {
      id: `R-${sha256(`${source.path}\0${key}`).slice(0, 10)}`,
      quote: item.quote,
      source: source.path,
      obligation: item.obligation,
      applicability: item.applicability,
      trigger: isString(item.trigger) ? item.trigger : "",
      deadline: item.deadline,
      exceptions: Array.isArray(item.exceptions) ? item.exceptions.filter(isString) : [],
      expectedEvidence: item.expectedEvidence,
      counterEvidence: item.counterEvidence,
      repairHint: isString(item.repairHint) ? item.repairHint : "",
      priority: source.priority,
      supersedable: item.supersedable === true,
      supersededBy: null,
      conflictsWith: [],
    }
    byQuote.set(key, rule)
    localToStable.set(label, rule.id)
    pending.push({ rule, raw: item })
  })
  for (const { rule, raw: item } of pending) {
    rule.supersededBy = localToStable.get(String(item.supersededBy)) ?? null
    rule.conflictsWith = (Array.isArray(item.conflictsWith) ? item.conflictsWith : []).flatMap((id: unknown) => localToStable.get(String(id)) ?? [])
  }
  const known = new Set(pending.map(({ rule }) => rule.id))
  for (const { rule } of pending) for (const other of rule.conflictsWith) if (known.has(other)) byId(pending, other).conflictsWith = [...new Set([...byId(pending, other).conflictsWith, rule.id])]
  return { rules: pending.map(({ rule }) => rule), dropped }
}

const byId = (pending: { rule: Rule }[], id: string) => pending.find(({ rule }) => rule.id === id)!.rule

export const CHECKLIST_SCHEMA = {
  type: "object",
  properties: { confidence: { type: "number" }, rules: { type: "array", items: { type: "object" } } },
  required: ["confidence", "rules"],
}

export interface CompileResult {
  checklist?: Checklist
  cacheHit: boolean
  calls: number
  tokens: number
  costUSD: number
  reason?: string
}

export async function getChecklist(input: { store: Store; host: Host; sources: InstructionSource[]; config: Config; generate: GenerateText | null; onCompile?: () => void }): Promise<CompileResult> {
  const { store, host, config, generate } = input
  const sources = resolveSources(input.sources)
  const prompt = compilerPrompt(config)
  const fingerprint = checklistFingerprint(host, sources, config, prompt)
  const cached = config.cacheChecklist ? store.getChecklist(fingerprint) : undefined
  const miss = { cacheHit: false, calls: 1, tokens: 0, costUSD: 0 }
  if (cached?.schema === SCHEMA_VERSION) return { checklist: cached, cacheHit: true, calls: 0, tokens: 0, costUSD: 0 }
  if (!generate) return { ...miss, calls: 0, reason: "No compiler model is available." }
  input.onCompile?.()
  const full = prompt + sources.map((source) => `\n--- source: ${source.path} (scope ${source.scope}) ---\n${redact(source.text)}`).join("\n")
  try {
    const output = generated(await withRetry(() => generate(full, CHECKLIST_SCHEMA), config))
    miss.tokens = output.tokens ?? 0
    miss.costUSD = output.costUSD ?? 0
    const raw = parseJson(output.text)
    const confidence = raw?.confidence
    if (typeof confidence !== "number" || !(confidence >= 0 && confidence <= 1)) return { ...miss, reason: "Compiler output has no valid confidence." }
    const { rules, dropped } = validateRules(raw, sources)
    if (confidence < MIN_CONFIDENCE) return { ...miss, reason: `Compiler confidence ${confidence} is too low.` }
    if (rules.length === 0) return { ...miss, reason: `Compiler produced no valid rules from the instructions (${dropped.length} rejected).` }
    const checklist: Checklist = { schema: SCHEMA_VERSION, fingerprint, model: config.compilerModel, compiledAt: Date.now(), rules, dropped }
    // Only a fully validated checklist is reused; a partial one is retried on the next turn.
    if (config.cacheChecklist && dropped.length === 0) store.putChecklist(checklist)
    return { ...miss, checklist }
  } catch (error) {
    return { ...miss, reason: `Checklist compilation failed: ${(error as Error).message}` }
  }
}
