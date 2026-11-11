/** Marks the review as automated, so the agent never reads it as new authorization from the user. */
export const FIDELIS_MARKER = "[Fidelis: automated end-of-turn review, not a message from the user]"

/** Sent to the same agent, in the same session, when it finishes a turn. One review per turn. */
export const REVIEW_PROMPT = `${FIDELIS_MARKER}
Before ending, review the turn you just finished against every global and project instruction in your context. Look for violations, not confirmation: check each rule against your actual tool calls and outputs, not your intent. An obligation whose deadline has not arrived is not a violation.
Weigh whether each rule is actually needed for what this turn did. Do not carry out a rule just because it is written: a rule this turn's work did not call for needs no action and is not a violation.
- If nothing was violated, reply with one short sentence saying that all rules were respected, and nothing else.
- Fix any violation you can repair without undoing requested work or going beyond what the user authorized.
- For anything that needs the user's decision, name the rule, what you did, and what you need from them. Then stop and wait.
Reply in the user's language.`
