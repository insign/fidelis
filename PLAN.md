# Fidelis: implementation plan

**Status:** specification, not implemented. **Repository:** `insign/fidelis`. **License:** MIT.

This is the authoritative implementation brief for the first release. Implement only the functionality and files needed for the milestones, preserve the repository's existing license, and validate real host APIs against their current documentation and an installed host before calling an integration complete. Fidelis' public description is: **Harness-agnostic AI agent auditor that verifies compliance with AGENTS.md, detects behavioral violations, and drives autonomous corrections.**

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

Gather **all applicable instructions**, not just two hardcoded files. Support root/global and project-level `AGENTS.md`; in Claude Code also resolve `CLAUDE.md`, applicable `.claude/rules/` content and lazily loaded/scoped instructions where observable. Recent Claude Code versions can load `AGENTS.md` natively: its default prefers `CLAUDE.md` when present but uses `AGENTS.md` otherwise, with a setting to load both. Discover what the harness **actually loaded**, including relevant versions/options and import behavior; do not double-count or audit instructions the host excluded. The effective set depends on current project, working directory, file scope, configured instruction precedence and active host. Record original path, hash, priority, scope, and exact text for each source.

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

The compiler **translates instructions; it does not judge the agent's execution**. Proposed default on OpenCode v2: **Big Pickle** (`opencode/big-pickle`); proposed default on Claude Code: **Claude Haiku 5.5, xhigh effort**. Use the host's configured/authorized model transport rather than assuming model access. Big Pickle is documented as free **for a limited time** and submitted data may be used for model improvement; this must be disclosed and sensitive content filtered or explicitly authorized before transmission. Support configurable model replacements, provider failures and an explicit no-compiler / incomplete-audit outcome rather than silently switching to a paid model. Run the compiler once per effective fingerprint on the first applicable session/turn; prewarming is optional. Persist a structured, schema-validated checklist. On cache hit, do not call the compiler.

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

Provide the compiled checklist, current user instruction, normalized evidence, final reply and prior unresolved audit findings to a configurable decision model. On OpenCode v2, prefer **Jev 1.13 Free** where currently available and compatible with the experimental Decisions API; both model availability and its free tier may change. The OpenCode v2 API exposes `predicate`, choice and score questions; **do not assume a provider-specific `noul` field is portable**. Claude Code has no native OpenCode Decisions transport: allow an explicitly configured external Jev client, or a **Claude Haiku 5.5 xhigh** structured-classification fallback with schema validation. Never silently access external providers or imply that Haiku produces native Jev probabilities.

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

- Register via the documented v2 plugin entry point (`Plugin.define({ id, setup(ctx) })`) and `plugins` array in `opencode.json(c)` with `package` and `options`. Default compiler: `opencode/big-pickle`; default judge: an available `opencode/jev-1.13-free`, with user-configured overrides. Check model availability and authorization explicitly.
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
- For the default compiler, use Claude Haiku 5.5 at `xhigh` effort through a supported authenticated Claude transport. For judging, use an explicitly authorized external Jev endpoint or Haiku xhigh with structured outputs and equivalent deterministic routing; do not assume OpenCode's experimental Decisions API exists inside Claude Code. Isolate hook invocation from nested Claude subprocess sessions to prevent recursion.
- Verify behavior across restarts, resume, compaction, user interruptions, hooks timing out and Windows/Unix hook launchers.

## 9. User configuration and prompts

Package default prompts, a compiler model, a judge model, thresholds, budget limits and feedback templates. Allow host-specific overrides without forking the core. Ship host-specific defaults: OpenCode v2 uses Big Pickle for checklist compilation and Jev for Decisions when available; Claude Code uses Haiku 5.5 at xhigh for checklist compilation and either configured Jev or Haiku xhigh for judging. Avoid imposing paid or transiently free provider use on users without disclosure and an override.

Proposed configuration schema (names to stabilize before implementation):

```json
{
  "enabled": true,
  "compilerModel": "auto",
  "compilerEffort": "auto",
  "judgeModel": "auto",
  "judgeEffort": "auto",
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

These values and field names are **proposals**, not released behavior. In this sketch, `auto` resolves from the host-specific defaults above; `compilerEffort`/`judgeEffort` are ignored or rejected with a clear message where unsupported. Do not hardcode a provider outside host-specific defaults, depend on permanently free tiers, or assume a judge reports calibrated confidence. Provide clear behavior when a model cannot answer typed questions or when credentials are absent. A provider/model change or compiler-prompt change must invalidate only the relevant cached checklist; judge prompt/model changes affect audit keys, not necessarily the compiled rules.

Provider calls must use timeouts, bounded retries/backoff, structured validation, rate-limit handling and human-readable errors. Any prompt overrides must be included in the relevant cache/version fingerprint. Avoid storing tokens in project files.

## 10. Delivery milestones

Each milestone must have tests and an independently reviewable commit. Do not add unrelated functionality to a milestone.

1. **Core contracts and fixtures:** instruction sources, checklist/decision schemas, normalized execution events, audit report, state machine, failure handling.
2. **Compiler/cache:** effective instruction discovery contract, priority resolution, canonical hashing, JSON validation, atomic cache, invalidation tests.
3. **Judge pipeline:** batched model predicates, result mapping, evidence-based findings, uncertainty policy, deterministic correction routing, replay fixtures.
4. **OpenCode v2 adapter:** actual plugin loading/config, completion recognition, transcript extraction, correction delivery, human-origin gating and live integration tests.
5. **Claude Code adapter:** hook installer/config, Stop continuation, transcript replay, user waits, host loop guards and live integration tests. Include direct/native AGENTS.md loading without InstructionsLoaded, CLAUDE.md override settings, and nested/imported-rule fixtures.
6. **Polish/release:** documented configuration and prompts, error reporting, portable file locations, cleanup, reproducible tests, npm workspace/package metadata and a validated release workflow. Bootstrap each public scoped npm package with an explicitly authorized first publish, then configure and validate **npm Trusted Publishing via GitHub Actions OIDC** for subsequent releases. See §14. Do not publish without the maintainer's explicit approval.

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
| Claude native AGENTS.md without CLAUDE.md | Source included in checklist even though InstructionsLoaded may not fire |
| Claude both instruction files under default versus combined setting | Only actually loaded sources govern the checklist |
| OpenCode v2 completion candidate fires without final turn | No audit until final top-level turn is verified |
| Jev native noul versus OpenCode predicate transport | Typed adapter converts correctly, no guessed API format |
| Synthetic prompt or automated correction reported as human input | WAITING_USER stays locked |
| Model unavailable or no user authorization for sending sensitive rules | Explicit incomplete audit or consent action; no silent paid fallback |

Instrument per-session calls, input/output tokens, latency, cache hit rate, judge uncertainty, false positives, repair success and cost per approved task. Measure false positives and false negatives on a labeled set of real instruction-following violations before enabling aggressive automation. Never present a model-derived percentage as a validated accuracy metric without ground truth.

## 12. Non-goals for the initial release

No CI security enforcement, no generalized permission firewall, no fine-grained per-tool adjudication, no speculative intervention before the agent acts, no automatic code rollback, no hidden reasoning extraction, no mandatory cloud service, and no support claim for Codex/Pi until their adapters are implemented and tested.

## 13. Official documentation: required reading and validation

**Instruction to the implementation agent:** Read this `PLAN.md` first. It is the project's source of truth. Then consult the **official documentation for each host and provider at the moment of implementation**. Do not implement lifecycle integration from remembered v1 signatures, third-party examples, or assumed event semantics. Record the tested OpenCode / Claude Code versions, relevant API signatures and smoke-test evidence in the implementation work. If documentation and observed behavior differ, investigate and adapt the host adapter; preserve the core's normative invariants.

### 13.1 Mandatory: host APIs, rules, and decisions

| Priority | Official reference | What the agent must verify |
| --- | --- | --- |
| **P0** | [OpenCode v2 Server Plugin SDK](https://opencode.ai/v2/docs/build/plugins/server/) | `Plugin.define({ id, setup(ctx) })`, event subscription, lifecycle, session context and correction prompts, `ctx.experimental.generate.decisions`, registration and error handling. |
| **P0** | [OpenCode v2 API Reference](https://opencode.ai/v2/docs/api) | Actual session/message/inbox types, event schemas, event source attribution, transcript completeness and reliable final-turn boundaries. |
| **P0** | [Claude Code Hooks Reference](https://code.claude.com/docs/en/hooks) | `SessionStart`, `UserPromptSubmit`, `InstructionsLoaded`, `Stop`, structured hook output, `stop_hook_active`, transcript paths, stop-continuation limits and failures. |
| **P0** | [Claude Code: AGENTS.md and project instruction loading](https://code.claude.com/docs/en/memory#agentsmd) | Host/version-dependent `AGENTS.md` support, precedence with `CLAUDE.md`, setting `claude-md-and-agents-md`, imports, nested paths and effective instructions. |
| **P0** | [OpenCode v2: Instructions](https://opencode.ai/v2/docs/instructions) | Global/project/nested `AGENTS.md`, instruction inheritance and inclusion; avoid auditing files the host did not actually load. |
| **P0** | [TypeSafe / Jev: typed decision primitives](https://docs.typesafe.ai/introduction) | `noul` binary judgments, `choice`, `score`, independent batched questions and their probability/confidence semantics. |

### 13.2 Mandatory before provider and distribution work

| Priority | Official reference | What the agent must verify |
| --- | --- | --- |
| **P1** | [OpenCode Console: Models](https://opencode.ai/v2/docs/console/models/) | Big Pickle and Jev identifiers, allowed transports, actual availability, free-tier terms, rate limits and data usage policies. |
| **P1** | [Claude Code: Model configuration](https://code.claude.com/docs/en/model-config) | Haiku 5.5 selection and `xhigh` effort, overrides, caps and supported invocation forms; no unverified inheritance to nested processes. |
| **P1** | [Anthropic API: Effort](https://platform.claude.com/docs/en/build-with-claude/effort) | Effort request compatibility when calling Haiku outside the interactive Claude Code CLI. |
| **P1** | [OpenCode v2: Plugin packaging](https://opencode.ai/v2/docs/build/plugins/) | Exports, package layout, `@opencode/plugin` compatibility, `plugins` configuration and publication approach. |
| **P1** | [Claude Code: Plugin manifest reference](https://code.claude.com/docs/en/plugins-reference) | `.claude-plugin/plugin.json`, hook packaging, installed path resolution, user config and plugin validation. |
| **P2** | [OpenCode v1 to v2 migration guide](https://opencode.ai/v2/docs/build/plugins/migrate-v1) | Why v1 hooks/exports are incompatible and which legacy examples must **not** be copied. |
| **P2, release only** | [npm: Public scoped packages](https://docs.npmjs.com/creating-and-publishing-scoped-public-packages/) | Owning `@insign` or the eventual scope, public package access, authentication and first publication. No pre-registration is needed while only designing. |
| **P2, release only** | [npm: Trusted Publishing](https://docs.npmjs.com/trusted-publishers/) | Per-package trusted publisher setup, two-day validation window, OIDC constraints, token restrictions, provenance and troubleshooting. |
| **P2, release only** | [GitHub: setup-node OIDC publishing](https://github.com/actions/setup-node/blob/main/docs/advanced-usage.md#publishing-to-npm-with-trusted-publisher-oidc) | Node/npm compatibility, GitHub-hosted runners, registry configuration and release-build caching policy. |

### 13.3 Non-negotiable integration findings to account for

1. **Claude Code does not emit `InstructionsLoaded` for an `AGENTS.md` loaded directly through the native Project instructions setting.** The hook observes `CLAUDE.md`, `.claude/rules/*.md`, and imported/symlinked `AGENTS.md` as described by its docs. Instruction discovery therefore cannot rely on `InstructionsLoaded` alone. Determine which files actually govern each turn, including lazily loaded rules, without double-counting.
2. **Native Claude Code `AGENTS.md` support is version-dependent** (documentation currently specifies v2.1.277+). With the default `claude-md-or-agents-md`, an applicable project `CLAUDE.md` can cause project `AGENTS.md` to be omitted. The `claude-md-and-agents-md` setting changes that. Check host settings, effective instruction scopes and version, not file existence alone.
3. **Claude Code `Stop` is the final-response integration point, not a per-tool veto.** It does not run on user interruptions, and API failures have their own event behavior. Stop-hook feedback can continue the same agent; `stop_hook_active` and host continuation limits provide backup loop guards. Prefer the documented, non-error guidance mechanism when appropriate; test feedback text actually reaching the agent.
4. **OpenCode v2 completion requires live validation.** Treat any `session.execution.succeeded`-like event name as a *candidate*, not as proof of final top-level response. Confirm exact installed-version schema and correlate it with the last assistant reply, pending tools/background tasks, turn ID and duplicate callbacks. An idle or completion event alone may not establish finality.
5. **Jev protocols are distinct.** Native TypeSafe documents a `noul` primitive (value between 0 and 1); OpenCode's `ctx.experimental.generate.decisions` examples use a `predicate` question. Write a provider adapter and typed tests; never pass native `noul` payloads to the OpenCode API by assumption. Calibrate thresholds and preserve evidence citations.
6. **Human prompts are not automatically trustworthy human-origin proof.** A `UserPromptSubmit`/`prompt` callback may be triggered by automation or a corrective turn. Validate IDs and message source; synthetic/promoted messages must not release `WAITING_USER`.
7. **Models and privacy are not static contracts.** Big Pickle's free access is time-limited according to the official catalog, and free-period data may be used to improve it. Check availability, user authorization, redaction and disclosure at runtime. Haiku 5.5 supports `xhigh`, but effort caps may apply. Do not silently replace a free/default model with a billable one.

### 13.4 Mandatory proof-of-behavior before broader implementation

Before writing large architectural scaffolding, build the smallest possible exploratory fixture for **each** host and record the observations and host versions:

1. **OpenCode v2 end-to-end turn boundary:** user message → tools → main agent's final reply → exactly one audit. Prove the correct event and fields with a real session and check what was already shown to the user.
2. **OpenCode v2 evidence + corrective prompt:** retrieve the full attributable tool/session timeline, submit a marked corrective prompt, confirm it reaches the same main agent, and demonstrate no duplicate audit or mistaken human response.
3. **Claude Code `Stop` continuation:** a deliberately violated behavioral rule produces structured feedback, the same agent resumes, and a subsequent clean completion terminates. Exercise `stop_hook_active`, host continuation cap, interrupt/error cases and hook timeout.
4. **Claude instruction-loading matrix:** with `AGENTS.md` only, `CLAUDE.md` only, both under each supported setting, imported `AGENTS.md`, and nested rules, compare the *effective* instructions against the Fidelis checklist. Prove direct `AGENTS.md` loads are not inferred from `InstructionsLoaded`.
5. **Decision adapters:** submit the same well-scoped binary/uncertain fixtures to the OpenCode Decisions API and to the external judge path; verify typed results, confidence handling and fallback. Do not infer that a plausible probability demonstrates calibrated compliance judgment.
6. **User-wait state:** after the agent asks the user a necessary question, verify synthetic plugin feedback and automatic turns do **not** clear `WAITING_USER`; a newly observed real human reply does. Test both hosts.
7. **Model configuration and privacy:** resolve the actual provider/model/effort IDs; show behavior when Big Pickle/Jev are unavailable, a permission or key is absent, or the configured provider rejects sensitive input. Check that no paid fallback is silently selected.

**Pass condition:** the exploratory fixture has captured actual event shapes and deterministic replay cases. If any item cannot be proven in the installed host, document the limitation, leave that integration unverified, and do not advertise it as working. Then implement shared core and production adapters using the validated contracts.

## 14. npm release and GitHub Actions OIDC (release milestone only)

**Status: documentation/plan, not executed.** No npm packages are published and no GitHub Actions release workflow is installed by this document change. Publication must require explicit maintainer authorization; developing or merging code is not permission to push a release.

### 14.1 Packages and initial bootstrap

The repository is a monorepo. The *proposed* public packages are `@insign/fidelis` (shared core), `@insign/fidelis-opencode` (OpenCode adapter) and `@insign/fidelis-claude-code` (Claude Code adapter). Verify the final package names, which packages should truly be public, workspace dependencies, and that the publisher **controls the npm scope** `@insign`. A GitHub username does not confer npm namespace ownership. Keep unpublished/internal workspaces `private: true`.

1. Validate the release artifacts, npm `name`, `version`, `exports`, `files`, `license`, `publishConfig.access: "public"`, README, and `repository.url` (must match `https://github.com/insign/fidelis`). Run `npm pack --dry-run` for each publishable workspace, plus actual package install/smoke tests.
2. **Bootstrap the first version of each package using an authorized interactive/npm-token publication** (for example, `npm publish --access public` from the appropriate workspace) after release approval, since configuration of a trusted publisher is managed through the npm package settings. Use the smallest possible scoped publish credential, do not commit tokens or `.npmrc` secrets and do not print them in CI output.
3. Once a package exists, open **npmjs.com → package → Settings → Trusted publishing** and create a GitHub Actions trusted publisher **for that package**. Do not assume that one trusted-publisher registration covers every monorepo package.
4. Configure publisher identity: **Organization/user:** `insign`; **Repository:** `fidelis`; **Workflow filename:** `publish.yml` (filename only, not `.github/workflows/publish.yml`); **Environment:** optional, but it must exactly match the workflow if specified. On current npm settings, explicitly enable **direct `npm publish`** as an allowed action if using direct publishing; stage-only configurations require a separate human approval workflow.
5. **Perform a successful OIDC publication within two days of registering each trusted publisher.** Current npm documentation requires first use within 48 hours to validate and bind the publisher to the immutable repository identity; an expired registration must be deleted and recreated.
6. After OIDC is demonstrated, select npm's **require 2FA and disallow tokens** publishing policy where appropriate, and revoke any bootstrap/write tokens that are no longer needed. Do **not** disable token publishing before the trusted path is validated.

### 14.2 GitHub Actions workflow contract

Create `.github/workflows/publish.yml` as part of implementation, not while merely planning. The release job must run on a **GitHub-hosted runner** (OIDC trusted publishing currently does not support self-hosted runners), use **Node.js 24** and **npm CLI >= 11.5.1** (Node >= 22.14.0 is the npm minimum), and configure:

```yaml
permissions:
  contents: read
  id-token: write

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v6
      - uses: actions/setup-node@v6
        with:
          node-version: '24'
          registry-url: 'https://registry.npmjs.org'
          package-manager-cache: false
      - run: npm ci
      - run: npm run build --if-present
      - run: npm test
      # Publish only explicitly approved, validated and version-bumped workspaces.
      # In the monorepo publish each package in dependency order or use a proven
      # release tool; do not blindly run npm publish at the repository root.
```

This is a **permissions/runner skeleton**, not an enabled publishing workflow. During implementation, choose a release trigger (protected version tag or explicitly approved manual dispatch), pin reviewed action versions, enforce branch/tag protections and/or an approval-gated environment when used, validate workflow identity, and add exact `npm publish --workspace <name> --access public` commands only for packages actually approved for release. Keep publish jobs isolated from untrusted PR code. Avoid caching dependencies in release jobs (`package-manager-cache: false`).

With successful trusted publishing, **OIDC supplies temporary credentials automatically; no `NPM_TOKEN` or `NODE_AUTH_TOKEN` is needed for public-package publishing**. npm generates provenance attestations automatically for public packages published from the public repository. A read-only token may still be needed separately to *install* private dependencies; never give that token publishing permissions.

### 14.3 Validation and failure cases

- Run `node --version`, `npm --version`, `npm pack --dry-run` and tests before publishing; confirm each workspace resolves from an installed tarball and the published version is not already present.
- Test that the GitHub owner/repository, exact workflow filename, optional environment and each package's `repository.url` match npm's trusted publisher records. Mismatches can yield `ENEEDAUTH` or `E404` despite correct OIDC permissions.
- Validate OIDC with an **authorized actual publish**; `npm whoami` is **not** a valid test of trusted-publishing permission. Avoid no-op fake validations or a needless new public version.
- Confirm no traditional npm write token is referenced by the steady-state workflow; ensure release output has correct provenance and installed artifacts contain only intended files.
- Publish each package's version and dependency graph deliberately: dependencies must be available before dependent adapters. A GitHub monorepo and one workflow can publish multiple packages, but trusted publisher entries remain **per npm package**.
- Document manual bootstrap, OIDC enrollment, a rollback/remediation process for failed releases, dependency install auth and configuration-expiry recovery.
- Re-check [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) before the first release: eligibility, allowed actions, Node/npm versions and expiry behavior can change.

**Definition of done:** Both supported hosts can audit a finished unit against effective instructions, provide specific evidence-backed findings, request bounded safe corrections, respect real user waits, and persist/recover state. A README, scaffolding, or untested example is not a functional release.
