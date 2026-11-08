# Development

This repository holds the patch and the build/release tooling. End users should install from the versioned tools bundle described in the [README](../README.md).

## Building

You need Node.js 22, Python 3.9+, Git, curl and tar. Browser checks use Playwright's Chromium.

```sh
BROWSER_TEST=1 scripts/build-release.sh v0.107.79 dist
```

The patch is written against the tag in `patch/PATCH_BASE` and applied to newer tags with a three-way merge. The build script runs, in order:

1. The Python test suites (validation, installer/updater, bootstrap).
2. Patch application, plus a whitespace check on the applied source.
3. Type checking, lint and the frontend unit tests.
4. A production build.
5. Browser tests for the Live Query Log (only with `BROWSER_TEST=1`).
6. An integration test against the official AdGuard Home binary (skip with `SMOKE_TEST=0`).

If everything passes, `dist/` gets three archives, each with a `.sha256` file:

| Archive | Contents |
| --- | --- |
| `agh-patcher-tools.tar.gz` | Installers, Docker override template, the `agh-patcher` CLI, the launcher, `release-manifest.py`, the licence and `TOOLS.json`. |
| `agh-dashboard-range.tar.gz` | The built frontend with its `VERSION`, `MANIFEST.json`, notice and licence. |
| `agh-dashboard-range-source.tar.gz` | The patched upstream source and this repository's build/install scripts, for GPL compliance. |

On failure the script writes a short reason to `dist/REASON`.

## Integration test

`scripts/tests/querylog-real-api.cjs` starts the official binary with a throwaway config in a temp directory. Everything binds to `127.0.0.1` on random high ports, so it doesn't need root and never touches port 53 or the host's DNS. Upstream resolvers point at a local trap that fails the test if anything tries to leave the box, and filtering lists, update checks and similar features are switched off.

The test sends 1,352 real DNS queries and checks that:

- cursor pagination via `older_than` returns every record once, newest first;
- the frontend's catch-up helper (the actual bundled code, not a copy) recovers a burst within its page budget, and reports a gap and rebases when the budget is exceeded;
- server-side filters are carried through every recovery request;
- no records are modified by the process.

With `BROWSER_TEST=1` the same server is also driven from the production UI in Chromium. The browser's network guard blocks external origins and the server's "clear log" endpoint.

Some things can't be tested this way: exact nanosecond timestamp ties can't be forced through the real binary (unit tests cover them), and AdGuard Home's file scan stops after 50,000 candidates, so sparse filters can return empty pages with a continuation cursor. See [API limits](live-query-log-controls.md#api-limits).

## Release identities

There are three hashes, each with a different job:

- **Frontend revision** (`patch:` in release notes, `patch_revision` in the manifest). A SHA-256 over the built `build/static` files: each file's hash, keyed by its relative path, sorted. Installed hosts recompute this from the files on disk and compare only this value when deciding whether a frontend update is needed. The frontend is always built in `/tmp/adguardhome-patcher-frontend-build` because webpack's CSS hashes depend on the source path.
- **Frontend input** (`frontend-input:`). A hash of the files listed in `FRONTEND_INPUTS` in `scripts/release-manifest.py`. CI uses it to skip rebuilding when nothing relevant changed.
- **Tooling revision** (`tooling:`). A hash of `TOOLING_INPUTS`, i.e. the installer files plus the build scripts. Stored in `TOOLS.json`, the frontend manifest and the host's config, and used by `agh-patcher check` to report tooling updates.

Docs, tests and the root `install.sh` don't feed into either input hash, so editing them doesn't trigger a new release. `install.sh` is always fetched from `main` and only hands off to the versioned tools bundle, which is the real trust boundary.

`TOOLS.json` also records the source commit so the CLI can link to the [recovery instructions](safety-and-recovery.md#interrupted-updates) at that exact commit.

## GitHub Actions

`.github/workflows/build.yml` does two things:

- **Pull requests:** checks out the PR head with read-only permissions and runs the full gate, including browser tests. Nothing is published.
- **Releases:** on pushes to `main`, every six hours and on manual dispatch, it builds the latest stable AdGuard Home tag. An existing release is left alone if its frontend input and tooling hashes match and all six assets are present. Otherwise the assets are (re)built, verified and uploaded to `ui-<tag>`. If the patch no longer works, an `incompatible` issue is opened instead.

The release job only runs in `and101/adguard-home-patcher`. If you fork the project, update that check and the default repository in `install.sh` and `scripts/agh-patcher.py`.
