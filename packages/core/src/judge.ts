import { readFileSync } from "node:fs"
import type { Checklist, Config, Evidence, ExecEvent, Finding, Rule } from "./types.ts"
import { JUDGE_PREAMBLE, QUESTIONS } from "./prompts.ts"
import { withRetry, type Answer, type DecisionModel, type Question } from "./providers.ts"
import { redact } from "./redact.ts"

const CHUNK = 100
const MAX_CHOICES = 250
const MIN_SATISFIED = 0.6
const CLIP_STEPS = [2000, 500, 120]
const HISTORY_CLIP = 120
const HISTORY_SHARE = 0.3

export class EvidenceTooLarge extends Error {}

function clip(text: string, limit: number) {
  return text.length <= limit ? text : `${text.slice(0, limit)}…[clipped ${text.length - limit} chars]`
}

function eventLine(event: ExecEvent, limit: number) {
  const parts = [`#${event.seq} id=${event.id} ${event.kind}`]
  if (event.actor) parts.push(`actor=${event.actor}`)
  if (event.name) parts.push(`name=${event.name}`)
  if (event.status) parts.push(`status=${event.status}`)
  if (event.input !== undefined) parts.push(`input=${clip(typeof event.input === "string" ? event.input : JSON.stringify(event.input), limit)}`)
  if (event.output) parts.push(`output=${clip(event.output, limit)}`)
  if (event.text) parts.push(`text=${clip(event.text, limit)}`)
  return redact(parts.join(" "))
}

/**
 * The turn is clipped loudly and never loses an event: over budget means an incomplete audit. Older context may be
 * omitted to fit, and the digest then says so, because a missing event can no longer prove anything.
 */
export function digest(evidence: Evidence, prior: Finding[], budgetChars: number, rawIDs: ReadonlySet<string> = new Set(), preamble = JUDGE_PREAMBLE) {
  const history = evidence.history ?? []
  const historyLines: string[] = []
  let used = 0
  for (const event of [...history].reverse()) {
    const line = eventLine(event, HISTORY_CLIP)
    if (used + line.length > budgetChars * HISTORY_SHARE) break
    used += line.length
    historyLines.unshift(line)
  }
  const omitted = history.length - historyLines.length
  const complete = evidence.complete && omitted === 0
  const gaps = [...evidence.gaps, ...(omitted ? [`${omitted} older events omitted to fit the budget`] : [])]
  const head = [
    preamble,
    `Evidence source: ${complete ? "known complete" : `INCOMPLETE (${gaps.join("; ") || "unknown gaps"})`}.`,
    `Current user request: ${redact(clip(evidence.userRequest, 4000))}`,
    prior.length ? `Unresolved findings from the previous audit of this turn: ${prior.map((finding) => `${finding.ruleID}: ${clip(finding.quote, 200)}`).join(" | ")}` : "",
    historyLines.length ? `Earlier turns, context only${omitted ? ` (${omitted} older events omitted)` : ""}:\n${historyLines.join("\n")}` : "",
    "Events of the turn under audit:",
  ].filter(Boolean)
  for (const limit of CLIP_STEPS) {
    const lines = evidence.events.map((event) => eventLine(event, rawIDs.has(event.id) ? budgetChars : limit))
    const text = [...head, ...lines, `Final reply: ${redact(clip(evidence.finalReply, 8000))}`].join("\n")
    if (text.length <= budgetChars) return { text, clipped: limit !== CLIP_STEPS[0] || text.includes("…[clipped"), complete }
  }
  throw new EvidenceTooLarge(`Evidence for ${evidence.events.length} events exceeds the audit budget of ${budgetChars} characters.`)
}

function ruleText(rule: Rule) {
  return `Rule (${rule.obligation}) from ${rule.source}: "${rule.quote}". Applies when: ${rule.applicability}. Deadline: ${rule.deadline}.${rule.exceptions.length ? ` Exceptions: ${rule.exceptions.join("; ")}.` : ""} Compliance looks like: ${rule.expectedEvidence}. A breach looks like: ${rule.counterEvidence}.`
}

export interface JudgeResult {
  findings: Finding[]
  waiting: boolean
  calls: number
  tokens: number
  costUSD: number
}

export function judgePreamble(config: Pick<Config, "judgePromptPath">) {
  return config.judgePromptPath ? readFileSync(config.judgePromptPath, "utf8") : JUDGE_PREAMBLE
}

export async function judge(input: { checklist: Checklist; evidence: Evidence; prior: Finding[]; model: DecisionModel; config: Config }): Promise<JudgeResult> {
  const { checklist, evidence, prior, model, config } = input
  const budget = config.maxAuditTokens * 4
  const preamble = judgePreamble(config)
  const first = digest(evidence, prior, budget, new Set(), preamble)
  const result: JudgeResult = { findings: [], waiting: false, calls: 0, tokens: 0, costUSD: 0 }

  const ask = async (state: string, questions: Question[]) => {
    const answers: Record<string, Answer> = {}
    for (let index = 0; index < questions.length; index += CHUNK) {
      const decisions = await withRetry(() => model.ask(state, questions.slice(index, index + CHUNK)), config)
      Object.assign(answers, decisions.answers)
      result.calls += 1
      result.tokens += decisions.tokens ?? 0
      result.costUSD += decisions.costUSD ?? 0
    }
    return answers
  }
  const predicate = (name: string, rule: Rule, text: string): Question => ({ type: "predicate", name, instructions: `${ruleText(rule)}\nQuestion: ${text}` })

  const finding = (rule: Rule, status: Finding["status"], explanation: string, extra: Partial<Finding> = {}): Finding => ({
    ruleID: rule.id,
    status,
    quote: rule.quote,
    source: rule.source,
    obligation: rule.obligation,
    explanation,
    evidence: [],
    severity: rule.obligation === "OTHER" ? "low" : "high",
    ...extra,
  })

  const done = new Map<string, Finding>()
  const open: Rule[] = []
  for (const rule of checklist.rules) {
    if (rule.conflictsWith.length) done.set(rule.id, finding(rule, "UNKNOWN", `Unresolved conflict with ${rule.conflictsWith.join(", ")}.`, { uncertainty: "conflicting mandatory rules" }))
    else open.push(rule)
  }

  // Stage 1: scope. Unknown answers stay UNKNOWN; they never become a failure.
  const scope = await ask(first.text, [
    { type: "predicate", name: "turn_waiting", instructions: QUESTIONS.waiting },
    ...open.flatMap((rule, i) => [predicate(`r${i}_applies`, rule, QUESTIONS.applies), predicate(`r${i}_deadline`, rule, QUESTIONS.deadline)]),
  ])
  result.waiting = (scope.turn_waiting?.p ?? 0) >= 0.5
  const applying = new Set(open.filter((_, i) => (scope[`r${i}_applies`]?.p ?? 1) >= 0.5).map((rule) => rule.id))
  const candidates: { rule: Rule; i: number }[] = []
  open.forEach((rule, i) => {
    const applies = scope[`r${i}_applies`]?.p
    const deadline = scope[`r${i}_deadline`]?.p
    if (applies === undefined || deadline === undefined) return void done.set(rule.id, finding(rule, "UNKNOWN", "The decision model gave no answer.", { uncertainty: scope[`r${i}_applies`]?.error ?? scope[`r${i}_deadline`]?.error ?? "missing answer" }))
    if (applies < 0.5) return void done.set(rule.id, finding(rule, "NOT_APPLICABLE", "Does not govern this turn.", { probability: applies }))
    if (rule.supersededBy && applying.has(rule.supersededBy)) return void done.set(rule.id, finding(rule, "NOT_APPLICABLE", `Superseded by applicable rule ${rule.supersededBy}.`))
    if (deadline < 0.5) return void done.set(rule.id, finding(rule, "PENDING", "Its deadline has not occurred at this boundary.", { probability: deadline }))
    candidates.push({ rule, i })
  })

  // Stage 2: verdict.
  const verdict = await ask(
    first.text,
    candidates.flatMap(({ rule, i }) => [predicate(`r${i}_violated`, rule, QUESTIONS.violated), predicate(`r${i}_satisfied`, rule, QUESTIONS.satisfied), predicate(`r${i}_absence`, rule, QUESTIONS.absence)]),
  )

  // Citation: only events the host recorded count. A breach must be in this turn; compliance may be earlier.
  const inTurn = evidence.events.filter((event) => event.kind !== "fidelis").slice(-MAX_CHOICES)
  const everywhere = [...(evidence.history ?? []), ...evidence.events].filter((event) => event.kind !== "fidelis").slice(-MAX_CHOICES)
  const known = new Set(inTurn.map((event) => event.id))
  const knownAnywhere = new Set(everywhere.map((event) => event.id))
  const cite = (name: string, rule: Rule, text: string, events = inTurn): Question => ({
    type: "choice",
    name,
    instructions: `${ruleText(rule)}\nQuestion: ${text}`,
    choices: events.map((event) => ({ value: event.id, description: clip(eventLine(event, 160), 240) })),
  })

  // Ambiguous verdicts get one recheck with the disputed spans unclipped.
  const ambiguous = candidates.filter(({ i }) => {
    const p = verdict[`r${i}_violated`]?.p ?? 0
    return p >= 0.5 && p < config.minViolationConfidence
  })
  if (first.clipped && ambiguous.length && inTurn.length) {
    const spans = await ask(first.text, ambiguous.map(({ rule, i }) => cite(`r${i}_span`, rule, "Which event most directly bears on whether this rule was breached?")))
    const raw = new Set(ambiguous.flatMap(({ i }) => spans[`r${i}_span`]?.choice ?? []))
    try {
      const again = await ask(digest(evidence, prior, budget * 2, raw, preamble).text, ambiguous.map(({ rule, i }) => predicate(`r${i}_violated`, rule, QUESTIONS.violated)))
      Object.assign(verdict, again)
    } catch (error) {
      if (!(error instanceof EvidenceTooLarge)) throw error
    }
  }

  const breached: typeof candidates = []
  const complied: typeof candidates = []
  for (const candidate of candidates) {
    const { rule, i } = candidate
    const violated = verdict[`r${i}_violated`]?.p
    const satisfied = verdict[`r${i}_satisfied`]?.p ?? 0
    if (violated === undefined) done.set(rule.id, finding(rule, "UNKNOWN", "The decision model gave no answer.", { uncertainty: verdict[`r${i}_violated`]?.error ?? "missing answer" }))
    else if (violated >= config.minViolationConfidence) {
      if ((verdict[`r${i}_absence`]?.p ?? 1) >= 0.5 && !first.complete) done.set(rule.id, finding(rule, "UNKNOWN", "The breach rests only on missing events and the evidence source is incomplete.", { probability: violated, uncertainty: "incomplete evidence" }))
      else breached.push(candidate)
    } else if (violated >= 0.5) done.set(rule.id, finding(rule, "UNKNOWN", "A breach is possible but below the action threshold.", { probability: violated, uncertainty: "ambiguous verdict" }))
    else if (satisfied >= MIN_SATISFIED) complied.push(candidate)
    else done.set(rule.id, finding(rule, "UNKNOWN", "Neither compliance nor a breach is supported by the evidence.", { probability: satisfied, uncertainty: "insufficient evidence" }))
  }

  // Stage 3: evidence and repair routing, asked only for what needs them.
  const reported = new Set(prior.map((finding) => finding.ruleID))
  const detail = everywhere.length
    ? await ask(first.text, [
        ...breached.flatMap(({ rule, i }) => [
          cite(`r${i}_cite`, rule, "Which event is the strongest evidence of the breach?"),
          predicate(`r${i}_repairable`, rule, QUESTIONS.repairable),
          predicate(`r${i}_user`, rule, QUESTIONS.needsUser),
          ...(reported.has(rule.id) ? [predicate(`r${i}_repaired`, rule, QUESTIONS.repaired), cite(`r${i}_fix`, rule, "Which event best shows the repair or acknowledgement?")] : []),
        ]),
        ...complied.map(({ rule, i }) => cite(`r${i}_cite`, rule, "Which event is the strongest evidence of compliance?", everywhere)),
      ])
    : {}
  const describe = (id: string) => {
    const event = everywhere.find((candidate) => candidate.id === id)
    return event ? clip(eventLine(event, 160), 240) : id
  }
  for (const { rule, i } of breached) {
    const p = verdict[`r${i}_violated`].p!
    const cited = detail[`r${i}_cite`]?.choice
    if (!cited || !known.has(cited)) {
      done.set(rule.id, finding(rule, "UNKNOWN", "A breach was suggested without citable evidence.", { probability: p, uncertainty: "no valid citation" }))
      continue
    }
    const user = detail[`r${i}_user`]?.p
    const repairable = detail[`r${i}_repairable`]?.p
    const repair = user === undefined || repairable === undefined || user >= 0.5 ? "user" : repairable < 0.5 ? "unrepairable" : "safe"
    const fix = detail[`r${i}_fix`]?.choice
    const resolved = (detail[`r${i}_repaired`]?.p ?? 0) >= MIN_SATISFIED && Boolean(fix) && known.has(fix!)
    done.set(
      rule.id,
      finding(rule, "VIOLATED", `Judged breached (p=${p}, ${model.confidenceKind}). Evidence: ${describe(cited)}${resolved ? ` Repaired or acknowledged: ${describe(fix!)}` : ""}`, {
        evidence: resolved ? [...new Set([cited, fix!])] : [cited],
        probability: p,
        confidenceKind: model.confidenceKind,
        repair,
        repairHint: rule.repairHint,
        resolved,
      }),
    )
  }
  for (const { rule, i } of complied) {
    const p = verdict[`r${i}_satisfied`].p!
    const cited = detail[`r${i}_cite`]?.choice
    if (cited && knownAnywhere.has(cited)) done.set(rule.id, finding(rule, "SATISFIED", `Judged followed (p=${p}, ${model.confidenceKind}). Evidence: ${describe(cited)}`, { evidence: [cited], probability: p, confidenceKind: model.confidenceKind }))
    else done.set(rule.id, finding(rule, "UNKNOWN", "Compliance was suggested without citable evidence.", { probability: p, uncertainty: "no valid citation" }))
  }
  result.findings = checklist.rules.map((rule) => done.get(rule.id)!)
  return result
}
