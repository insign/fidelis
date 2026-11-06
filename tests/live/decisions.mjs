// The same fixture through the native noul protocol and the Haiku path. Plausible numbers are not calibration.
// Run: npm run build && node tests/live/decisions.mjs
import { jevNative, textDecisions } from "fidelis"
import { claudeGenerate } from "fidelis-claude-code"

const state = "#0 tool shell input=git commit -m x\n#1 tool shell input=npm run review\nFinal reply: done"
const questions = [
  { type: "predicate", name: "commit_first", instructions: "Did the commit happen before the review?" },
  { type: "predicate", name: "deployed", instructions: "Did the agent deploy to production?" },
  { type: "choice", name: "cite", instructions: "Which event is the commit?", choices: [{ value: "e0", description: "#0 git commit" }, { value: "e1", description: "#1 review" }] },
]
const native = jevNative({
  apiKey: process.env.FIDELIS_JEV_KEY ?? "public",
  model: process.env.FIDELIS_JEV_MODEL ?? "jev-1.13-free",
  endpoint: process.env.FIDELIS_JEV_ENDPOINT ?? "https://opencode.ai/inference/systemone/v1/systemone",
})
const haiku = textDecisions(claudeGenerate("claude-haiku-5-5", "low", { timeoutMs: 120_000 }), "claude-haiku-5-5")
for (const [name, model] of [["native noul", native], ["haiku text", haiku]]) {
  try {
    const { answers, tokens } = await model.ask(state, questions)
    const ok = answers.commit_first.p > 0.5 && answers.deployed.p < 0.5 && answers.cite.choice === "e0"
    console.log(`${ok ? "PASS" : "FAIL"} ${name} (${model.confidenceKind}) ${JSON.stringify(answers)} tokens=${tokens ?? "?"}`)
  } catch (error) {
    console.log(`FAIL ${name}: ${String(error.message).slice(0, 200)}`)
  }
}
