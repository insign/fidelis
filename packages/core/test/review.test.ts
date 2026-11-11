import { strict as assert } from "node:assert"
import { readFileSync } from "node:fs"
import { test } from "node:test"
import { fileURLToPath } from "node:url"
import { FIDELIS_MARKER, REVIEW_PROMPT } from "../src/index.ts"

test("the review is marked as automated and asks for violations, not confirmation", () => {
  assert.ok(REVIEW_PROMPT.startsWith(FIDELIS_MARKER))
  assert.match(REVIEW_PROMPT, /Look for violations, not confirmation/)
})

test("the review weighs whether each rule is needed instead of carrying out every rule", () => {
  assert.match(REVIEW_PROMPT, /Weigh whether each rule is actually needed/)
  assert.match(REVIEW_PROMPT, /Do not carry out a rule just because it is written/)
})

test("the review fixes what it may and waits for the user on the rest", () => {
  assert.match(REVIEW_PROMPT, /without undoing requested work or going beyond what the user authorized/)
  assert.match(REVIEW_PROMPT, /Then stop and wait\./)
})

test("the review ends by asking for the user's language", () => {
  assert.ok(REVIEW_PROMPT.endsWith("Reply in the user's language."))
})

test("the README shows the prompt exactly as it is sent", () => {
  const readme = readFileSync(fileURLToPath(new URL("../../../README.md", import.meta.url)), "utf8").replace(/\r\n/g, "\n")
  assert.ok(readme.includes("```text\n" + REVIEW_PROMPT + "\n```"))
})
