# Performance Testing

Ryco's external performance harness runs outside the application and observes the same production
HTTP, WebSocket, browser, and process boundaries a user exercises. It complements unit, browser,
and instrumentation tests; it does not replace them.

## Quick smoke run

Build the production server and web app, install the pinned Chromium runtime if necessary, then run
one short iteration:

```sh
bun run build --filter=ryco-cli --filter=@ryco/web
bun run --cwd apps/web test:browser:install
bun run perf:smoke
```

The generated JSON is written below `.perf-results/`, which Git ignores.

## Active source-control scenario

Run the credential-free source-control workload after building the production server and web app:

```sh
bun run perf:source-control
```

This profile creates a temporary Git repository and bare local remote, registers the repository in
a fresh Ryco home, then drives the production UI in Chromium. The repository keeps a synthetic
GitHub-shaped fetch URL for provider detection while a repository-scoped SSH transport and push URL
route Git entirely to the harness-owned bare repository. No network credential or private
repository identifier is used or written to the report.

The browser performs a real push to trigger post-push workflow discovery. Deterministic
source-control RPC responses then let the harness verify and measure:

- the 10-second discovery request stream;
- Overview and Project Explorer sharing cached PR detail and workflow queries;
- the 30-second active-check cadence;
- zero timer-driven source-control requests while hidden;
- zero timer-driven requests after checks settle;
- renderer task time, heap, long tasks, and frame pacing with 12 continuously animated status
  rows; and
- production server/process-tree CPU and RSS throughout the scenario.

The default one-iteration scenario takes about 90 seconds because it observes real production
cadences rather than scaling timers. Tune its bounded windows only for diagnosis:

```sh
bun run perf:external -- \
  --profile active-source-control \
  --iterations 3 \
  --source-control-active-ms 35000 \
  --source-control-hidden-ms 5000 \
  --source-control-settled-ms 32000 \
  --source-control-status-rows 12
```

Use the same profile with `perf:compare` for a controlled main-versus-candidate measurement. Do
not supply a real user home to this profile: its local fixture is intentionally disposable and
isolated per iteration.

## Measure the current checkout

```sh
bun run perf:external -- \
  --iterations 7 \
  --idle-ms 5000 \
  --hidden-idle-ms 5000
```

The current-checkout command uses existing production build output. Rebuild first after changing
application code.

An already-running deployment can be measured without launching a local server:

```sh
bun run perf:external -- --url http://127.0.0.1:3773/pair --iterations 7
```

The URL must already be usable. A one-time local pairing URL is handled automatically only when the
harness launches the production server.

## Compare Git revisions

Commit the candidate worktree, then run:

```sh
bun run perf:compare -- \
  --base origin/main \
  --candidate HEAD \
  --iterations 7
```

The harness refuses a dirty `HEAD`. It creates detached temporary worktrees, runs
`bun install --frozen-lockfile`, forces equivalent production server and web builds without Turbo
cache reads, measures both revisions sequentially, and cleans up only the worktrees and homes it
created. The forced build matters because Turbo otherwise shares cache entries across Git
worktrees, which can make whichever revision is already cached appear dramatically faster.

Artifacts include:

- `baseline.json`: complete baseline samples and environment metadata;
- `candidate.json`: complete candidate samples;
- `comparison.json`: machine-readable metric decisions;
- `comparison.md`: reviewer-facing medians, changes, and failures.

Use the same machine and power state for both revisions. Close unrelated heavy applications and do
not compare reports produced on different hardware as if they were controlled experiments.

The `External Performance Comparison` GitHub Actions workflow exposes the same comparison as a
manual dispatch. Choose the candidate branch in the workflow UI, then supply the baseline ref and
sample count. It publishes the Markdown report to the job summary and retains raw JSON for 30 days.
It is intentionally not a required PR check until repeated runs establish the dedicated runner's
normal variance.

## Representative profiles

An empty application is insufficient for long-thread, cache, and rendering measurements. Prepare a
sanitized Ryco home, stop every server using it, and pass it as a fixture:

```sh
bun run perf:compare -- \
  --base origin/main \
  --candidate HEAD \
  --fixture-home /absolute/path/to/stopped-sanitized-home \
  --target-path /threads/example \
  --ready-selector '[data-thread-ready="true"]'
```

The harness copies the fixture into a new home for every iteration. It never symlinks or mutates the
source. If SQLite uses WAL mode, copy the database together with its `-wal` and `-shm` siblings only
while the source server is stopped. Never commit fixture homes, tokens, secrets, logs, or reports.

The target route and selector are scenario-specific. The default route is the authenticated empty
shell and the default readiness selector is `#root`.

## What is measured

- server spawn to headless readiness;
- TTFB, DOM content loaded, FCP, LCP, CLS, and usable-shell time;
- long-task count and maximum duration;
- HTTP request count and encoded bytes;
- WebSocket frames and payload bytes;
- foreground and hidden fetch/XHR polling;
- active source-control discovery, duplicate-observer, hidden, and settled request counts;
- active source-control cadence and continuous-status frame pacing;
- browser task duration and renderer heap around idle windows;
- offline-to-WebSocket-reconnect time;
- launched server/provider process-tree CPU, RSS, and process count;
- production build duration, build-process peak RSS, and emitted bundle totals.

Normal measurements force `RYCO_PERF_PROFILE=0` and `VITE_RYCO_PERF_PROFILE=0`. Run profiling
separately when diagnosing a regression because observers and trace exporters change the workload.

To see where boot spends main-thread time, add `--cpu-profile <directory>`. Each iteration then
records a CDP CPU profile (100 µs sampling) from navigation until 5 s after `primary-shell-painted`,
writes it as `<label>-iteration-<n>.cpuprofile` (open it in DevTools or speedscope), and stores a
self-time summary in the sample's `cpuProfile` field. A checkout the harness builds itself is
summarized by source file when the web build carries hidden source maps
(`RYCO_WEB_SOURCEMAP=hidden`); `--url` runs are summarized by chunk. Profiling adds the 5 s tail
and the sampler's overhead, so compare profiled runs only with other profiled runs.

`bun run perf:bundle-budget` also checks import depth on the built dist: every `import()` must
preload its target's whole static closure, so a route, shell, or dialog chunk graph loads in one
parallel round.

## Regression policy

Default gates require both an absolute and relative regression, which prevents millisecond noise
from failing a run. For example, startup timings must be at least 15% and 50 ms slower. LCP and
usable-shell time use a 100 ms absolute floor. Transfer and memory metrics have byte floors.

Foreground and hidden polling are stricter: the candidate may issue at most one additional
fetch/XHR request during each idle window. Page errors, console errors, failed samples, missing
candidate measurements, server crashes, and incomplete iteration counts fail the comparison.

Override checked-in defaults with a JSON policy when a dedicated runner has established tighter
variance bounds:

```sh
bun run perf:compare -- --policy ./perf-policy.json
```

Only fields supplied by the file replace defaults; metric entries merge by name.

## Limitations

- Headless Chromium is a stable regression environment, not a substitute for physical mobile or
  packaged Electron measurements.
- Browser task time is obtained from CDP. Server/provider CPU and RSS come from the spawned process
  tree. They intentionally have different attribution boundaries.
- `ps` process-tree sampling is currently available on macOS and Linux. Windows reports the metric
  as unavailable instead of fabricating it.
- Provider and terminal bursts require an explicit sanitized fixture or external workload driver.
  The harness does not add production-only endpoints or bypass authentication to create load.
- Use at least seven measured iterations for decisions. The one-iteration smoke command verifies
  mechanics, not performance significance.
