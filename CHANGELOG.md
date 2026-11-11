# Changelog

## [0.2.0](https://github.com/insign/fidelis/compare/v0.1.5...v0.2.0) (2026-11-11)


### ⚠ BREAKING CHANGES

* replace the audit pipeline with an end-of-turn self-review

### Features

* replace the audit pipeline with an end-of-turn self-review ([a8ad863](https://github.com/insign/fidelis/commit/a8ad86388722ca6c2c8eaffa34e47dd68a5bfb48))

## 0.1.4 (2026-11-06)

- **Core**: Deterministic single-line/event digests with IDs, escape, and redaction before clipping; Jev state+question and state+request preflight budgets; compact citation windows with real cost and printable none; bounded `max_tokens_exceeded` splitting without identical retries; raw spans limited to headroom and explicit `UNKNOWN` when they do not fit; optional `inputTokens`.
- **Rules & Superseders**: Unknown superseders do not retire applicable rules.
- **TUI & Labels**: Compact labels with emojis (Monitoring->idle, Approved->OK).
- **Adapters**: Claude Code and OpenCode packages updated to depend on core 0.1.4.
