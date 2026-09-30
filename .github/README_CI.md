# GitHub Automation

Ryco keeps CI entrypoints small and routes shared checks through
`.github/workflows/_validation.yml`.

- `ci.yml` validates `main` and manual CI runs with the full suite.
- `pull-request-validation.yml` is the single automatic source of truth for
  branches. `pr-vouch.yml` dispatches validation for `vouch:trusted` PRs; an
  unvouched PR requires a maintainer's manual dispatch. Its gate fetches the PR
  through the API to check trust and supply the base SHA for affected-package
  validation. The reusable workflow resolves scope from the checked-out merge
  commit. `main` always runs the full suite.
- `branch-ci.yml` manually validates an arbitrary branch/ref on demand
  (`workflow_dispatch`) with format, lint, typecheck, and tests. It does not run
  on push, so a commit is never validated twice (once on push and once on its
  PR) — pull request validation owns automatic branch CI.
- `worktree-validation.yml` manually validates a worktree-backed ref and records
  the local worktree label/path in the run summary when provided.

## Parallelism and path scoping

`_validation.yml` runs each check as its own job so they execute in parallel
rather than as one serial chain. Static, build, web, and remaining-package jobs
use two-core Blacksmith runners; server and browser shards use GitHub-hosted
`ubuntu-24.04`. Release builds use GitHub-hosted macOS arm64, Ubuntu x64/arm64,
and Windows x64/arm64 runners.

`scripts/ci/test-matrix.ts` resolves Turbo's dry test plan once. Selected server
tests run in three shards, selected web tests get a separate runner, and every
other selected package goes into the remaining-package job. This works for both
PRs and full runs, includes new test packages automatically, and avoids mixing
Turbo's incompatible `--filter` and `--affected` flags. Workspaces without test
scripts are omitted. TypeScript and Effect diagnostics share the normal
`typecheck` job through `@effect/tsgo`.

Server integration files stay serial and isolated within each shard. A small,
explicitly audited allowlist in `apps/server/test/pureTests.ts` runs in a separate
Vitest project without resetting its module cache between files. New files stay
isolated by default. Before extending the allowlist, inspect transitive imports
and test setup for mocks, global mutation, shared state, native resources, and
I/O; validate additions with shuffled file/test order. For example:

```sh
bun run --cwd apps/server test --project=pure --sequence.shuffle --sequence.seed=1234
```

Browser files stay serial within each of four shards. ChatView's six suites
share one harness but separate composer, conversation, navigation, workspace,
phone composer, and phone surface assertions so no single giant file dominates
one shard.

## Affected scoping and caching

On PRs, `pull-request-validation.yml` passes `affected-base` (the base branch
SHA) into `_validation.yml`, which sets `TURBO_SCM_BASE` and uses `--affected`
for typecheck, build, and the test dry plan. Turbo selects the packages the diff
touches **and their dependents** (a change to
`packages/contracts` still tests everything that imports it). Full history is
checked out (`fetch-depth: 0`) in those jobs so Turbo can compute the diff; `main`
and manual runs pass no base and validate every package.

Caching compounds this: `typecheck` and `build` are Turbo-cached (unchanged
packages are skipped and their pass/fail memoized by input hash), while `test`
stays uncached because tests may not be pure. `globalDependencies` lists the
shared root compiler/test configuration, cross-workspace build helpers, and
resource-monitor inputs so editing them invalidates caches, and the
`.turbo` action cache uses a per-commit key with `restore-keys` so it accumulates
run to run instead of freezing at a lockfile-stable key.

`browser`, `desktop`, and `release-smoke` stay gated behind the `run-*` inputs.
On PRs `validationScope` in the test-matrix script combines changed paths with
affected dependents. Runtime changes that affect web require browser tests;
changes affecting web, server, or desktop require desktop validation. Unit-only
and documentation changes skip these expensive jobs. Hosted Hub/PWA test sources
referenced by browser acceptance tests still trigger the browser suite. Root
configuration, scripts, patches, and CI infrastructure use a conservative
fallback. Full runs enable every requested check regardless of paths. Most build
inputs exclude documentation and unit tests. The web build keeps tests and
browser harnesses in its hash because Tailwind scans them when generating CSS.

Shared toolchain setup lives in `.github/actions/setup-ryco`, so new workflows
should reuse that action instead of duplicating Vite+, Bun, Node, cache, and
install steps. The action uses `setup-vp` for Vite+ and Node, sets up Bun
explicitly for Ryco's command surface, and installs dependencies with
`bun install --frozen-lockfile` using the pinned Bun version. Static, matrix,
browser, and release-smoke jobs skip installing the resource-monitor Rust toolchain. The
action also restores the toolchain cache and the explicit
workspace-local Turbo cache; browser validation restores the pinned Playwright
runtime cache.

Reusable validation uses Ryco's canonical Bun entrypoints: `bun run fmt:check`,
`bun run lint`, `bun run typecheck`, `bun run test`, and `bun run build`.
Those scripts call Vite+ where applicable, while keeping one CI command surface
for the monorepo.

## Timing reports

CI unit and browser runs write JSON and JUnit reports in each package's
`test-results/` directory. Each shard uploads its reports for 14 days and appends
test totals and the ten slowest files to its job summary. File durations measure
test execution; Vitest's console duration breakdown also includes module imports
and runner startup. Browser artifacts also include automatic failure screenshots;
tests do not write unasserted task screenshots during successful runs. Local runs
retain normal console reporting. To produce the
same reports locally, set `CI=true` for a focused test command, then run
`bun scripts/ci/summarize-tests.ts` from the repository root.
