# Fidelis

**Trust the agent. Verify the behavior.**

Fidelis is a planned, open-source, harness-agnostic auditor for AI coding agents. It checks whether an agent **actually followed the instructions governing its work** and, when justified, asks that same agent to correct its own mistakes.

The focus is **behavioral compliance**, not just code quality, linting, tool permissions, or security policy. A change can compile and pass tests yet still violate a repository's workflow: skip a required review, edit outside the requested scope, combine separately mandated steps, fail to commit at a required checkpoint, or ignore a user-imposed stop condition.

> **Status: design / pre-implementation.** No installable package, verified integrations, or published benchmarks yet. [PLAN.md](PLAN.md) is the implementation specification.

## The idea

1. **Discover effective instructions.** Read applicable global and project instructions, such as `AGENTS.md`, `CLAUDE.md`, and relevant scoped rules. Respect scope and precedence.
2. **Compile once, reuse many times.** A configurable lightweight LLM, initially envisioned as a Gemini Flash-Lite-class model, converts those instructions into an evidence-based checklist. Cache the compiled checklist by a hash of the effective instruction set and compiler configuration.
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

Claude Code's hook can hold a stop for a correction; OpenCode's final reply may already be visible before its audit finishes. Fidelis **does not promise to hide or retract an already displayed reply**.

Adapters for other harnesses (including Codex and Pi) are future work. The same checklist, evaluation, persistence and correction policy should be reused.

## Configuration (proposed, not yet implemented)

Models, prompts, thresholds and retry behavior will be configurable, with sensible built-in prompts and no requirement for extra prompt files. An OpenCode v2 configuration is expected to use the documented `plugins` array and per-package `options`:

```jsonc
{
  "plugins": [
    {
      "package": "@fidelis/opencode",
      "options": {
        "compilerModel": "provider/model-for-checklist",
        "judgeModel": "provider/decision-model",
        "maxCorrections": 3,
        "auditOnCompletion": true
      }
    }
  ]
}
```

These are **proposed Fidelis option names and package identifiers**, not a currently released interface. Custom compiler/judge prompt paths, cache controls, provider credentials and per-project overrides are defined in [PLAN.md](PLAN.md).

## What Fidelis does not do

Fidelis is **not** a substitute for tests, static analysis, code review, or permission safeguards. It does not read hidden model reasoning. It uses observable messages, tool calls/results, diffs, commits, and other available evidence. It cannot guarantee perfect rule interpretation or reconstruct events that a harness never recorded.

## Roadmap

The complete design, milestone order, data contracts, edge cases and acceptance tests live in **[PLAN.md](PLAN.md)**. First deliver a thoroughly tested core and OpenCode v2 adapter, then the Claude Code adapter on the same protocol. No implementation work is claimed by this README.

## License

[MIT](LICENSE).
