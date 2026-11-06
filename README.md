# Fidelis

**Trust the agent. Verify the behavior.**

Fidelis is a planned, open-source, harness-agnostic AI agent auditor that verifies compliance with **AGENTS.md**, detects behavioral violations, and drives autonomous corrections. It also audits the effective companion instructions that each harness actually loads, including Claude Code's `CLAUDE.md` when applicable.

The focus is **behavioral compliance**, not just code quality, linting, tool permissions, or security policy. A change can compile and pass tests yet still violate a repository's workflow: skip a required review, edit outside the requested scope, combine separately mandated steps, fail to commit at a required checkpoint, or ignore a user-imposed stop condition.

> **Status: design / pre-implementation.** No installable package, verified integrations, or published benchmarks yet. [PLAN.md](PLAN.md) is the implementation specification.

## The idea

1. **Discover effective instructions.** Read applicable global and project instructions, such as `AGENTS.md`, `CLAUDE.md`, and relevant scoped rules. Respect scope and precedence.
2. **Compile once, reuse many times.** A lightweight model converts instructions into an evidence-based checklist. The proposed default is **Big Pickle on OpenCode v2** and **Claude Haiku 5.5 at xhigh effort on Claude Code**. Cache the result by a hash of the effective instruction set and compiler configuration.
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

## Planned integrations

| Host | Planned trigger | Feedback path |
| --- | --- | --- |
| **OpenCode v2** | Completed execution event, verified against final-turn state | Submit a marked corrective prompt to the same session, using the v2 plugin/session API |
| **Claude Code** | `Stop` hook | Return supported stop-hook feedback to continue the agent when correction is warranted |

Claude Code's hook can hold a stop for a correction; OpenCode's final reply may already be visible before its audit finishes. Fidelis **does not promise to hide or retract an already displayed reply**. Claude Code supports `AGENTS.md` directly in recent versions: by default it uses `AGENTS.md` when the project does not provide `CLAUDE.md`, and its project-instructions setting can load both. Fidelis must audit the **effective files actually loaded**, not blindly assume all files apply.

Adapters for other harnesses (including Codex and Pi) are future work. The same checklist, evaluation, persistence and correction policy should be reused.

**Model availability and privacy:** Big Pickle is currently listed as free on OpenCode **for a limited time**, not guaranteed permanently. During that free period, submitted data may be used to improve the model. Fidelis should therefore minimize, redact and require informed configuration/consent before sending potentially sensitive instruction content or history to a provider. The compiler and judge are always configurable.

## Configuration (proposed, not yet implemented)

Models, prompts, thresholds and retry behavior will be configurable, with sensible built-in prompts and no requirement for extra prompt files. An OpenCode v2 configuration is expected to use the documented `plugins` array and per-package `options`:

```jsonc
{
  "plugins": [
    {
      "package": "@insign/fidelis-opencode",
      "options": {
        "compilerModel": "opencode/big-pickle",
        "judgeModel": "opencode/jev-1.13-free",
        "maxCorrections": 3,
        "auditOnCompletion": true
      }
    }
  ]
}
```

These are **proposed Fidelis option names, model IDs and package identifiers**, not a currently released interface; the `@insign` npm scope must be owned by the publisher, and free model availability must be checked at runtime. Custom compiler/judge prompt paths, cache controls, provider credentials and per-project overrides are defined in [PLAN.md](PLAN.md).

## What Fidelis does not do

Fidelis is **not** a substitute for tests, static analysis, code review, or permission safeguards. It does not read hidden model reasoning. It uses observable messages, tool calls/results, diffs, commits, and other available evidence. It cannot guarantee perfect rule interpretation or reconstruct events that a harness never recorded.

## Roadmap

The complete design, milestone order, data contracts, edge cases and acceptance tests live in **[PLAN.md](PLAN.md)**. First deliver a thoroughly tested core and OpenCode v2 adapter, then the Claude Code adapter on the same protocol. No implementation work is claimed by this README.

## npm publication

No npm package needs to be pre-created. Once the implementation is validated, an npm account that controls the chosen scope can publish public packages with `npm publish --access public`. Publication and package names are deferred until tested releases are ready.

## License

[MIT](LICENSE).
