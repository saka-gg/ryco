# Observability

Ryco has one server-side observability model:

- pretty logs go to stdout for humans
- completed spans go to a local NDJSON trace file
- traces and metrics can also be exported over OTLP to a real backend like Grafana LGTM

The local trace file is the persisted source of truth. Only desktop mode also keeps a server log file (`logs/server.log`).

## Where To Find Things

### Logs

Logs are human-facing:

- destination: stdout
- format: `Logger.consolePretty()`
- persistence: in desktop mode the server also writes `logs/server.log` itself (logfmt, one line per
  record with its cause, rotating at 10 MiB with 3 backups). The desktop shell's capture of stdout
  goes to `logs/server-child.log`. Other modes persist nothing.

If you want a log message to show up in the trace file, emit it inside an active span with `Effect.log...`. `Logger.tracerLogger` will attach it as a span event.

Failures that repeat in retry or polling loops go through `logOnceEvery` / `ignoreCauseLogOnceEvery`
(`apps/server/src/logOnceEvery.ts`): the first occurrence of a key is logged with its full cause, then
at most one `(repeated N times since …)` summary per window (5 minutes by default) while it persists.

### Traces

Completed spans are written as NDJSON records to `serverTracePath` (by default, `~/.ryco/userdata/logs/server.trace.ndjson`; dev mode uses `$RYCO_HOME/dev/logs/server.trace.ndjson`).

Important fields in each record:

- `name`: span name
- `traceId`, `spanId`, `parentSpanId`: correlation
- `durationMs`: elapsed time
- `attributes`: structured context
- `events`: embedded logs and custom events
- `exit`: `Success`, `Failure`, or `Interrupted`

The schema lives in `apps/server/src/observability/TraceRecord.ts`.

### Metrics

Metrics are not written to a local file.

- local persistence: none
- remote export: OTLP only, when configured
- current definitions: `apps/server/src/observability/Metrics.ts`
- in-app snapshot: `server.getDiagnosticsMetrics` RPC exposes rolling-window stats for the Diagnostics panel (turn quiescence average, checkpoint duration p95, websocket reconnect count). These counters live in process memory only and reset whenever the server restarts.

If OTLP is not configured, metrics still exist in-process, but you will not have a local artifact to inspect outside the Diagnostics panel.

### Related Artifacts

Provider event logs are separate from the main server trace file. They live in `logs/provider/`, one
pair of files per thread: `<threadId>.native.log` (provider protocol messages) and `<threadId>.log`
(normalized runtime events). Each line is `[<ISO time>] NTIVE|CANON: <json>`.

- detail: `ServerSettings.providerEventLogs` (`off`, `lifecycle`, `full`), overridden by
  `RYCO_PROVIDER_EVENT_LOGS`. Unset follows the build: `full` in development, `lifecycle` (session,
  turn, request and error records only) in packaged builds. Setting changes apply immediately;
  `RYCO_PROVIDER_EVENT_LOGS=off` disables the writers entirely.
- size: strings over 8 KiB keep a head and tail, inline base64 is replaced by its size and digest,
  consecutive streaming deltas become one `delta-run` record, and canonical records reference the
  native message (`raw.nativeId`) instead of repeating its payload. At `full` a small adapter-made
  payload with no native message stays inline; at `lifecycle` no raw payload is written, so the raw
  form of a message the `lifecycle` native filter drops is not kept.
- retention: each file rotates at 10 MiB with 3 gzipped backups (`.1.gz` …); files untouched for 30
  days are removed and the directory is kept under 512 MiB (oldest first), at boot and hourly.
  Terminal histories in `logs/terminals/` get the same sweep (90 days, 256 MiB).

The Diagnostics panel reads provider failures (`runtime.error`, failed turns, errored session exits)
from the canonical logs of the most recently active threads, and server failures from
`logs/server.log` (`serverLogPath`), which the desktop backend writes.

## Run The Server In Instrumented Mode

There are two useful modes:

- local-only: stdout + local `server.trace.ndjson`
- full local observability: stdout + local trace file + OTLP export to Grafana/Tempo/Prometheus

The local trace file is always on. OTLP export is opt-in.

### Option 1: Local Traces Only

You do not need any extra env vars. Just run the app normally and inspect `server.trace.ndjson`.

Examples:

```bash
npx ryco-cli
```

```bash
bun run dev
```

```bash
bun run dev:desktop
```

### Option 2: Run With A Local LGTM Stack

#### 1. Start Grafana LGTM

```bash
docker run --name lgtm \
  -p 3000:3000 \
  -p 4317:4317 \
  -p 4318:4318 \
  --rm -ti \
  grafana/otel-lgtm
```

Then open `http://localhost:3000`.

Default Grafana login:

- username: `admin`
- password: `admin`

#### 2. Export OTLP env vars

```bash
export RYCO_OTLP_TRACES_URL=http://localhost:4318/v1/traces
export RYCO_OTLP_METRICS_URL=http://localhost:4318/v1/metrics
export RYCO_OTLP_SERVICE_NAME=ryco-local
```

Optional:

```bash
export RYCO_TRACE_MIN_LEVEL=Info
export RYCO_TRACE_TIMING_ENABLED=true
```

#### 3. Launch the app from that same shell

CLI:

```bash
npx ryco-cli
```

Monorepo web/server dev:

```bash
bun run dev
```

Monorepo desktop dev:

```bash
bun run dev:desktop
```

Packaged desktop app:

Launch the actual app executable from the same shell so the desktop app and embedded backend inherit `RYCO_OTLP_*`.

macOS app bundle example:

```bash
RYCO_OTLP_TRACES_URL=http://localhost:4318/v1/traces \
RYCO_OTLP_METRICS_URL=http://localhost:4318/v1/metrics \
RYCO_OTLP_SERVICE_NAME=ryco-desktop \
"/Applications/Ryco.app/Contents/MacOS/Ryco"
```

Direct binary example:

```bash
RYCO_OTLP_TRACES_URL=http://localhost:4318/v1/traces \
RYCO_OTLP_METRICS_URL=http://localhost:4318/v1/metrics \
RYCO_OTLP_SERVICE_NAME=ryco-desktop \
./path/to/your/desktop-app-binary
```

Do not rely on launching from Finder, Spotlight, the dock, or the Start menu after setting shell env vars. Those launches usually will not pick them up.

#### 4. Fully restart after changing env

The backend reads observability config at process start. If you change OTLP env vars, stop the app completely and start it again.

## How To Use Traces And Metrics To Debug The Server

### Start With The Local Trace File

The trace file is the fastest way to inspect raw span data.

Tail it:

```bash
tail -f "$RYCO_HOME/userdata/logs/server.trace.ndjson"
```

In monorepo dev, use:

```bash
tail -f ./dev/logs/server.trace.ndjson
```

Show failed spans:

```bash
jq -c 'select(.exit._tag != "Success") | {
  name,
  durationMs,
  exit,
  attributes
}' "$RYCO_HOME/userdata/logs/server.trace.ndjson"
```

Show slow spans:

```bash
jq -c 'select(.durationMs > 1000) | {
  name,
  durationMs,
  traceId,
  spanId
}' "$RYCO_HOME/userdata/logs/server.trace.ndjson"
```

Inspect embedded log events:

```bash
jq -c 'select(any(.events[]?; .attributes["effect.logLevel"] != null)) | {
  name,
  durationMs,
  events: [
    .events[]
    | select(.attributes["effect.logLevel"] != null)
    | {
        message: .name,
        level: .attributes["effect.logLevel"]
      }
  ]
}' "$RYCO_HOME/userdata/logs/server.trace.ndjson"
```

Follow one trace:

```bash
jq -r 'select(.traceId == "TRACE_ID_HERE") | [
  .name,
  .spanId,
  (.parentSpanId // "-"),
  .durationMs
] | @tsv' "$RYCO_HOME/userdata/logs/server.trace.ndjson"
```

Filter orchestration commands:

```bash
jq -c 'select(.attributes["orchestration.command_type"] != null) | {
  name,
  durationMs,
  commandType: .attributes["orchestration.command_type"],
  aggregateKind: .attributes["orchestration.aggregate_kind"]
}' "$RYCO_HOME/userdata/logs/server.trace.ndjson"
```

Filter git activity:

```bash
jq -c 'select(.attributes["git.operation"] != null) | {
  name,
  durationMs,
  operation: .attributes["git.operation"],
  cwd: .attributes["git.cwd"],
  hookEvents: [
    .events[]
    | select(.name == "git.hook.started" or .name == "git.hook.finished")
  ]
}' "$RYCO_HOME/userdata/logs/server.trace.ndjson"
```

### Use Tempo When You Need A Real Trace Viewer

Tempo is better than raw NDJSON when you want to:

- search across many traces
- inspect parent/child relationships visually
- compare many slow traces
- drill into one failing request without hand-joining by `traceId`

Recommended flow in Grafana:

1. Open `Explore`.
2. Pick the `Tempo` data source.
3. Set the time range to something recent like `Last 15 minutes`.
4. Start broad. Do not begin with a very narrow query.
5. Look for spans from your configured service name, then narrow by span name or attributes.

Good first searches:

- service name such as `ryco-local`, `ryco-dev`, or `ryco-desktop`
- span names like `sql.execute`, `git.runCommand`, `provider.sendTurn`
- orchestration spans with attributes like `orchestration.command_type`

Once you know traces are arriving, narrower TraceQL queries like `name = "sql.execute"` become useful.

### Use Metrics To See Systemic Problems

Traces are best for one request. Metrics are best for trends.

Good metric families to watch:

- `ryco_rpc_request_duration`
- `ryco_orchestration_command_duration`
- `ryco_orchestration_command_ack_duration`
- `ryco_provider_turn_duration`
- `ryco_git_command_duration`
- `ryco_db_query_duration`

Counters tell you volume and failure rate:

- `ryco_rpc_requests_total`
- `ryco_orchestration_commands_total`
- `ryco_provider_turns_total`
- `ryco_git_commands_total`
- `ryco_db_queries_total`

Use metrics when the question is:

- "is this always slow?"
- "did this get worse after a change?"
- "which command type is failing most often?"

Use traces when the question is:

- "what happened in this specific request?"
- "which child span caused this one slow interaction?"
- "what logs were emitted inside the failing flow?"

### What The New Ack Metric Means

`ryco_orchestration_command_ack_duration` measures:

- start: command dispatch enters the orchestration engine
- end: the first committed domain event for that command is published by the server

That is a server-side acknowledgment metric. It does not measure:

- websocket transit to the browser
- client receipt
- React render time

If you need those later, add client-side instrumentation or a dedicated server fanout metric.

## Common Workflows

### "Why did this request fail?"

1. Start with the local NDJSON file.
2. Find spans where `exit._tag != "Success"`.
3. Group by `traceId`.
4. Inspect sibling spans and span events.
5. If needed, move to Tempo for the full trace tree.

### "Why is the UI feeling slow?"

1. Search for slow top-level spans in the trace file or Tempo.
2. Check child spans for sqlite, git, provider, or terminal work.
3. Look at the matching duration metrics to see whether the slowness is systemic.

### "Did this command take too long to acknowledge?"

1. Check `ryco_orchestration_command_ack_duration` by `commandType`.
2. If it is high, inspect the corresponding orchestration trace.
3. Look at child spans for projection, sqlite, provider, or git work.

### "Are git hooks causing latency?"

1. Filter `git.operation` spans.
2. Inspect `git.hook.started` and `git.hook.finished` events.
3. Compare hook timing to the enclosing git span duration.

### "Why do I have spans locally but nothing in Grafana?"

Usually one of these is true:

- `RYCO_OTLP_TRACES_URL` was not set
- the app was launched from a different environment than the one where you exported the vars
- the app was not fully restarted after changing env
- Grafana is looking at the wrong time range or service name

If the local NDJSON file is updating, local tracing is working. The problem is almost always OTLP export configuration or process startup.

## How To Think About Adding Tracing To Future Code

### Prefer Boundaries Over Tiny Helpers

Good span boundaries:

- RPC methods
- orchestration command handling
- provider adapter calls
- external process calls
- persistence writes
- queue handoffs

Avoid tracing every tiny helper. Most helpers should inherit the active span rather than create a new one.

### Reuse `Effect.fn(...)` Where It Already Exists

The codebase already uses `Effect.fn("name")` heavily. That should usually be your first tracing boundary.

For ad hoc work:

```ts
import { Effect } from "effect";

const runThing = Effect.gen(function* () {
  yield* Effect.annotateCurrentSpan({
    "thing.id": "abc123",
    "thing.kind": "example",
  });

  yield* Effect.logInfo("starting thing");
  return yield* doWork();
}).pipe(Effect.withSpan("thing.run"));
```

### Put High-Cardinality Detail On Spans

Use span annotations for IDs, paths, and other detailed context:

```ts
yield *
  Effect.annotateCurrentSpan({
    "provider.thread_id": input.threadId,
    "provider.request_id": input.requestId,
    "git.cwd": input.cwd,
  });
```

### Keep Metric Labels Low Cardinality

Good metric labels:

- operation kind
- method name
- provider kind
- aggregate kind
- outcome

Bad metric labels:

- raw thread IDs
- command IDs
- file paths
- cwd
- full prompts
- full model strings when a normalized family label would do

Detailed context belongs on spans, not metrics.

### Use Logs As Span Events

Logs inside a span become part of the trace story:

```ts
yield * Effect.logInfo("starting provider turn");
yield * Effect.logDebug("waiting for approval response");
```

Those messages show up as span events because `Logger.tracerLogger` is installed.

### Use The Pipeable Metrics API

`withMetrics(...)` is the default way to attach a counter and timer to an effect:

```ts
import { someCounter, someDuration, withMetrics } from "../observability/Metrics.ts";

const program = doWork().pipe(
  withMetrics({
    counter: someCounter,
    timer: someDuration,
    attributes: {
      operation: "work",
    },
  }),
);
```

## Detailed API Reference

### Runtime Wiring

The server observability layer is assembled in `apps/server/src/observability/Layers/Observability.ts`.

It provides:

- pretty stdout logger
- `Logger.tracerLogger`
- local NDJSON tracer
- optional OTLP trace exporter
- optional OTLP metrics exporter
- Effect trace-level and timing refs

### Env Vars

Local trace file:

- `RYCO_TRACE_FILE`: override trace file path
- `RYCO_TRACE_MAX_BYTES`: per-file rotation size, default `10485760`
- `RYCO_TRACE_MAX_FILES`: rotated file count, default `10`
- `RYCO_TRACE_BATCH_WINDOW_MS`: flush window, default `200`
- `RYCO_TRACE_MIN_LEVEL`: minimum trace level, default `Info`
- `RYCO_TRACE_TIMING_ENABLED`: enable timing metadata, default `true`
- `RYCO_TRACE_SQL_MIN_DURATION_MS`: SQL statement spans that succeed faster than this are left out
  of the local trace file, default `50`; `0` records every statement. Failed statements are always
  kept, and the OTLP exporter still receives every span

OTLP export:

- `RYCO_OTLP_TRACES_URL`: OTLP trace endpoint
- `RYCO_OTLP_METRICS_URL`: OTLP metric endpoint
- `RYCO_OTLP_EXPORT_INTERVAL_MS`: export interval, default `10000`
- `RYCO_OTLP_SERVICE_NAME`: service name, default `ryco-server`

If the OTLP URLs are unset, local tracing still works and metrics stay in-process only.

### What Is Instrumented Today

Current high-value span and metric boundaries include:

- Effect RPC websocket request spans from `effect/rpc`
- RPC request metrics in `apps/server/src/observability/RpcInstrumentation.ts`
- startup phases
- orchestration command processing
- orchestration command acknowledgment latency
- provider session and turn operations
- git command execution and git hook events
- terminal session lifecycle
- sqlite query execution

### Client perf profiling

The web app supports opt-in interaction profiling via `VITE_RYCO_PERF_PROFILE=1`.

Instrumented interactions:

- thread tab switches (`ryco:tab-switch:*` measures)
- sidebar project expand (`ryco:sidebar-expand:*` measures)
- component render durations (`ryco:render:*` measures)

Soft budgets live in `apps/web/src/perf/budgets.ts`. See `apps/web/src/perf/README.md` for usage and inspection commands.

### Current Constraints

- logs outside spans are not persisted, except in desktop mode (`logs/server.log`)
- metrics are not snapshotted locally to disk; use the Diagnostics panel or OTLP export for inspection
- `serverLogPath` is only written in desktop mode; the trace file is the persisted artifact that matters
