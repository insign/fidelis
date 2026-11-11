# Changelog

## Unreleased

- **Breaking**: The compiler, judge, state machine, evidence ledger and OpenCode TUI are replaced by a self-review. At the end of each turn, the same agent is asked once, in the same session, to review the turn against the instructions it loaded: fix what it may, weigh whether each rule was needed, list what needs the user and wait, and reply in the user's language.
- **Claude Code**: Only a `Stop` hook remains. `install` and `uninstall` also remove the `SessionStart` hook of earlier versions. The `status` command is gone.
- **OpenCode**: The plugin has no options, and the footer and `/fidelis` panel are gone.
- **Configuration**: All options are gone and earlier ones are ignored. State left by earlier versions in the cache directory can be deleted.

## 0.1.4 (2026-11-06)

- **Core**: Deterministic single-line/event digests with IDs, escape, and redaction before clipping; Jev state+question and state+request preflight budgets; compact citation windows with real cost and printable none; bounded `max_tokens_exceeded` splitting without identical retries; raw spans limited to headroom and explicit `UNKNOWN` when they do not fit; optional `inputTokens`.
- **Rules & Superseders**: Unknown superseders do not retire applicable rules.
- **TUI & Labels**: Compact labels with emojis (Monitoring->idle, Approved->OK).
- **Adapters**: Claude Code and OpenCode packages updated to depend on core 0.1.4.
