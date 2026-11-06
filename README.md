# Fidelis

**Trust the agent. Verify the behavior.**

Fidelis is an open-source, harness-agnostic AI agent auditor that verifies compliance with **AGENTS.md**, detects behavioral violations, and drives autonomous corrections. It also audits the effective companion instructions that each harness actually loads, including Claude Code's `CLAUDE.md` when applicable.

The focus is **behavioral compliance**, not just code quality, linting, tool permissions, or security policy. A change can compile and pass tests yet still violate a repository's workflow: skip a required review, edit outside the requested scope, combine separately mandated steps, fail to commit at a required checkpoint, or ignore a user-imposed stop condition.

> **Status: 0.1.0, not yet published to npm.** Both host adapters pass live checks against the host versions listed in [EVIDENCE.md](EVIDENCE.md), which also lists what is not verified. No accuracy figures are claimed: false positive and false negative rates have not been measured on labeled data.

## The idea

1. **Discover effective instructions.** Read applicable global and project instructions, such as `AGENTS.md`, `CLAUDE.md`, and relevant scoped rules. Respect scope and precedence.
2. **Compile once, reuse many times.** A lightweight model converts instructions into an evidence-based checklist. The default is **Big Pickle on OpenCode v2** and **Claude Haiku 5.5 at xhigh effort on Claude Code**. The result is cached by a hash of the effective instruction set and compiler configuration.
3. **Observe without prejudging.** Collect the agent's execution history and relevant evidence while it works. **Do not accuse the agent merely because a future obligation has not yet been fulfilled.**
4. **Audit after the agent finishes a turn.** A configurable decision model (for example, Jev where available) evaluates the checklist against the actual execution, including ordered actions, final reply, and relevant artifacts.
5. **Correct only substantiated violations.** If the agent can safely repair a violation without exceeding its authorization, Fidelis sends specific, actionable feedback back to that agent and audits the correction again.
6. **Know when to stop.** If the agent needs a genuine user decision, Fidelis records `WAITING_USER` and does not automatically push it to continue. Only a verified new user turn can release that wait.

```text
Effective instructions -> compiler -> cached checklist
                                  |
Agent works -> execution evidence + final turn
                                  |
                         decision-model audit
                                  |
               approved / repair / wait for user
                            |
                   repair -> re-audit
```

## Design principles

- **Audit the past, not an imagined future.** Pending is not violated. Temporal rules are checked against their actual deadlines and sequence of events.
- **Evidence before accusation.** Each finding identifies the original rule, supporting event(s), and a concrete explanation. Missing evidence means `UNKNOWN`, not automatically `VIOLATED`.
- **Independent memory.** Per-session state and evidence live outside the agent's context so compaction does not erase the audit trail.
- **Cheap by default, quality where necessary.** Cached compilation, batch decisions, no LLM inference per tool call, bounded retries and context budgets.
- **User authority wins.** Fidelis must not authorize destructive changes, permissions, expanded scope, or decisions reserved for the user.
- **No infinite repairs.** Idempotent feedback, bounded correction cycles, and explicit waiting/terminal states.
- **Harness-agnostic core.** Each host adapter translates lifecycle events, instruction discovery, transcripts, and feedback into a common contract.

## Integrations

| Host | Trigger | Feedback path |
| --- | --- | --- |
| **OpenCode v2** | `session.execution.succeeded`, verified against the final-turn record | A marked prompt to the same session through the plugin session API |
| **Claude Code** | `Stop` hook | `hookSpecificOutput.additionalContext`, which continues the same agent |

Claude Code's hook can hold a stop for a correction. OpenCode's final reply is already visible before its audit finishes, so Fidelis reports a follow-up there and **never claims a reply was hidden or retracted**. Fidelis audits the **files each host actually loaded**, read from the host's own records.

Adapters for other harnesses (including Codex and Pi) are future work.

## Install on OpenCode v2

Add the plugin to `opencode.json`. It loads the server and TUI parts together:

```jsonc
{
  "plugins": [
    {
      "package": "fidelis-opencode",
      "options": { "allowFreeModelDataUse": true }
    }
  ]
}
```

Without `allowFreeModelDataUse`, the audit reports `AUDIT_INCOMPLETE` instead of sending anything to the default compiler: **Big Pickle is free for a limited time and its submitted data may be used to improve the model**. Either consent as above, or name other models in `compilerModel` and `judgeModel`. Fidelis never switches to another model on its own.

The footer shows the current state. Type `/fidelis` in a session for its audit history.

## Install on Claude Code

```bash
npm install -g fidelis-claude-code
fidelis-claude-code install            # user settings
fidelis-claude-code install --project  # or this project's .claude/settings.json
fidelis-claude-code status <session-id>
fidelis-claude-code uninstall
```

Or load the package directory as a plugin with `claude --plugin-dir <path>`. Audits use your existing Claude authentication through a nested `claude -p`, isolated from hooks, tools, settings and project instructions. By default each finished turn adds Haiku calls to your usage and can hold the `Stop` for up to a minute.

## Configuration

Pass options through the OpenCode plugin entry, or put them in `~/.claude/fidelis.json` and `<project>/.claude/fidelis.json` on Claude Code.

| Option | Default | Meaning |
| --- | --- | --- |
| `enabled` | `true` | Master switch |
| `auditOnCompletion` | `true` | Audit finished turns |
| `compilerModel` | OpenCode: `opencode/big-pickle`. Claude Code: `claude-haiku-5-5` | Builds the checklist |
| `compilerEffort` | Claude Code: `xhigh` | Ignored on OpenCode, where the model variant applies |
| `judgeModel` | OpenCode: `opencode/jev-1.13-free`. Claude Code: `claude-haiku-5-5` | Judges each turn |
| `judgeEffort` | Claude Code: `xhigh` | Ignored on OpenCode |
| `compilerPromptPath`, `judgePromptPath` | `null` | Replace a built-in prompt. Part of the matching cache key |
| `maxCorrections` | `3` | Corrections per turn before `STOPPED` |
| `minViolationConfidence` | `0.9` | Threshold to act on a violation |
| `maxAuditTokens` | `12000` | Evidence budget. Over budget is `AUDIT_INCOMPLETE`, never silent truncation |
| `maxAuditCostUSD` | `null` | Per-session spend limit, when the provider reports cost |
| `cacheChecklist` | `true` | Reuse compiled checklists across sessions |
| `storeRawTranscript` | `false` | Keep unclipped evidence in the local ledger |
| `allowFreeModelDataUse` | `false` | Consent for default models that may train on submitted data |
| `trustSdkPrompts` | `false` | Let SDK prompts release a wait. For fully headless use only |
| `timeoutMs`, `retries` | `240000`, `2` | Per-call limits with backoff |
| `retentionDays` | `30` | Local state retention |
| `ui` | see below | OpenCode TUI only. Never affects auditing |

```json
{ "ui": { "enabled": true, "footer": true, "notifications": "important", "auditPanel": true, "plainTextIcons": false } }
```

On Claude Code, a judge model whose name starts with `jev` uses the native TypeSafe API and requires `TYPESAFE_API_KEY`. Otherwise judging uses Haiku, whose numbers are labeled `self-reported` and are not Jev probabilities.

State lives in `$FIDELIS_HOME`, or the OS cache directory (`~/.cache/fidelis`, `~/Library/Caches/fidelis`, `%LOCALAPPDATA%\fidelis`), with private permissions. Common secret shapes are redacted before anything is stored or sent.

## Known limits

- **Free tier on OpenCode:** when `Free usage limit reached` appears, the audit reports `AUDIT_INCOMPLETE`. The compiler call also carries OpenCode's normal system context, because the free tier refused requests without it. Configure your own models to avoid both.
- **OpenCode origin:** the host does not mark human prompts. Fidelis treats unmarked `user` records as human and excludes its own marked prompts and `synthetic` records, so an unmarked prompt from another plugin would count as a human reply.
- **Rule interpretation is model output.** Thresholds and evidence checks bound the damage, but a judge can still misread a rule. An overall accuracy figure would need labeled ground truth, which does not exist yet.
- **Claude Code `-p` prompts** are not proof of a human, so they never release `WAITING_USER` unless `trustSdkPrompts` is on.
- Host records used for instruction discovery (`core/instructions` on OpenCode, the `instructions` transcript attachment on Claude Code) are not stable public contracts. On Claude Code a documented file-based fallback applies; on OpenCode a missing record yields no audit of that source.

## What Fidelis does not do

Fidelis is **not** a substitute for tests, static analysis, code review, or permission safeguards. It does not read hidden model reasoning. It uses observable messages, tool calls/results, diffs, commits, and other available evidence. It cannot guarantee perfect rule interpretation or reconstruct events that a harness never recorded.

## Development

```bash
npm ci
npm test                    # unit and replay tests, no model calls
npm run test:live:claude    # real Claude Code, spends Haiku usage
npm run test:live:opencode  # real OpenCode server, free models, fixture text only
npm run test:live:tui       # real OpenCode TUI in a pseudo-terminal
```

[PLAN.md](PLAN.md) is the design specification. [EVIDENCE.md](EVIDENCE.md) records tested versions and observed host behavior. [RELEASING.md](RELEASING.md) covers npm publication, which needs explicit maintainer approval.

## License

[MIT](LICENSE).
