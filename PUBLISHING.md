# Publishing the Jaren packages

The repository root and the benchmark/website workspaces are private, as is the
`@jarenjs/josl` research experiment. A release publishes only:

- `@jarenjs/core`
- `@jarenjs/json`
- `@jarenjs/validate`
- `@jarenjs/formats`
- `@jarenjs/refs`
- `@jarenjs/forms`
- `@jarenjs/locales`
- `@jarenjs/view`
- `@jarenjs/app`
- `@jarenjs/md`
- `@jarenjs/mermaid`
- `@jarenjs/calc`

## Authenticate locally

The simplest interactive option is:

```bash
npm login
npm whoami
```

To use a granular npm access token instead, create one on npmjs.com with read/write access to the `@jarenjs` scope. Keep "Bypass 2FA" disabled for an interactive local release; enable it only when a genuinely non-interactive publisher requires it.

Install the token in the user-level npm configuration without putting its value in shell history:

```bash
read -rsp "npm token: " NPM_TOKEN
echo
npm config set //registry.npmjs.org/:_authToken="$NPM_TOKEN" --location=user
unset NPM_TOKEN
chmod 600 "$(npm config get userconfig)"
npm whoami
```

Never put the token itself in this repository's `.npmrc`. Revoke and replace it immediately if it is committed or printed in a shared log.

## Prepare a release

All public workspaces use one version. Increment them and their internal dependency ranges together:

```bash
npm run version:patch
# or: npm run version:minor
# or: npm run version:major
```

Review and commit the resulting manifest changes. The release gate runs lint, all tests, all builds, a TypeScript consumer check, a tree-shaking check, and npm tarball dry runs:

```bash
npm run release:check
```

## Publish

The root command reruns the release gate and publishes only the twelve public workspaces:

```bash
npm run publish
```

npm may prompt for a one-time password when account/package policy requires 2FA. After publishing, verify the versions:

```bash
npm view @jarenjs/core version
npm view @jarenjs/json version
npm view @jarenjs/validate version
npm view @jarenjs/formats version
npm view @jarenjs/refs version
npm view @jarenjs/forms version
npm view @jarenjs/locales version
npm view @jarenjs/view version
npm view @jarenjs/app version
npm view @jarenjs/md version
npm view @jarenjs/mermaid version
npm view @jarenjs/calc version
```

For automated releases, prefer npm trusted publishing with OIDC over a long-lived write token.
