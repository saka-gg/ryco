# GitHub Automation

Ryco keeps CI entrypoints small and routes shared checks through
`.github/workflows/_validation.yml`.

- `ci.yml` validates `main` and manual CI runs with the full suite.
- `pull-request-validation.yml` is the single automatic source of truth for
  branches. `pr-vouch.yml` dispatches validation for `vouch:trusted` PRs when
  they are opened, reopened, or pushed to, and on a `/recheck-vouch` comment;
  marking a PR ready for review or as a draft changes no code and dispatches
  nothing. An unvouched PR requires a maintainer's manual dispatch. When a PR
  closes or merges, `pr-vouch.yml` dispatches once more: the new run joins the
  PR's concurrency group, which cancels the run in flight, and its gate skips
  the closed PR, since `ci.yml` validates what lands on `main`.
- The gate fetches the PR through the API to check trust, then resolves
  GitHub's test merge of the current head into the current base tip, waiting
  while GitHub recomputes it. Every job checks out that exact SHA instead of
  the moving `refs/pull/N/merge`, and affected-package validation diffs against
  the merge's base parent (the PR's own `base.sha` can lag `main` by hundreds of
  commits). A conflicting PR fails once with a clear message. The reusable
  workflow resolves scope from the checked-out merge commit. `main` always runs
  the full suite.
- Dispatched runs attach their checks to `main`'s head commit, so the PR shows
  the result as the commit status `ryco/pr-validation` on its head: the gate
  posts `pending` (or `failure` for conflicts), and a final `report` job posts
  `success`, `failure`, or `error` for cancelled runs, including runs stopped
  by a merge or superseded by a push. Skipped runs post nothing. Only the gate
  and report jobs hold `statuses: write`, and neither runs PR code.
- `branch-ci.yml` manually validates an arbitrary branch/ref on demand
  (`workflow_dispatch`) with format, lint, typecheck, and tests. It does not run
  on push, so a commit is never validated twice (once on push and once on its
  PR) — pull request validation owns automatic branch CI.
- `worktree-validation.yml` manually validates a worktree-backed ref and records
  the local worktree label/path in the run summary when provided.

## Parallelism and path scoping

`_validation.yml` runs each check as its own job so they execute in parallel
rather than as one serial chain. Static uses a four-core Blacksmith runner
because typecheck is CPU-bound; build, test-matrix, and release-smoke jobs use
two-core Blacksmith runners; server shards, the web and remaining-package jobs,
and browser shards use GitHub-hosted `ubuntu-24.04`. Release builds use
GitHub-hosted macOS arm64, Ubuntu x64/arm64, and Windows x64/arm64 runners.

`scripts/ci/test-matrix.ts` resolves Turbo's dry test plan once. Selected server
tests run in three shards, selected web tests get a separate runner, and every
other selected package goes into the remaining-package job. This works for both
PRs and full runs, includes new test packages automatically, and avoids mixing
Turbo's incompatible `--filter` and `--affected` flags. Workspaces without test
scripts are omitted. TypeScript and Effect diagnostics share the normal
`typecheck` job through `@effect/tsgo`.

Server files run in parallel within each shard, four workers on CI. Every file
outside the pure allowlist below still runs in its own forked process, so module
state, environment, and timers never cross files; the parallel files share only
CPU. Files whose assertions bound wall-clock time or event-loop gaps are listed
in `apps/server/test/timingTests.ts` and run in a `timing` project, one file at
a time after the parallel group, so other files' load cannot stretch what they
measure. A new test that asserts real work finishes within a time budget belongs
on that list (better: make the bound relative or use `TestClock`). Locally the
server takes at most four workers and at most half the cores.
`RYCO_TEST_MAX_WORKERS` overrides its count, on CI too, and Turbo passes it
through to every test task (`vitest.workers.ts`, for other packages
to adopt); `RYCO_TEST_MAX_WORKERS=1` runs every server file serially.

The server, web unit, desktop, mobile, client-runtime, and shared suites split
into Vitest projects with `vitest.pure-projects.ts`. A small,
explicitly audited allowlist in each package's `test/pureTests.ts` runs in a
`pure` project without resetting its module cache between files; every other
file runs in the `isolated` project with Vitest's per-file isolation, and new
files stay isolated by default. Before extending an allowlist, inspect
transitive imports and test setup for mocks, global mutation, shared state,
native resources, and I/O; validate additions with shuffled file/test order.
For example:

```sh
bun run --cwd apps/server test --project=pure --sequence.shuffle --sequence.seed=1234
```

The shared Vitest helpers (`vitest.*.ts`) live at the repo root and are Turbo
global dependencies, so a PR that edits one runs every package's tests. Keep
them out of `scripts/`: `--affected` attributes a file inside a workspace to
that workspace alone, so a helper there would select only `@ryco/scripts`.
Their unit tests are in `scripts/`, since a root file has no test task.

Browser files stay serial within each of six shards. ChatView's six suites
share one harness but separate composer, conversation, navigation, workspace,
phone composer, and phone surface assertions so no single giant file dominates
one shard. The browser config's sequencer
(`apps/web/test/browserShardSequencer.ts`) assigns files longest first to the
least-loaded shard using the per-file CI durations committed in
`apps/web/test/browserTestDurations.json`; files added since the last refresh
count as the median. Every shard computes the same split from the same committed
file, so stale durations only unbalance the shards and never skip or repeat a
file. Refresh the durations from a few recent main runs when the shards drift
apart:

```sh
gh run download <run-id> --pattern 'browser-test-results-*' --dir /tmp/browser-durations/<run-id>
bun scripts/ci/browser-durations.ts /tmp/browser-durations
```

The browser shards are the wall-clock long pole, so they do not wait for the
test-matrix job: each shard resolves the same validation scope itself with
`scripts/ci/test-matrix.ts` right after setup and skips its remaining steps when
browser tests are not required. They run no build at all: Vitest browser mode
serves the app through the Vite dev server, and every `@ryco/*` workspace export
web uses resolves to `src` under the ESM `import` condition, so neither the
`@ryco/web` bundle nor any dependency's `dist/` is read.

## Affected scoping and caching

On PRs, `pull-request-validation.yml` passes `affected-base` (the test merge's
base parent) into `_validation.yml`, which sets `TURBO_SCM_BASE` and uses
`--affected` for typecheck, build, and the test dry plan. Turbo selects the packages the diff
touches **and their dependents** (a change to
`packages/contracts` still tests everything that imports it). Full history is
checked out (`fetch-depth: 0`) in those jobs so Turbo can compute the diff; `main`
and manual runs pass no base and validate every package.

Caching compounds this: `typecheck` and `build` are Turbo-cached (unchanged
packages are skipped and their pass/fail memoized by input hash), while `test`
stays uncached because tests may not be pure. `globalDependencies` lists the
shared root compiler/test configuration, cross-workspace build helpers, and
resource-monitor inputs so editing them invalidates caches. Only Static and
Build restore and save the `.turbo` action cache (the test, browser, matrix, and
smoke jobs run no cacheable Turbo task). It uses a per-commit key with
`restore-keys` so it carries over run to run instead of freezing at a
lockfile-stable key. Build also keeps the verified native build artifacts
(`~/.ryco/cache/native-builds/artifacts`), so the Rust computer-use helper
compiles only when its fingerprint changes. It saves them only when a run
publishes a new entry, because the fingerprint includes the cargo environment,
which no cache key can hash.

The web build compiles React with the Oxc React Compiler and keeps no
transform cache. Build and the browser shards still run the
`restore-react-compiler-cache` and `save-react-compiler-cache` steps, which
restore nothing and save nothing now
(`apps/web/node_modules/.cache/ryco-react-compiler` stays empty). Release
builds and Vercel still set the unused `RYCO_REACT_COMPILER_CACHE=off`, and
`turbo.json` and `apps/web/turbo.jsonc` still list it and
`RYCO_REACT_COMPILER_CACHE_DIR`. A follow-up removes the steps, the actions
and these variables once main's workflow no longer references the actions.

Blacksmith runners send `actions/cache` to Blacksmith's own cache backend, not
GitHub's, so each backend gets one Bun install cache writer: Static on
Blacksmith, and on GitHub the hosted test leg that `test-matrix.ts` marks (the
remaining-package job whenever it runs, else the web job).

Pull request, branch, and worktree validation run the code of arbitrary refs
but start from `main`, so they call `_validation.yml` with `cache-mode: read`:
they restore `main`'s caches, and their save steps log a notice and continue.
GitHub's cache service enforces that cap, so those runs cannot seed the caches
that GitHub-hosted jobs, releases included, restore. Blacksmith does not
document enforcing it, so on Blacksmith jobs (Static, Build, the test matrix,
release smoke) only `actions/cache` honoring `ACTIONS_CACHE_MODE` keeps
a validated ref from seeding the caches that main's Blacksmith jobs restore.

Browser shards, Build's desktop pipeline steps, and release smoke stay gated
behind the `run-*` inputs. On PRs `validationScope` in the test-matrix script
combines changed paths with affected dependents. Release smoke reads that
decision from the test-matrix job's outputs; browser shards and Build evaluate
it in-job so they can start immediately. The test-matrix job installs nothing:
it runs the lockfile's Turbo for the dry plan, so the test legs start sooner.
Build runs the desktop pipeline in its one Turbo invocation, because
`ryco-cli#build` and `@ryco/desktop#build` are uncached and a second build would
rerun them: full runs build every package, and PR runs that need it pass the
affected range as a `--filter` to `bun run build:desktop`, which Turbo unions
with that script's own filters. Runtime changes that affect web require browser tests;
changes affecting web, server, or desktop require desktop validation. Unit-only
and documentation changes skip these expensive jobs. Hosted Hub/PWA test sources
referenced by browser acceptance tests still trigger the browser suite. Root
configuration, scripts, patches, and CI infrastructure use a conservative
fallback. Full runs enable every requested check regardless of paths. Most build
inputs exclude documentation and unit tests. The web build keeps tests and
browser harnesses in its hash because Tailwind scans them when generating CSS.

The Mobile bundle job is the only check that runs Metro. It runs
`bun run --cwd apps/mobile bundle:check`, a production `expo export` for iOS and
Android, on GitHub-hosted `ubuntu-24.04`, so a bad patch, a Babel or Hermes
failure, or a workspace export the app cannot resolve fails CI instead of a
developer's Mac or EAS. Metro reads workspace sources, so it builds nothing
first and restores no Turbo cache. It has no `run-*` input and reads `mobile`
from the test-matrix outputs: runtime changes to the app or a workspace it
consumes, plus the same conservative fallback as the other scoped jobs.

Shared toolchain setup lives in `.github/actions/setup-ryco`, so new workflows
should reuse that action instead of duplicating Vite+, Bun, Node, cache, and
install steps. The action uses `setup-vp` for Vite+ and Node, sets up Bun
explicitly for Ryco's command surface, and installs dependencies with
`bun install --frozen-lockfile` using the pinned Bun version. In validation,
only Build installs the resource-monitor Rust toolchain, and the test-matrix
job sets up Bun alone. The action also restores the Bun install cache (one job
per cache backend saves it with `bun-cache: write`; release jobs use `none`) and,
where `restore-turbo-cache` is true, the explicit workspace-local Turbo cache.
Jobs save the Turbo cache through `.github/actions/save-turbo-cache`, which first
prunes it to the task hashes in the job's `--summarize` run summaries, so the
cache holds what the last run used instead of growing with every commit.
Browser validation restores the pinned Playwright runtime cache.

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
