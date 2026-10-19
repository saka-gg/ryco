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

## Hosted node switch and cold load

The hosted web app (the build served by a Hub, with a node picked from the sidebar) has two
latencies a user feels that the checkout benchmarks above do not cover: switching to a thread on
another node, and loading a thread cold. These commands measure both against a compatible Hub URL
without changing the application. They extend the same harness; results are plain JSON next to the
other `.perf-results/` output.

### What is recorded

Each switch starts with a click on an inbox row, preceded by the primary-button press and release
a pointer produces (so the row's press handling runs), all in one task, and a per-frame loop
records, in milliseconds from the click. The pointer never rests on the row beforehand, so hover
intent and its dwell are not exercised: the switch has no hover head start.

- `firstFrame`: the first animation frame after the click (main-thread time the click itself costs);
- `route`: the URL carries the target thread;
- `content`: a message row that was not on screen before the click;
- `writable`: content is present and the session accepts mutations. Builds that mark mutation
  readiness (`data-mutation-ready`) are measured by that marker; others by what a user sees: no
  "Read-only hosted session" banner and an editable composer;
- `readOnlySeen`: the first frame showing the read-only banner;
- `sendAccepted` (with `--send`): from pressing Enter on a typed marker message until the composer
  clears or a queued message appears. This mutates the fixture threads;
- long tasks that overlap the switch, as count, longest and total;
- `timeline.<phase>`: the app's own node-switch timeline for that switch, read through
  `__rycoNodeSwitchTimelines()` after the switch settles. Builds without it still produce every
  DOM metric above, so a baseline can be measured on an older revision.

Cross-node switches rotate through the nodes that list threads, never opening a thread whose id
equals the open one's (generated nodes reuse message ids per thread id, so that switch would show
no new message); three same-node switches follow as a control. Switches are at least 1.5 s apart.
With `--cpu-profile`, the second cross-node and the second same-node switch are recorded as CPU
profiles (and summarized by source file when `--dist` points at a build made with
`RYCO_WEB_SOURCEMAP=hidden`). Profiled switches are left out of the medians because sampling slows
the main thread. A switch that errors, or a cross-node switch with no thread listed on another node,
is kept in the result file as a failed run (counted in `failures`, left out of the medians) and the
remaining switches still run. A cold load that fails (a navigation timeout or network error) is
recorded the same way.

A cold load opens a fresh browser context at a thread route and records `firstContent` and
`writable` (same definitions, from navigation start), every `ryco:startup:*` measure as
`startup.<name>`, and request totals. CDP network events also give the critical path: the chain of
requests behind the response that ended last before first content (a WebSocket counts at its last
frame), followed back through the module that started each request. `serialRoundTrips` is the number
of non-overlapping waves on that chain, and the cut list ranks its requests by their own duration
together with the module that started them.

A WebSocket on the critical path counts as one wave from its handshake to its last frame before
first content, so `serialRoundTrips` counts HTTP requests and sockets, not the request/response
exchanges inside one socket (for example authenticate, subscribe and snapshot over a relay
channel). Those inner exchanges can be the largest serial cost of a hosted load, so a low
`serialRoundTrips` does not mean few serial waits: `webSocketFrames` shows how chatty the sockets
are, and `hosted-correlate` places the server-side spans of those exchanges.

### Commands

```sh
# Switch latency: 7 cross-node switches and 3 same-node controls
bun scripts/perf/cli.ts hosted-switch \
  --hub-url http://localhost:3100 --cookie-file owner.json \
  --iterations 7 --output results/switch

# Cold load of the first online node's first thread (or --target-path /node/<id>/<env>/<thread>)
bun scripts/perf/cli.ts hosted-cold-load \
  --hub-url http://localhost:3100 --cookie-file owner.json \
  --iterations 7 --output results/cold

# Compare two result files; --targets maps a metric to the largest acceptable candidate median
bun scripts/perf/cli.ts hosted-compare \
  --baseline results/before/hosted-switch.json --candidate results/after/hosted-switch.json \
  --targets targets.json

# Local nodes enrolled with the Hub (runs until Ctrl+C)
bun scripts/perf/cli.ts hosted-fixture \
  --hub-url http://localhost:3100 --base-dir "$FIXTURE_DIR" --nodes 2 --threads 120 \
  --approve-command "<command that approves one enrollment file>"

# Join switch clicks with node trace spans and Hub log events
bun scripts/perf/cli.ts hosted-correlate \
  --probe results/switch/hosted-switch.json --base-dir "$FIXTURE_DIR" --hub-log hub.log

# Fixed one-way delay in front of a port
bun scripts/perf/cli.ts delay-proxy --listen-port 3100 --target-port 3101 --delay-ms 40
```

`--cookie-file` is JSON with `cookieName` and `cookieValue` for a signed-in session on the Hub host;
how to obtain one depends on the Hub. Targets are a flat JSON object, for example
`{"cross-node.writable": 500, "same-node.writable": 150}`; `hosted-compare` prints per-metric median
deltas and exits 1 when a candidate median is above its target (or missing). A median covers only
the runs that produced the metric, so each result file also tallies `<kind>.runs`, `<kind>.timedOut`
and `<kind>.failed` (kinds `cross-node`, `same-node` and `cold`), and a target fails when the
candidate has more timed-out or failed runs of its kind than the baseline, or fewer samples of the
metric than runs that completed. As many timeouts as the baseline is judged on the median.

`hosted-fixture` generates a sanitized home per node (`apps/server/scripts/generate-fixture-home.ts`),
seeds a file-backed node identity so no platform keychain is used, starts `ryco serve` with the
Hub connector for each, writes an enrollment file per node, and, when `--approve-command` is given,
runs it with the file path appended and waits for the node to report `online`. It only needs the
Hub's origin and never reads the Hub's files. `--thread-cache` starts the nodes with the Hub thread
cache enabled. It writes `fixture.json` (ports, environment ids, process ids) and stops every node on
Ctrl+C.

`hosted-correlate` reads the node home's `userdata/logs/server.trace.ndjson` (and its rotated
`server.trace.ndjson.<n>` backups) for the start of `ws.rpc.orchestration.subscribeShell` and
`subscribeThreadWindow` (and the relay channel spans when present) and, with `--hub-log`, the first matching event of a JSON-lines Hub log after each click
(`--hub-event`, default `relay.connection.authenticated`, restricted to `--hub-route`, default
`client`). Streaming RPC spans measure the lifetime of a subscription, so only their start times are
used.

### Topology

Run the Hub on port P+1 with its public origin set to port P, and put `delay-proxy` on P in front of
it. Browsers and nodes both use the public origin (nodes enroll with it), so both legs of a switch
pay the delay: one-way `D` ms adds roughly `2D` per round trip. `--delay-ms 0` measures the proxy
without delay. All processes run on loopback.

### Matrix

Vary one dimension at a time and keep everything else fixed:

- Hub session protocol version 1 or 2 (a Hub setting) and thread cache on or off (`--thread-cache`);
- cold (`hosted-cold-load`) or visited (`hosted-cold-load --visited`, a reload in a context that
  already loaded the app) profile;
- warm or cold target node (the node-switch timeline records whether the node was already
  connected when the switch started);
- cross-node switch against the same-node control;
- one-way delay `D` of 0, 20, 40 and 80 ms;
- 2 and 4 nodes (`--nodes`), and 120 and 2,000 threads per node (`--threads`).

### Gotchas

- Every run uses a fresh browser context: the hosted app's service worker and caches persist per
  context, so reusing one would measure a different load. Use a fresh context per build too.
- Keep at least 1.5 s between switches. Every local process is the same peer to the Hub, so
  per-peer rate buckets are shared by the browser and all nodes; faster clicking measures throttling.
- Compare builds with `--interleave`: `--hub-url` is the baseline Hub, `--candidate` a second Hub URL
  serving the other build, and each iteration measures both, alternating which goes first. Results
  are written as `hosted-*.baseline.json` and `hosted-*.candidate.json` for `hosted-compare`.
- Use at least seven iterations for decisions and report the median with the min-max range.
- Run one fixture at a time per machine: ports and the Hub's per-peer limits are shared.
- `--send` and a `--cpu-profile` run change the workload; compare them only with runs made the same
  way.

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
