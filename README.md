# Fidelis

**Before the agent stops, it checks its own turn against your rules.**

Fidelis is an open-source, harness-agnostic plugin for AI coding agents. When the agent finishes a turn, Fidelis sends one message back to the **same agent, in the same session**, asking it to review what it just did against the global and project instructions it loaded (`AGENTS.md`, `CLAUDE.md` and their scoped rules). The agent fixes what it safely can, asks the user about the rest, or says in one sentence that all rules were respected.

The focus is **behavioral compliance**: skipping a required step, editing outside the requested scope, committing at the wrong point, or ignoring a stop condition.

> **Status:** from 0.2.0 on, the self-review below replaces the external audit pipeline of 0.1.x. [EVIDENCE.md](EVIDENCE.md) lists what was tested and what was not.

## The review

This is the whole mechanism. It is sent once per turn:

```text
[Fidelis: automated end-of-turn review, not a message from the user]
Before ending, review the turn you just finished against every global and project instruction in your context. Look for violations, not confirmation: check each rule against your actual tool calls and outputs, not your intent. An obligation whose deadline has not arrived is not a violation.
Weigh whether each rule is actually needed for what this turn did. Do not carry out a rule just because it is written: a rule this turn's work did not call for needs no action and is not a violation.
- If nothing was violated, reply with one short sentence saying that all rules were respected, and nothing else.
- Fix any violation you can repair without undoing requested work or going beyond what the user authorized.
- For anything that needs the user's decision, name the rule, what you did, and what you need from them. Then stop and wait.
Reply in the user's language.
```

## Why a self-review

- **Full context.** The agent knows what it did and why. Nothing has to be extracted, summarized or squeezed into another model's context.
- **Prompt cache.** The review continues the same conversation, so the provider's cache covers everything before it.
- **No extra models.** No compiler, no judge, no API keys, and no rules or transcripts sent anywhere new.
- **Rules come back into focus.** Re-reading the rules at the end of each turn helps the agent keep to them in the next one.
- **Rules are weighed, not executed.** The agent acts only on rules the turn actually called for.

## Trade-offs

These are known and accepted in exchange for the simplicity:

- **The agent judges itself.** The model that broke a rule may also miss it on review, especially when it misread the rule.
- **Nobody checks the fix.** A repair is not reviewed again: the stop that ends it is never reviewed, so the review cannot loop.
- **Each turn becomes two.** The review adds output, latency and a cache read of the whole context, on the model the session already uses.
- **One more message per turn.** A clean turn ends with a short sentence such as "All rules were respected."
- **Subagents are reviewed through the parent.** The parent sees what each subagent returned, not every step it took.
- **No accuracy figures.** Detection rates have not been measured on labeled data.

## How it works

| Host | Trigger | Delivery |
| --- | --- | --- |
| **Claude Code** | `Stop` hook | `hookSpecificOutput.additionalContext`, which continues the same agent |
| **OpenCode v2** | `session.execution.succeeded` or an idle session, verified against the final-turn record | A prompt marked as Fidelis's, queued to the same session |

A turn is not reviewed when:

- it is the review's own continuation (Claude Code: `stop_hook_active`; OpenCode: the turn was opened by the marked review prompt);
- it belongs to a subagent;
- background work it started is still running.

On OpenCode, a turn is also skipped when compaction removed the message that opened it, because it can then no longer be told apart from the review's own turn.

## Install on Claude Code

```bash
npm install -g fidelis-claude-code
fidelis-claude-code install            # user settings
fidelis-claude-code install --project  # or this project's .claude/settings.json
fidelis-claude-code uninstall
```

Or load the package directory as a plugin with `claude --plugin-dir <path>`.

## Install on OpenCode v2

Add the plugin to `opencode.json`:

```jsonc
{
  "plugins": [{ "package": "fidelis-opencode" }]
}
```

## Configuration

There is none. To turn Fidelis off, uninstall the hook or remove the plugin entry.

## Upgrading from 0.1.x

- The compiler, judge, state machine, OpenCode footer and `/fidelis` panel are gone. Their options (`judgeModel`, `maxCorrections`, `ui` and the rest) are ignored, and `~/.claude/fidelis.json` is no longer read.
- Run `fidelis-claude-code install` again: it replaces the old `Stop` hook and removes the old `SessionStart` hook. The `status` command is gone.
- Earlier versions kept audit state in `$FIDELIS_HOME` or the OS cache directory (`~/.cache/fidelis`, `~/Library/Caches/fidelis`, `%LOCALAPPDATA%\fidelis`). Nothing reads it any more, so it can be deleted.

## What Fidelis does not do

Fidelis is **not** a substitute for tests, static analysis, code review or permission safeguards. It does not verify the agent independently: it asks the agent to verify itself.

## Development

```bash
npm ci
npm test                    # unit tests, no model calls
npm run test:live:claude    # real Claude Code, spends Haiku usage
npm run test:live:opencode  # real OpenCode server, free models, fixture text only
```

[PLAN.md](PLAN.md) records the design decisions. [EVIDENCE.md](EVIDENCE.md) records tested versions and observed host behavior. [RELEASING.md](RELEASING.md) covers releases: merging the release pull request that Release Please keeps open publishes to npm.
