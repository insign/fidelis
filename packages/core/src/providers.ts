export type Question =
  | { type: "predicate"; name: string; instructions: string }
  | { type: "choice"; name: string; instructions: string; choices: { value: string; description: string }[] }

export interface Answer {
  p?: number
  choice?: string
  error?: string
}

export interface Decisions {
  answers: Record<string, Answer>
  tokens?: number
  costUSD?: number
}

export interface DecisionModel {
  id: string
  /** "decision" is a typed model probability; "self-reported" is text-model output, not a Jev probability. */
  confidenceKind: "decision" | "self-reported"
  ask(state: string, questions: Question[]): Promise<Decisions>
}

export interface Generated {
  text: string
  tokens?: number
  costUSD?: number
}

export type GenerateText = (prompt: string, jsonSchema?: object) => Promise<string | Generated>

export const generated = (output: string | Generated): Generated => (typeof output === "string" ? { text: output } : output)

export interface RetryOptions {
  retries: number
  timeoutMs: number
  baseDelayMs?: number
}

const HARD_FAILURE = /\b(401|403|404)\b|unauthori[sz]ed|forbidden|not found|consent|usage limit/i

/** Bounded retries with backoff and a timeout. Auth, availability and quota errors fail at once. */
export async function withRetry<T>(run: () => Promise<T>, options: RetryOptions): Promise<T> {
  let lastError: unknown
  for (let attempt = 0; attempt <= options.retries; attempt++) {
    if (attempt > 0) await new Promise((done) => setTimeout(done, (options.baseDelayMs ?? 1000) * 2 ** (attempt - 1)))
    let timer: NodeJS.Timeout | undefined
    try {
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`timed out after ${options.timeoutMs} ms`)), options.timeoutMs)
      })
      return await Promise.race([run(), timeout])
    } catch (error) {
      lastError = error
      if (HARD_FAILURE.test(String((error as Error)?.message ?? error))) break
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

export function parseJson(text: string): any {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()
  const start = body.search(/[{[]/)
  const end = Math.max(body.lastIndexOf("}"), body.lastIndexOf("]"))
  if (start < 0 || end < start) throw new Error("model output holds no JSON")
  return JSON.parse(body.slice(start, end + 1))
}

/** OpenCode `ctx.experimental.generate.decisions` transport: predicate answers carry `probability`. */
export function opencodeDecisions(generate: (input: any) => Promise<any>, model: string): DecisionModel {
  const slash = model.indexOf("/")
  const ref = { providerID: model.slice(0, slash), id: model.slice(slash + 1) }
  return {
    id: model,
    confidenceKind: "decision",
    async ask(state, questions) {
      const result = await generate({
        model: ref,
        input: [{ type: "text", text: state }],
        questions: questions.map((question) => (question.type === "predicate" ? { type: "predicate", name: question.name, instructions: question.instructions } : question)),
      })
      const answers: Record<string, Answer> = {}
      for (const answer of result.answers ?? []) {
        if (answer.type === "predicate") answers[answer.name] = { p: answer.probability }
        else if (answer.type === "choice") answers[answer.name] = { choice: String(answer.choice), p: answer.confidence }
        else answers[answer.name] = { error: answer.reason ?? "decision error" }
      }
      return { answers, tokens: (result.tokens?.input ?? 0) + (result.tokens?.output ?? 0), costUSD: result.cost }
    },
  }
}

/** Native TypeSafe API: a `noul` value in [0,1]; choice options go under `criteria`. Never sent to OpenCode's API. */
export function jevNative(options: { apiKey: string; model?: string; endpoint?: string; fetch?: typeof fetch }): DecisionModel {
  const model = options.model ?? "jev-1.13"
  return {
    id: `jev-native/${model}`,
    confidenceKind: "decision",
    async ask(state, questions) {
      const body = {
        model,
        state,
        questions: Object.fromEntries(
          questions.map((question) => [
            question.name,
            question.type === "predicate"
              ? { type: "noul", instructions: question.instructions }
              : { type: "choice", instructions: question.instructions, criteria: Object.fromEntries(question.choices.map((choice) => [choice.value, choice.description])) },
          ]),
        ),
      }
      const response = await (options.fetch ?? fetch)(options.endpoint ?? "https://api.typesafe.ai/v1/systemone", {
        method: "POST",
        headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!response.ok) throw new Error(`Jev request failed: ${response.status}`)
      const result: any = await response.json()
      const answers: Record<string, Answer> = {}
      for (const [name, answer] of Object.entries<any>(result.answers ?? {})) {
        if (answer.type === "noul") answers[name] = { p: answer.noul }
        else if (answer.type === "choice") answers[name] = { choice: String(answer.choice), p: answer.confidence }
        else answers[name] = { error: answer.message ?? answer.reason ?? "decision error" }
      }
      return { answers, tokens: (result.usage?.input_tokens ?? 0) + (result.usage?.output_tokens ?? 0) }
    },
  }
}

export const DECISIONS_SCHEMA = {
  type: "object",
  properties: { answers: { type: "object", additionalProperties: { type: "object", properties: { p: { type: "number" }, choice: { type: "string" } } } } },
  required: ["answers"],
}

/** Structured classification over a text model. Its numbers are self-reported, not calibrated probabilities. */
export function textDecisions(generate: GenerateText, id: string): DecisionModel {
  return {
    id,
    confidenceKind: "self-reported",
    async ask(state, questions) {
      const prompt = [
        state,
        "\nAnswer every question from the evidence above.",
        'Output JSON only: {"answers":{"<name>":{"p":<probability 0-1 that the answer is yes>}}}; for a choice question use {"choice":"<value>"} with one listed value.',
        "\nQuestions:",
        ...questions.map((question) =>
          question.type === "predicate"
            ? `- ${question.name}: ${question.instructions}`
            : `- ${question.name} (choice): ${question.instructions} Values: ${question.choices.map((choice) => `${choice.value} = ${choice.description}`).join("; ")}`,
        ),
      ].join("\n")
      const output = generated(await generate(prompt, DECISIONS_SCHEMA))
      const parsed = parseJson(output.text)
      if (!parsed || typeof parsed.answers !== "object") throw new Error("decision output lacks answers")
      const answers: Record<string, Answer> = {}
      for (const question of questions) {
        const answer = parsed.answers[question.name]
        if (question.type === "predicate" && typeof answer?.p === "number" && answer.p >= 0 && answer.p <= 1) answers[question.name] = { p: answer.p }
        else if (question.type === "choice" && question.choices.some((choice) => choice.value === answer?.choice)) answers[question.name] = { choice: answer.choice }
        else answers[question.name] = { error: "invalid or missing answer" }
      }
      return { answers, tokens: output.tokens, costUSD: output.costUSD }
    },
  }
}
