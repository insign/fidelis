/** A user record is the review when Fidelis marked it. OpenCode does not mark human prompts. */
export const isReview = (message: any) => message?.type === "user" && Boolean(message.metadata?.fidelis)

/** session.execution.succeeded is only a candidate: require a finished final reply, no live tools, and the matching idle record. */
export function finalBoundary(messages: readonly any[]): string | null {
  const meaningful = messages.filter((message) => message.type !== "system")
  const last = meaningful.at(-1)
  if (last?.type !== "idle" || last.outcome !== "succeeded") return null
  const assistant = [...meaningful].reverse().find((message) => message.type === "assistant")
  if (!assistant || assistant.finish !== "stop") return null
  if (meaningful.indexOf(assistant) < meaningful.findLastIndex((message) => message.type === "user")) return null
  if ((assistant.content ?? []).some((part: any) => part.type === "tool" && part.state?.status !== "completed" && part.state?.status !== "error")) return null
  return assistant.id
}

/**
 * The finished turn to review, keyed by its final assistant message, or null. The review's own turn is never
 * reviewed. When compaction removed the message that opened the turn, nobody can tell it apart from the review's
 * turn, so it is skipped rather than risk reviewing the review.
 */
export function turnToReview(messages: readonly any[]): string | null {
  const boundary = finalBoundary(messages)
  if (!boundary) return null
  const opening = messages.findLast((message) => message.type === "user")
  return opening && !isReview(opening) ? boundary : null
}
