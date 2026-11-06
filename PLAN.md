# Fidelis: implementation plan

**Status:** specification, not implemented. **Repository:** `insign/fidelis`. **License:** MIT.

This is the authoritative implementation brief for the first release. Implement only the functionality and files needed for the milestones, preserve the repository's existing license, and validate real host APIs against their current documentation and an installed host before calling an integration complete.

## 1. Problem and product boundaries

AI coding agents can produce correct code while ignoring explicit project instructions about **how to work**. Examples: implementing two units instead of one, skipping a required independent review, committing at the wrong point, ignoring a requested pause, or claiming tests were executed when they were not.

Fidelis audits **completed work**, not tentative intentions. Its task is to discover governing instructions, compile them into auditable obligations, observe the actual execution, render evidence-backed verdicts, and request the smallest authorized correction from the original agent. It is not primarily a security guard, general-purpose autonomous planner, test runner, or a gate on every tool invocation.

### Normative invariants

1. **No premature conviction:** a condition still satisfiable later in the same unit is `PENDING`, not `VIOLATED`. Evaluate deadlines only when the relevant execution boundary has occurred.
2. **No unsupported findings:** a violation must cite the applicable original instruction and observed evidence. Unknown or missing data cannot be silently converted into failure.
3. **No escalation of authority:** never ask the agent to perform an action beyond the user's authorization. When repair is destructive, irreversible, sensitive, or needs a substantive user choice, request the user's approval instead.
4. **No automated feedback loop:** never mistake Fidelis-generated messages or callbacks for a human reply, and never audit a completed audit as agent work.
5. **One auditable turn at a time:** detect completed top-level turns; include child-agent evidence when causally relevant; ignore unrelated sessions and background work not yet resolved.
6. **Host capabilities are explicit:** unsupported lifecycle controls degrade gracefully and are tested, not fabricated. Do not claim a result was withheld from the user if the host already displayed it.
7. **Use minimal, verifiable evidence:** collect what the judge needs without requiring private chain-of-thought, duplicate payloads, or exposing API credentials.

## 2. Architecture

Proposed TypeScript monorepo, revised as implementation needs dictate:

```text
packages/
  core/           instructions, checklist schema, cache, audit, policy, state
  providers/      checklist compiler and decision-model transport interfaces
  opencode/       OpenCode v2 lifecycle adapter
  claude-code/    Claude Code hooks and transcript adapter
prompts/          versioned built-in compiler and judge prompts
tests/            fixtures, replay tests, adapter integration tests
```

Only `core` knows the compliance semantics. Each adapter owns instruction discovery, execution boundaries, extraction of user-origin messages, transcript and tool evidence, and how a corrective instruction is delivered. The provider layer owns authentication, structured generation, decision batching, retries, timeouts and budgets. Built-in prompts can be overridden without editing package files.

### Host adapter contract (conceptual)

- `getEffectiveInstructions(session)` -> ordered, scoped source entries with content, provenance and precedence;
- `getExecutionEvidence(session, boundary)` -> normalized timeline, final message, referenced artifacts, completeness markers;
- `onHumanTurn(session, message)` -> reliable human-origin message identity, excluding synthetic/plugin turns;
- `onAgentCompletion(session, boundary)` -> stable, deduplicated completion key;
- `requestCorrection(session, report)` -> deliver feedback without pretending to be the user;
- `pauseForUser(session, question)` -> allow a real user response, no forced continuation.

These are **proposed interfaces**, not claims about method names in an SDK.

## 3. Instruction discovery, resolution and cache

Gather **all applicable instructions**, not just two hardcoded files. Support root/global and project-level `AGENTS.md`; in Claude Code also resolve `CLAUDE.md`, applicable `.claude/rules/` content and lazily loaded/scoped instructions where observable. The effective set depends on current project, working directory, file scope, configured instruction precedence and active host. Record original path, hash, priority, scope, and exact text for each source.

Never assume that two files can be flattened by concatenation without understanding overrides. Resolve explicit precedence and conflicts. A user instruction can narrow the current task but does not retroactively change historical facts. Unresolved conflicting mandatory rules are marked `UNKNOWN` and surfaced, not arbitrarily chosen.

**Cache key** = SHA-256 of a canonical, versioned representation containing:

- ordered effective instruction contents + source identities, scopes, precedence and relevant host;
- compiler model/provider ID and compiler settings affecting output;
- compiler prompt hash, checklist schema version and compiler implementation version.

Use unambiguous length-delimited/canonical encoding. Cache compiled checklists **across sessions**; cache audit state **per session and per turn**. Revalidate the instruction fingerprint at a new turn, when an instruction change is observed, and before evaluation. An unchanged fingerprint must avoid another compiler call. Changing the rules, prompt, model, or compiler schema must invalidate the checklist. A new unrelated session never inherits the previous session's verdict.

Plan directories under an OS-appropriate application cache/state location, e.g.:

```text
fidelis/
  checklists/<fingerprint>.json
  sessions/<host>/<session-id>/state.json
  sessions/<host>/<session-id>/audits.jsonl
```

Sanitize/encode host and session identifiers for paths. Writes must be atomic and private by default; per-session locks or CAS/version checks prevent races. Cleanup/TTL limits retention, and restarting the host can resume without replaying previous corrections. Preserve audit evidence needed for debugging without storing unnecessary secrets; support redaction and an opt-out of raw transcripts.

## 4. Checklist compiler (infrequent model call)

The compiler, initially envisioned as a Gemini Flash-Lite-class model, **translates instructions; it does not judge the agent's execution**. Run it once per effective fingerprint on the first applicable session/turn; prewarming is optional. Persist a structured, schema-validated checklist. On cache hit, do not call the compiler.

Each item should include:

- stable rule ID, verbatim source quote, file reference and provenance;
- obligation type: `MUST`, `MUST_NOT`, `CONDITIONAL`, `TEMPORAL`, `STOP_CONDITION`, etc.;
- applicability predicate, triggering event, deadline/boundary and exceptions;
- verifiable expected evidence, admissible counterevidence, repairability hints;
- source priority and whether the rule can be superseded by a more specific applicable rule.

Output must be schema-checked. Detect duplicates and contradictions while preserving traceability. Do not invent new obligations, soften a `MUST` into advice, or turn an example into a requirement. If compilation fails or confidence is too low, mark the checklist unavailable and report `AUDIT_INCOMPLETE`; do **not** claim the session passed.

Checklist generation is not repeated at every correction. Dynamically determine which already-compiled rules apply to the current user task and current phase. Recompile only when the effective fingerprint or schema changes.

## 5. Evidence collection and execution boundary

Record or reconstruct a **chronological, attributable execution payload** containing at least: human requests, agent responses, tool names/arguments (subject to redaction), tool results/errors, relevant subagent contributions, observable tests, commits/diffs, timestamps/sequence, and the agent's final response. Do not depend solely on its self-reported summary.

The auditor needs the full **relevant** execution, including earlier actions essential to a temporal rule, not merely the last tool's payload. Preserve event IDs and provenance so an audit can cite evidence. Distinguish unavailable, unobserved, completed, failed, in-flight and cancelled operations. A missing observed event alone does not prove the event never occurred unless the source is known complete.

When a transcript exceeds model context, produce an evidence-preserving digest and retrieve relevant raw spans for disputed rules. Never silently truncate material evidence. Hash the audited execution snapshot and store a stable `boundaryID` to deduplicate callbacks, retries, crashes and duplicate completion events.

**Trigger only on a completed top-level response/turn**, not after every tool call. If it is unclear whether the host actually finished or is merely idle between tools, wait for a stronger completion signal. If the final reply asks the user for a necessary decision, evaluate the need to wait rather than automatically restarting the agent.

## 6. Judge / Decisions (per completed turn)

Provide the compiled checklist, current user instruction, normalized evidence, final reply and prior unresolved audit findings to a configurable decision model. Initially target Jev or a model with equivalent typed/batched decisions. The OpenCode v2 experimental decisions API exposes `predicate`, choice and score questions; **do not assume a provider-specific `noul` field is portable**. Claude Code needs an independent provider client/transport and a documented fallback if that model is not available.

Model outputs are suggestions to a deterministic policy engine, not executable instructions. Per-rule status:

- `NOT_APPLICABLE`: rule does not govern this turn;
- `PENDING`: obligation has not reached its deadline;
- `SATISFIED`: affirmative evidence supports compliance;
- `VIOLATED`: specific evidence supports a breach at the completed boundary;
- `UNKNOWN`: insufficient evidence or unresolved conflict.

Each finding contains `ruleID`, status, explanation, evidence references, severity, decision probability/confidence when available, and an explicit uncertainty reason. Use a calibrated threshold for acting and allow an escalation/recheck on ambiguous cases. Distinguish **probability of a predicate** from a measured adherence score or probability of truth. An overall percentage (if shown) is descriptive, computed from applicable and assessable rules; it is not itself a license to command a correction.

Use batched binary decisions where possible to reduce latency. Ask separately whether: (a) a confirmed violation exists, (b) it is autonomously repairable without violating user authority, and (c) the last answer genuinely requires an additional human decision. Let the core make the final routing decision from verdicts, state and verified user-message metadata.

## 7. Session state machine and correction loop

Persist `READY`, `RUNNING`, `AUDITING`, `CORRECTING`, `WAITING_USER`, `APPROVED`, `AUDIT_INCOMPLETE`, `STOPPED`.

### Transitions

| Current state + event | Outcome |
| --- | --- |
| New session + cached checklist | `READY` without compiler call |
| New session + cache miss | compile checklist, then `READY` or `AUDIT_INCOMPLETE` |
| Verified new human task | `RUNNING`; new turn boundary and evidence window |
| Completed agent turn | `AUDITING` exactly once per boundary |
| No proven actionable violations | `APPROVED` or `WAITING_USER` if the agent is properly awaiting the user |
| Proven and safe-to-repair violation | `CORRECTING`; send one actionable report to the same agent |
| Corrective turn finishes | `AUDITING` with cumulative evidence and prior findings |
| User decision/permission required | `WAITING_USER`; **no automatic follow-up** |
| Verified real human reply while waiting | clear waiting condition; `RUNNING` |
| Budget exhausted, repeated failure, provider error | `STOPPED` or `AUDIT_INCOMPLETE` with transparent outcome |

**Human-message gate:** never infer a real reply from a generic prompt hook alone. Claude Code's `UserPromptSubmit` can also fire on self-initiated turns. Require trustworthy origin metadata/message records and a **new message ID** after the wait was established. Plugin-generated prompts, stop-hook feedback, summaries, synthetic messages and the agent's own text must not release `WAITING_USER`.

**Avoid recursion:** attach a stable Fidelis origin marker to feedback; track in-flight audits; deduplicate identical violation sets for an unchanged execution snapshot; cap `maxCorrections` (proposed default 3), time, tokens and spending. Never re-trigger solely because Fidelis wrote a message. An additional corrected completion may legitimately trigger one new audit.

### Correction report

Send minimal actionable feedback with source instruction, observed evidence, violation type, precisely allowed repair, and what to do if the repair requires user authorization. Do not request wholesale regeneration if a small fix will suffice.

Some historical violations cannot be undone (e.g. an already missed pre-commit review). The agent must acknowledge them and perform any feasible compensating work; the judge must not pretend the original order of events has changed. Allow `UNREPAIRABLE` findings to be disclosed rather than producing infinite retries.

## 8. Host-specific integration

### OpenCode v2

- Register via the documented v2 plugin entry point (`Plugin.define({ id, setup(ctx) })`) and `plugins` array in `opencode.json(c)` with `package` and `options`.
- Use session lifecycle events such as `session.execution.succeeded` as a **candidate** completion boundary; validate that a final assistant turn exists, the top-level execution has completed, and no older/duplicate boundary is being re-audited.
- Use `ctx.session.context({ sessionID })` and other durable session/tool event data for evidence; preserve causality and check completeness.
- Use `ctx.experimental.generate.decisions` for typed questions **only when supported by the installed version/model**; compiler may use `ctx.experimental.generate.text` or an external transport.
- Use `ctx.session.prompt({ sessionID, text, ... })` (or the appropriate, tested delivery API) for correction, with origin markers and idempotent queueing. `ctx.session.hook("prompt")` can observe admission, but is not proof of human origin on its own.
- Do not copy the v1 plugin hook object API into v2 code. Audit after completion, not with a blocking per-tool hook.
- Accept that the original final answer may already have appeared; clearly report follow-up audit/correction rather than claiming pre-delivery approval.

### Claude Code

- Provide a supported hook package/installer for `SessionStart`, `InstructionsLoaded` as needed, `UserPromptSubmit`, and **`Stop`**; discover current host-managed instruction sources and transcript paths.
- Read the transcript JSONL indicated by the hook, with subagent transcripts as available; maintain stable event identities and origin checks.
- On a confirmed fixable violation at `Stop`, return documented correction feedback (e.g. `hookSpecificOutput.additionalContext` or `decision: "block"` + reason), allowing the agent to continue. The `stop_hook_active` flag and host's consecutive-continuation limit are supplementary safeguards, **not** substitutes for Fidelis state and retry bounds.
- If no fix is warranted or the agent is waiting for the user, let `Stop` finish normally. Do not block merely to ask the same question again.
- Use an external compiler and judge client; there is no assumption that OpenCode's experimental Decisions API exists inside Claude Code.
- Verify behavior across restarts, resume, compaction, user interruptions, hooks timing out and Windows/Unix hook launchers.

## 9. User configuration and prompts

Package default prompts, a compiler model, a judge model, thresholds, budget limits and feedback templates. Allow host-specific overrides without forking the core.

Proposed configuration schema (names to stabilize before implementation):

```json
{
  "enabled": true,
  "compilerModel": "provider/compiler-model",
  "judgeModel": "provider/decision-model",
  "compilerPromptPath": null,
  "judgePromptPath": null,
  "auditOnCompletion": true,
  "maxCorrections": 3,
  "minViolationConfidence": 0.9,
  "maxAuditTokens": 12000,
  "maxAuditCostUSD": null,
  "cacheChecklist": true,
  "storeRawTranscript": false
}
```

These values and field names are **proposals**, not released behavior. Do not hardcode a provider, depend on undocumented free tiers, or assume a judge reports calibrated confidence. Provide clear behavior when a model cannot answer typed questions or when credentials are absent. A provider/model change or compiler-prompt change must invalidate only the relevant cached checklist; judge prompt/model changes affect audit keys, not necessarily the compiled rules.

Provider calls must use timeouts, bounded retries/backoff, structured validation, rate-limit handling and human-readable errors. Any prompt overrides must be included in the relevant cache/version fingerprint. Avoid storing tokens in project files.

## 10. Delivery milestones

Each milestone must have tests and an independently reviewable commit. Do not add unrelated functionality to a milestone.

1. **Core contracts and fixtures:** instruction sources, checklist/decision schemas, normalized execution events, audit report, state machine, failure handling.
2. **Compiler/cache:** effective instruction discovery contract, priority resolution, canonical hashing, JSON validation, atomic cache, invalidation tests.
3. **Judge pipeline:** batched model predicates, result mapping, evidence-based findings, uncertainty policy, deterministic correction routing, replay fixtures.
4. **OpenCode v2 adapter:** actual plugin loading/config, completion recognition, transcript extraction, correction delivery, human-origin gating and live integration tests.
5. **Claude Code adapter:** hook installer/config, Stop continuation, transcript replay, user waits, host loop guards and live integration tests.
6. **Polish/release:** documented configuration and prompts, error reporting, portable file locations, cleanup, reproducible tests, optional package publication only after validation.

Start by reproducing an OpenCode v2 turn end and a Claude Code `Stop` cycle in small test harnesses. If host behavior differs from this design, update the adapter and tests rather than weakening the shared invariants. Prefer **OpenCode v2 as the first end-to-end integration** while keeping the core harness-neutral.

## 11. Acceptance test matrix

At minimum, deterministic fixtures plus at least one live smoke run per supported host:

| Scenario | Expected outcome |
| --- | --- |
| Same unchanged global + project rules across sessions | Checklist compiled once and reused |
| One source / compiler prompt / compiler model / schema changes | Correct targeted cache miss |
| Two conflicting rules with unresolved precedence | Unknown/conflict, no fabricated violation |
| Rule says "review before commit"; review still possible before final turn | No premature violation |
| Commit happened before required review | Evidence-backed temporal violation even if later review occurs |
| Agent did comply despite terse final summary | Pass based on tool/transcript evidence |
| Missing transcript/tool records | Unknown/incomplete, never automatically guilty |
| Correctable, scoped violation | Exactly one correction request, then re-audit |
| Unrepairable historical violation | Accurate finding, no impossible fix loop |
| User decision required, no user response | WAITING_USER; do not auto-continue |
| Synthetic/plugin-origin prompt while waiting | WAITING_USER unchanged |
| Verified real user response after waiting | Resume once, preserve state |
| Repeated completion callback / restart | No duplicate audit or duplicate correction |
| Child-agent work + compaction | Attribution and evidence retained |
| Judge/LLM failure or timeout | Explicit AUDIT_INCOMPLETE, bounded retries |
| More than max correction attempts | STOPPED with transparent audit report |
| OpenCode v2 answer already visible | Follow-up status honest; no claim that response was hidden |
| Claude Stop hook requests correction | Agent receives feedback; no infinite Stop loop |

Instrument per-session calls, input/output tokens, latency, cache hit rate, judge uncertainty, false positives, repair success and cost per approved task. Measure false positives and false negatives on a labeled set of real instruction-following violations before enabling aggressive automation. Never present a model-derived percentage as a validated accuracy metric without ground truth.

## 12. Non-goals for the initial release

No CI security enforcement, no generalized permission firewall, no fine-grained per-tool adjudication, no speculative intervention before the agent acts, no automatic code rollback, no hidden reasoning extraction, no mandatory cloud service, and no support claim for Codex/Pi until their adapters are implemented and tested.

## 13. Official implementation references

Re-check these before coding or publishing because integration APIs change:

- [OpenCode v2 plugin packaging and configuration](https://opencode.ai/v2/docs/plugins)
- [OpenCode v2 server plugin SDK: lifecycle, events, sessions, decisions](https://opencode.ai/v2/docs/build/plugins/server/)
- [OpenCode v2 public API, including session and event types](https://opencode.ai/v2/docs/api)
- [OpenCode v1 -> v2 migration guidance](https://dev.opencode.ai/v2/docs/build/plugins/migrate-v1)
- [Claude Code hooks, Stop feedback, event schemas, and loop protection](https://code.claude.com/docs/en/hooks)

**Definition of done:** Both supported hosts can audit a finished unit against effective instructions, provide specific evidence-backed findings, request bounded safe corrections, respect real user waits, and persist/recover state. A README, scaffolding, or untested example is not a functional release.
