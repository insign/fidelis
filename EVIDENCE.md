# Evidence

What was observed in real hosts, on 2026-11-05 and 2026-11-06, and what remains unverified. Re-run with `npm run test:live:claude`, `npm run test:live:opencode` and `npm run test:live:tui`.

| Component | Tested version |
| --- | --- |
| OpenCode | 2.2.5, `@opencode/plugin` 2.2.5 |
| Claude Code | 2.1.318 |
| Node.js, npm | 24.18.0, 11.16.0 |
| Compiler and judge on OpenCode | `opencode/big-pickle`, `opencode/jev-1.13-free` |
| Compiler and judge on Claude Code | `claude-haiku-5-5` |

## Observed host behavior

### OpenCode 2.2.5

- **Turn end.** `session.execution.succeeded` fires after `session.step.ended` with `finish: "stop"`, and `ctx.session.context` then ends with an `idle` message whose `outcome` is `succeeded`. Fidelis requires all of that, and uses the last assistant message ID as the boundary.
- **Events have no location.** `session.execution.*` events carry no `location` and reach every plugin instance in the server. Ownership has to come from `ctx.session.get(...).location.directory`. Before this check, an instance with no record of a session approved it as having no rules.
- **Effective instructions.** The `context` hook lists loaded sources in `system[].metadata.experimental.instructions`. Key `core/instructions` holds `Instructions from: <path>` blocks. Nested `AGENTS.md` files arrive as `synthetic` messages with `metadata.instruction.paths`. The docs call this metadata experimental.
- **Origin.** A prompt from a plugin appears as `type: "user"` with whatever `metadata` was supplied, and `prompt` hooks fire for it too. Real user prompts carry no origin marker, so the host cannot distinguish them from an unmarked prompt from another plugin.
- **Model transports.** `ctx.experimental.generate.decisions` works with `jev-1.13-free` for `predicate` and `choice` questions. `ctx.experimental.generate.text` with `big-pickle` was refused with `Free usage limit reached`. `ctx.session.generate` on a session pinned to the model works, adds no messages and uses that session's model, verified with a different default model configured.
- **Model listing.** `opencode models` listed `big-pickle` but not `jev-1.13-free`, which still answered. Fidelis therefore reports real call failures rather than pre-checking a list.
- **`opencode serve` needs `OPENCODE_PASSWORD`** for `opencode run --server`, and a spawned CLI takes its location from `PWD`, not the process working directory.

### Claude Code 2.1.318

- **`Stop` continuation.** `hookSpecificOutput.additionalContext` reached the same agent, which replied to it. The next `Stop` had `stop_hook_active: true`.
- **Transcript lag.** At the first `Stop`, the final assistant record was not yet in the transcript, as the docs warn. Fidelis uses `last_assistant_message` for the final reply and treats unresolved tool calls as incomplete evidence.
- **Effective instructions.** The transcript holds an `instructions` attachment with path, type and full content. Lazy rules arrive as `nested_memory` attachments. A nested `AGENTS.md` arrives as `hook_additional_context` from `tool.call`, with text `Contents of <path>:`.
- **`InstructionsLoaded`** did not fire for a directly loaded `AGENTS.md`, and did fire for `CLAUDE.md` and imported files, matching the docs. Fidelis does not depend on it.
- **Origin.** Records carry `origin.kind`, `turnOrigin` and `promptSource`: `human`, `sdk`, `task_notification`. Mid-turn typed input appears as a `queued_command` attachment with `humanTurn: true`.
- **Nested isolation.** `claude -p --setting-sources "" --settings '{"disableAllHooks":true}' --tools "" --system-prompt ...` loaded no instruction files and works with existing authentication. `--bare` does not, because it skips OAuth. `--json-schema` returns `structured_output`.

### Instruction-loading matrix on Claude Code 2.1.318

Real sessions, comparing the transcript's loaded files. `InstructionsLoaded` was not consulted.

| Fixture | Effective project files |
| --- | --- |
| `AGENTS.md` only | `AGENTS.md` |
| `CLAUDE.md` only | `CLAUDE.md` |
| Both, default setting | `CLAUDE.md` |
| Both, `claude-md-and-agents-md` | `CLAUDE.md`, `AGENTS.md` |
| `CLAUDE.md` importing `AGENTS.md` | `CLAUDE.md`, `AGENTS.md` |
| Nested and scoped rules, after reading `sub/x.txt` | `AGENTS.md`, `.claude/rules/eager.md`, then lazily `sub/AGENTS.md` and `.claude/rules/scoped.md` |

### Decision protocols

The same fixture through native `noul` at `https://opencode.ai/inference/systemone/v1/systemone` and through Haiku gave the same routing. Native returned `noul: 0.87` and `0.04`. Haiku returned self-reported `0.97` and `0.02`. These numbers show that both transports work, not that they are calibrated.

### More host behavior found while testing

- **`.tsx` from a package fails.** A TUI part written in `.tsx` loaded from a plugin directory but failed with `Plugin failed` when the same files sat under `node_modules`, even with OpenTUI and Solid installed. The published part is therefore plain `.ts` calling the Solid runtime directly.
- **RPC output is strict JSON.** A field holding `undefined` is rejected as `rpc.invalid_output`, and calls must pass `{ location: { directory } }`.
- **TUI options.** `context.options` did not carry the options of a server-loaded entry in this version, so the TUI reads them from the server over RPC.
- **Free tier limits.** `session.generate` requests on the free tier were refused with `Free usage limit reached` when a `generate` hook removed the system prompt or the tools, and accepted unmodified. Fidelis does not strip them, so the compiler call on OpenCode also carries OpenCode's normal system context. The same message also appeared on plain agent turns after many test runs, which blocks live flows until the limit clears.
- **Trust dialog and child sessions.** An interactive Claude Code started inside another Claude Code session inherits a marker that turns transcript saving off, so the live test removes `CLAUDE_CODE_CHILD_SESSION`.

## Live results

| Suite | Result | Notes |
| --- | --- | --- |
| Unit and replay tests | 71 of 71 | No model calls |
| Claude Code live | 17 of 17 | Violation, one correction, approval, checklist reuse, replay dedupe, `WAITING_USER`, SDK turn stays locked, typed human reply releases once, hook timeout |
| OpenCode live | 17 of 18 | Same flows plus synthetic message, child-agent attribution, no consent and unavailable models. The failing check was the RPC call, fixed afterwards and confirmed against a real server |
| TUI live, replaying a stored session from a packed tarball | 11 of 11 | Footer restores stored state, `Monitoring` during a turn, `/fidelis` panel with evidence, no repeated toast, narrow terminal, text-only icons, server restart |
| Packed tarballs | Pass | Clean install, Claude hook runs, OpenCode server and TUI parts load |

In an earlier full TUI run with model calls, one violation toast was observed and the panel showed the finding.

## Not verified

- **On-screen `Compiling`, `Auditing` and `Correcting` labels.** Their logic has unit tests, but the free tier limit blocked the final full run under the terminal emulator. Re-run `npm run test:live:tui` when the limit clears.
- **A final full OpenCode run** after the last fixes, for the same reason. Run `npm run test:live:opencode`.
- **Mid-turn compaction, live.** The ledger is covered by fixtures only.
- **A running TUI across a server reconnect, and several TUI clients at once.** A fresh TUI after a server restart was tested. The reconnect handler and shared toast dedupe were not.
- **Windows and macOS.** The hook launcher and paths have not run there. `ci.yml` covers them once pushed; path-shape and file-mode tests are skipped on Windows.
- **The native TypeSafe endpoint** `api.typesafe.ai`, for lack of a key. The same protocol was exercised through OpenCode's endpoint.
- **npm publication and OIDC.** `publish.yml` has never run. Nothing has been published.
- **Accuracy.** False positive and false negative rates are unmeasured, because no labeled set of real violations exists. Audit records hold calls, tokens, cost, latency, cache hits and uncertain counts for that future measurement.
