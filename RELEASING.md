# Releasing

Releases are automated with [Release Please](https://github.com/googleapis/release-please). Merging its release pull request is the maintainer's explicit approval: nothing else publishes.

## How a release happens

1. Commit to `main` with [Conventional Commits](https://www.conventionalcommits.org/). Before 1.0, `fix:` bumps the patch version, and `feat:` or a breaking change (`feat!:`, or a `BREAKING CHANGE:` footer) bumps the minor version. `chore:`, `ci:`, `docs:` and `test:` release nothing on their own.
2. On every push to `main`, `publish.yml` runs Release Please. It keeps one pull request open, titled like `chore(main): release 0.2.0`, which sets the next version everywhere, adds the section to `CHANGELOG.md` and updates `.release-please-manifest.json`.
3. Merge that pull request. Release Please then tags `v` plus the version and creates the GitHub release, and the same workflow checks that every package carries that version, runs the tests and publishes each package not on npm yet.

`release-please-config.json` lists every file that holds the version: the three workspaces, the adapters' `fidelis` dependency, `packages/claude-code/.claude-plugin/plugin.json` and the lockfile. A new place that holds the version must be added there.

To force a version, add a `Release-As: 1.0.0` footer to a commit on `main`.

## One-time repository settings

- **Settings, Actions, General, Workflow permissions:** enable "Allow GitHub Actions to create and approve pull requests". Without it, Release Please cannot open its pull request.
- **CI on the release pull request:** a pull request opened with the workflow's `GITHUB_TOKEN` starts no workflows, so `ci.yml` does not run on it. The publish job runs the tests again before publishing. To get CI on the pull request too, store a fine-grained personal access token with contents and pull request write access as a secret and pass it to the action as `token`.
- **`npm-publish` environment:** releases now publish from a push to `main`, so a branch restriction that allows `main` is enough.

## Manual publish

`publish.yml` can also be dispatched by hand from `main`. It then publishes every listed workspace whose version is not on npm yet, without Release Please. Use it to retry a failed publish.

## Packages

Publish in this order, because the adapters depend on the core:

1. `fidelis`
2. `fidelis-claude-code`
3. `fidelis-opencode`

The names are unscoped, so the first publish of each one is what claims it. npm has no reservation without publishing, and it may reject a name as too similar to an existing package only at publish time. `@insign/...` is the fallback, because that scope belongs to the `insign` npm account.

## Validate before any publish

```bash
npm ci && npm test
npm pack --dry-run --workspace fidelis
npm pack --dry-run --workspace fidelis-claude-code
npm pack --dry-run --workspace fidelis-opencode
node tests/live/pack-smoke.mjs
```

## First publish (token bootstrap)

Trusted publishing is configured on an existing package, so the first version of each package goes out by hand:

```bash
npm login
npm publish --workspace fidelis --access public
npm publish --workspace fidelis-claude-code --access public
npm publish --workspace fidelis-opencode --access public
```

Use the smallest scoped credential available. Never commit a token or `.npmrc` secret.

## Enroll OIDC, once per package

On npmjs.com, open each package, then Settings, then Trusted publishing, and add a GitHub Actions publisher:

| Field | Value |
| --- | --- |
| Organization or user | `insign` |
| Repository | `fidelis` |
| Workflow filename | `publish.yml` (filename only) |
| Environment | `npm-publish` |

Allow direct `npm publish` if npm offers that choice. GitHub creates the `npm-publish` environment on first use. Required reviewers are optional: merging the release pull request is already an explicit approval. With reviewers set, each release also waits for one of them to approve the run.

Run one real publish through the workflow, by release pull request or manual dispatch, within two days of registering each publisher; npm's registration expires otherwise. If it expires, delete and recreate it. `npm whoami` does not test trusted publishing.

## After OIDC works

Select npm's "require 2FA and disallow tokens" policy and revoke the bootstrap token. Do this only after a successful workflow publish of every package.

## Failures

- `ENEEDAUTH` or `E404` with correct permissions: the owner, repository, workflow filename, environment or `repository.url` differs from npm's record.
- Bad release: publish a fixed patch and `npm deprecate` the bad version. Avoid `npm unpublish`.
- Installing private dependencies needs a separate read-only token. It must never have publish rights.

Re-check [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) before the first release: Node and npm requirements and expiry rules can change.
