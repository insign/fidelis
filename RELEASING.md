# Releasing

Publishing needs the maintainer's explicit approval. Merging or tagging does not publish anything: `publish.yml` runs only by manual dispatch from `main`, through the `npm-publish` environment.

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

Allow direct `npm publish` if npm offers that choice. GitHub creates the `npm-publish` environment on first use. Required reviewers are optional: the workflow already runs only by manual dispatch from `main`.

Run one real publish through the workflow within two days of registering each publisher; npm's registration expires otherwise. If it expires, delete and recreate it. `npm whoami` does not test trusted publishing.

## After OIDC works

Select npm's "require 2FA and disallow tokens" policy and revoke the bootstrap token. Do this only after a successful workflow publish of every package.

## Failures

- `ENEEDAUTH` or `E404` with correct permissions: the owner, repository, workflow filename, environment or `repository.url` differs from npm's record.
- Bad release: publish a fixed patch and `npm deprecate` the bad version. Avoid `npm unpublish`.
- Installing private dependencies needs a separate read-only token. It must never have publish rights.

Re-check [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/) before the first release: Node and npm requirements and expiry rules can change.
