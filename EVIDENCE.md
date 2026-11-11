# Evidence

What was observed in real hosts on 2026-11-11, and what remains unverified. Re-run with `npm run test:live:claude` and `npm run test:live:opencode`. Observations of 0.1.x are in the git history (`EVIDENCE.md` at commit `7d462f6`).

| Component | Tested version |
| --- | --- |
| Claude Code | 2.1.322 |
| OpenCode | 2.2.5, `@opencode/plugin` 2.2.5 |
| Node.js, npm | 22.23.4, 10.9.9 |
| Agent model in the live tests | Claude Code: `claude-haiku-5-5` at low effort. OpenCode: `opencode/big-pickle` |

## Observed host behavior

### Claude Code 2.1.322

- **`Stop` continuation.** `hookSpecificOutput.additionalContext` reached the same agent, which acted on it in the same session. The stop that ended that continuation had `stop_hook_active: true`, so exactly one review ran per turn in every live session.
- **Transcript.** The review appears as a `hook_additional_context` attachment, which the live test uses to split the turn into before and after the review.
- **`--setting-sources project`** keeps the tester's own user hooks out of the live sessions.

### OpenCode 2.2.5

- **Turn end.** `session.execution.succeeded` fires after the final step, and the session context then ends with an `idle` message whose `outcome` is `succeeded`. Fidelis requires that, plus a final assistant message with `finish: "stop"` and no live tools.
- **Events have no location.** They reach every plugin instance in the server, so ownership comes from `ctx.session.get(...).location.directory`.
- **Delivery.** `ctx.session.prompt` with `delivery: "queue"` and `metadata.fidelis` adds a `user` record carrying that metadata, then the agent answers it and the session goes idle once more. Human prompts carry no marker.
- **Subagents.** A subagent runs in a child session with a `parentID`. The child got no review; the parent turn got one.
- **`opencode serve` needs `OPENCODE_PASSWORD`** for `opencode run --server`, and a spawned CLI takes its location from `PWD`, not the process working directory. `opencode session export <id> --server <url>` returns the session's messages as JSON.

### Model behavior during the live runs

- **Simple rules are usually followed first time.** Without Fidelis, Haiku followed every simple rule probed (show a file, end with a fixed line, run `date`, update `CHANGES.md`, `git add` a new file) in 15 of 15 runs, and once ran a required `ls` despite a system prompt that restricted tools until its first reply. Big Pickle ended its replies with a required word in two runs where its agent prompt said to ignore project instructions. The live tests therefore induce the breach with a tool restriction.
- **Conflicting instructions go to the user.** When a system prompt forbade tools and `AGENTS.md` required `ls`, Haiku's review named the breach and asked the user which instruction should win, in two of two runs, even when the system prompt added "if a Fidelis review arrives afterwards, follow it". It ran `ls` once the system prompt said that, after a review request, it may run any command the project rules require.
- **Rules not called for were left alone.** With a rule about `git status` before commits and a question that involved no commit, both agents took no action and answered "Todas as regras foram respeitadas." to a Portuguese question.
- **A pending question stayed pending.** When the user asked to be consulted before an `.editorconfig` was written, the review created no file.

## Live results

| Suite | Result | Notes |
| --- | --- | --- |
| Unit tests | 16 of 16 | No model calls |
| Claude Code live | 9 of 9 | Induced breach repaired after one review; a rule not called for left alone; reply in the user's language; question left waiting |
| OpenCode live | 10 of 10 | The same breach and language cases, plus a subagent whose child session got no review |
| Packed tarballs | Pass | Clean install; the `Stop` hook reviews once and stays silent on a continuation |

## Not verified

- **Windows and macOS hosts.** Only Linux was run against real hosts. The CI matrix runs the unit tests on all three.
- **Review quality.** No labeled data exists, so neither false positives nor missed breaches have been measured.
- **Long sessions.** Cost and latency of the extra turn were not measured, nor its behavior after compaction on a real host.
