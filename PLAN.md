# Fidelis: design

**Status:** implemented on top of 0.1.5. **Repository:** `insign/fidelis`. **License:** MIT.

## Problem

AI coding agents can produce correct code while ignoring explicit project instructions about **how to work**: skipping a required review, committing at the wrong point, editing outside the requested scope, or ignoring a requested pause.

## Decision

At the end of each top-level turn, send one fixed review prompt to the same agent, in the same session. The agent compares the turn with the instructions already in its context, repairs what it may, and asks the user about the rest.

Versions 0.1.x did this with an external pipeline: a compiler model turned instructions into a cached checklist, a judge model audited a digest of the transcript, and a state machine routed corrections and waits. It worked, but it needed extra models, keys, consent for free models that train on submitted data, evidence budgeting, a ledger that survived compaction, and a TUI to explain its states. The maintainer chose to replace all of it with the self-review, accepting the trade-offs below. The full 0.1.x specification is in the git history (`PLAN.md` at commit `7d462f6`).

## Invariants

1. **One review per turn.** The continuation that the review starts is never reviewed, so the review cannot loop. Claude Code marks that stop with `stop_hook_active`. On OpenCode, the turn opened by the marked review prompt is skipped.
2. **The review is not the user.** It starts with a marker saying it is automated, so the agent never reads it as new authorization.
3. **Authority stays with the user.** The prompt allows only repairs that undo no requested work and stay within what the user authorized. Anything else is listed for the user, and the agent waits.
4. **Rules are weighed, not executed.** A rule the turn did not call for needs no action and is not a violation. A pending obligation is not a violation.
5. **Reply in the user's language.**
6. **Only finished, top-level turns.** No review for subagents, for turns whose background work is still running, or for OpenCode sessions owned by another directory.
7. **Never wedge the session.** A malformed hook input produces no output, so the turn ends normally.

## Trade-offs accepted

- The agent judges itself, so it can share the blind spot that caused a breach.
- A repair is not reviewed again.
- Each turn becomes two: more output and latency, and a cache read of the whole context on the session's own model.
- A clean turn ends with an extra short sentence.
- Subagent work is reviewed only as the parent saw it.
- On OpenCode, a turn whose opening message was compacted away is skipped rather than risk reviewing the review.

## Structure

```text
packages/
  core/          the review prompt and its marker
  claude-code/   Stop hook, install and uninstall
  opencode/      OpenCode v2 plugin: end-of-turn detection and delivery
tests/live/      real-host checks for both adapters, and a packed-tarball smoke test
```

## Testing

Unit tests cover the prompt, the hook's decisions, install and uninstall, and OpenCode turn detection. The live tests run real hosts: a breach repaired after one review, a rule the turn did not call for left alone, a reply in the user's language, a question left waiting, and subagent sessions left unreviewed. Simple rules are usually followed on the first try, so the live tests induce the breach and authorize its repair up front.

Not measured: how often the review catches real breaches. That needs labeled data.
