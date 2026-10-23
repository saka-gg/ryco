import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Layer, Logger, References, Schema } from "effect";
import { DiagnosticsSnapshot } from "@ryco/contracts";
import { vi } from "vite-plus/test";

import type { ServerConfigShape } from "../../config.ts";
import {
  encodeStallLine,
  eventLoopStallLogPath,
  type EventLoopStallLine,
} from "../../observability/EventLoopStallLog.ts";
import type { EffectTraceRecord, TraceRecord } from "../../observability/TraceRecord.ts";
import { formatProviderEventLogLine } from "../../provider/providerEventLogRecords.ts";
import { makeServerLogFileLogger } from "../../serverLogger.ts";
import { makeDiagnosticsService, redactDiagnosticValue } from "./Diagnostics.ts";

const makeTraceRecord = (): EffectTraceRecord => ({
  type: "effect-span",
  name: "server.rpc.failure",
  traceId: "trace-diagnostics",
  spanId: "span-diagnostics",
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000001000000000",
  durationMs: 1_000,
  attributes: {
    apiToken: "secret-token-value",
    route: "server.getDiagnosticsSnapshot",
  },
  events: [
    {
      name: "log",
      timeUnixNano: "1700000000500000000",
      attributes: {
        authorization: "Bearer secret-token-value",
      },
    },
  ],
  links: [],
  exit: {
    _tag: "Failure",
    cause: "Error: simulated diagnostic failure",
  },
});

const makeOtlpErrorRecord = (): TraceRecord => ({
  type: "otlp-span",
  name: "browser.fetch.failure",
  traceId: "trace-browser",
  spanId: "span-browser",
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1700000000000000000",
  endTimeUnixNano: "1700000001000000000",
  durationMs: 1_000,
  attributes: {},
  events: [],
  links: [],
  resourceAttributes: {
    "service.name": "ryco-web",
  },
  scope: {
    attributes: {},
  },
  status: {
    code: "STATUS_CODE_ERROR",
    message: "Network error",
  },
});

const makeInterruptedTraceRecord = (): EffectTraceRecord => ({
  ...makeTraceRecord(),
  name: "ws.rpc.orchestration.subscribeThreadWindow",
  spanId: "span-interrupted",
  exit: {
    _tag: "Interrupted",
    cause: "InterruptError: All fibers interrupted without error",
  },
});

const makeMalformedEffectSpanRecord = (): TraceRecord =>
  ({
    type: "effect-span",
    traceId: "trace-partial",
    spanId: "span-partial",
    sampled: true,
    kind: "internal",
    startTimeUnixNano: "1700000000000000000",
    endTimeUnixNano: "1700000001000000000",
    durationMs: 1_000,
    links: [],
  }) as unknown as TraceRecord;

const makeDiagnosticsConfig = (tempDir: string): ServerConfigShape => {
  const logsDir = path.join(tempDir, "logs");
  const providerLogsDir = path.join(logsDir, "provider");
  fs.mkdirSync(providerLogsDir, { recursive: true });
  const config = {
    logLevel: "Error",
    traceMinLevel: "Info",
    traceTimingEnabled: true,
    traceBatchWindowMs: 200,
    traceMaxBytes: 1024,
    traceMaxFiles: 2,
    otlpTracesUrl: undefined,
    otlpMetricsUrl: undefined,
    otlpExportIntervalMs: 10_000,
    otlpServiceName: "ryco-server",
    mode: "web",
    port: 0,
    host: undefined,
    cwd: process.cwd(),
    baseDir: tempDir,
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    startupPresentation: "headless",
    desktopBootstrapToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logWebSocketEvents: false,
    tailscaleServeEnabled: false,
    tailscaleServePort: 443,
    stateDir: tempDir,
    dbPath: path.join(tempDir, "state.sqlite"),
    keybindingsConfigPath: path.join(tempDir, "keybindings.json"),
    settingsPath: path.join(tempDir, "settings.json"),
    providerStatusCacheDir: path.join(tempDir, "caches"),
    worktreesDir: path.join(tempDir, "worktrees"),
    chatsDir: path.join(tempDir, "chats"),
    attachmentsDir: path.join(tempDir, "attachments"),
    taskFilesDir: path.join(tempDir, "task-files"),
    logsDir,
    serverLogPath: path.join(logsDir, "server.log"),
    serverTracePath: path.join(logsDir, "server.trace.ndjson"),
    providerLogsDir,
    providerEventLogPath: path.join(providerLogsDir, "events.log"),
    terminalLogsDir: path.join(logsDir, "terminals"),
    anonymousIdPath: path.join(tempDir, "anonymous-id"),
    environmentIdPath: path.join(tempDir, "environment-id"),
    serverRuntimeStatePath: path.join(tempDir, "server-runtime.json"),
    hubIdentityStatePath: path.join(tempDir, "hub-identity.json"),
    secretsDir: path.join(tempDir, "secrets"),
  } satisfies ServerConfigShape;
  fs.writeFileSync(config.serverTracePath, "");
  fs.writeFileSync(config.serverLogPath, "2026-06-14T12:00:00.000Z error log failure\n");
  fs.writeFileSync(config.providerEventLogPath, "");
  return config;
};

describe("Diagnostics", () => {
  it("redacts nested sensitive values", () => {
    assert.deepStrictEqual(
      redactDiagnosticValue({
        nested: {
          password: "hunter2",
          visible: "ok",
        },
        authorization: "Bearer token",
      }),
      {
        nested: {
          password: "[redacted]",
          visible: "ok",
        },
        authorization: "[redacted]",
      },
    );
  });

  it.effect("summarizes rotated traces and warning logs without exposing credentials", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
      try {
        const config = makeDiagnosticsConfig(tempDir);
        const record = {
          ...makeTraceRecord(),
          events: [
            {
              name: "authorization=private-value",
              timeUnixNano: "1700000000500000000",
              attributes: { "effect.logLevel": "Warning" },
            },
          ],
        };
        fs.writeFileSync(
          `${config.serverTracePath}.1`,
          `${JSON.stringify(record)}\ninvalid-json\n`,
        );
        fs.writeFileSync(config.serverLogPath, "error Bearer private-value\n");
        const diagnostics = yield* makeDiagnosticsService(config);
        diagnostics.recordTraceRecords([record, makeInterruptedTraceRecord()]);
        const snapshot = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        assert.equal(snapshot.tracing.retainedSpanCount, 2);
        Schema.decodeUnknownSync(DiagnosticsSnapshot)(snapshot);
        assert.equal(snapshot.tracing.summary?.failureCount, 1);
        assert.equal(snapshot.tracing.summary?.interruptionCount, 1);
        assert.equal(snapshot.tracing.summary?.slowSpanCount, 2);
        assert.equal(snapshot.tracing.summary?.parseErrorCount, 1);
        assert.equal(snapshot.tracing.summary?.logLevelCounts.warning, 1);
        assert.equal(snapshot.tracing.summary?.latestWarningAndErrorLogs[0]?.message, "[redacted]");
        assert.equal(JSON.stringify(snapshot).includes("private-value"), false);
        assert.equal(snapshot.resources.host?.cpuCount, os.cpus().length);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("reports event-loop stall history from the stall log and its backup", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
      try {
        const config = makeDiagnosticsConfig(tempDir);
        const logPath = eventLoopStallLogPath(config.serverTracePath);
        const nowMs = Date.now();
        const stallAt = (agoMs: number, overrides: Partial<EventLoopStallLine> = {}) =>
          encodeStallLine({
            time: new Date(nowMs - agoMs).toISOString(),
            kind: "event-loop",
            durationMs: 2_500,
            count: 1,
            totalMs: 2_500,
            phases: ["provider.probe:token=private-value (2400 ms)"],
            ...overrides,
          });
        fs.writeFileSync(
          `${logPath}.1`,
          [
            stallAt(25 * 60 * 60_000, { durationMs: 9_000 }),
            stallAt(5 * 60 * 60_000),
            stallAt(4 * 60 * 60_000, { kind: "threadpool", durationMs: 7_000 }),
            "",
          ].join("\n"),
        );
        fs.writeFileSync(
          logPath,
          [
            stallAt(60_000, { durationMs: 6_200, count: 3, totalMs: 11_000 }),
            stallAt(1_000),
            "",
          ].join("\n"),
        );
        const diagnostics = yield* makeDiagnosticsService(config);
        const snapshot = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        Schema.decodeUnknownSync(DiagnosticsSnapshot)(snapshot);
        const history = snapshot.eventLoop;
        assert.ok(history !== undefined);
        assert.deepStrictEqual(
          history.recent.map((record) => [record.kind, record.durationMs]),
          [
            ["event-loop", 2_500],
            ["event-loop", 6_200],
            ["threadpool", 7_000],
            ["event-loop", 2_500],
            ["event-loop", 9_000],
          ],
        );
        assert.deepStrictEqual(history.last24h, {
          records: 4,
          stalls: 5,
          longestMs: 6_200,
          threadpoolStalls: 1,
        });
        assert.deepStrictEqual(history.historyFilePaths, [logPath, `${logPath}.1`]);
        assert.equal(history.thresholdMs, 2_000);
        assert.equal(JSON.stringify(history).includes("private-value"), false);
        assert.equal(
          snapshot.warnings.some((warning) => warning.code.startsWith("diagnostics.event-loop")),
          false,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("re-reads the stall log as soon as it changes", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
      try {
        const config = makeDiagnosticsConfig(tempDir);
        const logPath = eventLoopStallLogPath(config.serverTracePath);
        const record = (durationMs: number) =>
          `${encodeStallLine({
            time: new Date().toISOString(),
            kind: "event-loop",
            durationMs,
            count: 1,
            totalMs: durationMs,
          })}\n`;
        const diagnostics = yield* makeDiagnosticsService(config);
        const fresh = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        assert.deepStrictEqual(fresh.eventLoop?.recent, []);
        assert.equal(
          fresh.warnings.some((warning) => warning.code.startsWith("diagnostics.event-loop")),
          false,
        );

        fs.writeFileSync(logPath, record(3_000));
        const first = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        assert.deepStrictEqual(
          first.eventLoop?.recent.map((stall) => stall.durationMs),
          [3_000],
        );
        fs.appendFileSync(logPath, record(4_000));
        const second = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        assert.deepStrictEqual(
          second.eventLoop?.recent.map((stall) => stall.durationMs).toSorted(),
          [3_000, 4_000],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps good stall records and warns once about malformed ones", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
      try {
        const config = makeDiagnosticsConfig(tempDir);
        const logPath = eventLoopStallLogPath(config.serverTracePath);
        fs.writeFileSync(
          logPath,
          [
            encodeStallLine({
              time: new Date().toISOString(),
              kind: "event-loop",
              durationMs: 2_000,
              count: 1,
              totalMs: 2_000,
            }),
            "{not json",
            JSON.stringify({ time: new Date().toISOString(), kind: "event-loop", durationMs: -1 }),
            // Hand-edited: a fractional optional field must not break the snapshot.
            JSON.stringify({
              time: new Date().toISOString(),
              kind: "event-loop",
              durationMs: 2_100.5,
              cpuUserMs: 10.25,
            }),
            // Hand-edited: a kind that ends in a space once cut to its length limit.
            JSON.stringify({
              time: new Date().toISOString(),
              kind: `${"k".repeat(63)} tail`,
              durationMs: 2_200,
            }),
            "",
          ].join("\n"),
        );
        const diagnostics = yield* makeDiagnosticsService(config);
        const snapshot = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        Schema.decodeUnknownSync(DiagnosticsSnapshot)(snapshot);
        // The RPC layer encodes the snapshot, which is stricter about trimmed strings.
        Schema.encodeUnknownSync(DiagnosticsSnapshot)(snapshot);
        assert.equal(snapshot.eventLoop?.recent.length, 3);
        const malformed = snapshot.warnings.filter(
          (warning) => warning.code === "diagnostics.event-loop-history-malformed-lines",
        );
        assert.equal(malformed.length, 1);
        assert.equal(malformed[0]?.count, 2);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("refuses trace symlinks and tolerates malformed event payloads", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
      try {
        const config = makeDiagnosticsConfig(tempDir);
        fs.unlinkSync(config.serverTracePath);
        fs.symlinkSync(config.serverLogPath, config.serverTracePath);
        const diagnostics = yield* makeDiagnosticsService(config);
        diagnostics.recordTraceRecords([
          { ...makeTraceRecord(), events: [null, { name: 42 }] } as unknown as TraceRecord,
        ]);
        const snapshot = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        assert.equal(snapshot.tracing.retainedSpanCount, 1);
        assert.equal(snapshot.tracing.summary?.partialFailure, true);
        assert.equal(
          snapshot.warnings.some(
            (warning) => warning.code === "diagnostics.trace-tail-unavailable",
          ),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("treats absent fresh-install logs as empty but warns on unreadable log paths", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
      try {
        const config = makeDiagnosticsConfig(tempDir);
        fs.unlinkSync(config.serverLogPath);
        fs.rmSync(config.providerLogsDir, { recursive: true, force: true });
        const diagnostics = yield* makeDiagnosticsService(config);
        const snapshot = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        assert.equal(
          snapshot.warnings.some((warning) => warning.code === "diagnostics.log-tail-unavailable"),
          false,
        );
        fs.mkdirSync(config.serverLogPath);
        const unreadable = yield* makeDiagnosticsService(config);
        const partial = yield* unreadable.getSnapshot({ providers: [], terminals: [] });
        assert.equal(
          partial.warnings.some((warning) => warning.code === "diagnostics.log-tail-unavailable"),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("reports provider failures from the newest canonical thread logs", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
      try {
        const config = makeDiagnosticsConfig(tempDir);
        const at = Date.parse("2026-10-12T08:00:00.000Z");
        const canonical = (record: unknown, offsetMs = 0) =>
          formatProviderEventLogLine("CANON", at + offsetMs, JSON.stringify(record));
        fs.writeFileSync(
          path.join(config.providerLogsDir, "thread-a.log"),
          [
            canonical({
              type: "content.delta",
              eventId: "evt-delta",
              payload: { streamKind: "command_output", delta: "error: not a failure" },
            }),
            canonical(
              {
                type: "turn.completed",
                eventId: "evt-turn",
                provider: "codex",
                threadId: "thread-a",
                payload: { state: "failed", errorMessage: "model overloaded" },
              },
              1_000,
            ),
            canonical(
              {
                type: "runtime.error",
                eventId: "evt-error",
                provider: "claudeAgent",
                payload: { message: "auth failed with Bearer private-value" },
              },
              2_000,
            ),
            canonical({ type: "turn.completed", payload: { state: "completed" } }, 3_000),
          ].join(""),
        );
        fs.writeFileSync(
          path.join(config.providerLogsDir, "thread-a.native.log"),
          formatProviderEventLogLine("NTIVE", at, JSON.stringify({ method: "error" })),
        );
        fs.writeFileSync(
          path.join(config.providerLogsDir, "thread-b.log.1"),
          canonical({ type: "runtime.error", payload: { message: "rotated away" } }),
        );

        const diagnostics = yield* makeDiagnosticsService(config);
        const snapshot = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        const providerFailures = snapshot.failures.latest.filter(
          (failure) => failure.source === "provider-events",
        );

        assert.deepEqual(
          providerFailures.map((failure) => [failure.id, failure.category, failure.occurredAt]),
          [
            ["provider:evt-error", "provider", "2026-10-12T08:00:02.000Z"],
            ["provider:evt-turn", "provider", "2026-10-12T08:00:01.000Z"],
          ],
        );
        assert.equal(providerFailures[1]?.message, "model overloaded");
        assert.equal(JSON.stringify(snapshot).includes("private-value"), false);
        assert.equal(JSON.stringify(snapshot).includes("rotated away"), false);
        assert.equal(JSON.stringify(snapshot).includes("not a failure"), false);
        Schema.decodeUnknownSync(DiagnosticsSnapshot)(snapshot);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("reports server failures from the backend's own logfmt log", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
      try {
        const config = makeDiagnosticsConfig(tempDir);
        fs.rmSync(config.serverLogPath);
        yield* Effect.gen(function* () {
          yield* Effect.logInfo("Listening on http://127.0.0.1:3773");
          yield* Effect.logWarning("Failed to refresh PR state", { number: 12 });
          yield* Effect.sleep("20 millis");
          yield* Effect.logWarning("Failed to refresh PR state", { number: 12 });
          yield* Effect.logWarning(
            "Failed to discover the checkout's pull request",
            Cause.fail(new Error("gh: not logged in")),
          );
          yield* Effect.logError("relay failed", { authorization: "Bearer private-value" });
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              Logger.layer([makeServerLogFileLogger({ filePath: config.serverLogPath })], {
                mergeWithExisting: false,
              }),
              Layer.succeed(References.MinimumLogLevel, "Info"),
            ),
          ),
        );

        const diagnostics = yield* makeDiagnosticsService(config);
        const snapshot = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
        const serverFailures = snapshot.failures.latest.filter(
          (failure) => failure.source === "server.log",
        );

        assert.equal(serverFailures.length, 4);
        // The time and fiber are not part of a failure's identity: repeats
        // group together and distinct failures stay apart.
        assert.equal(new Set(serverFailures.map((failure) => failure.signature)).size, 3);
        assert.equal(
          snapshot.failures.common.find((group) => group.source === "server.log")?.count,
          2,
        );
        const refresh = serverFailures.find((failure) =>
          failure.message.startsWith('level=WARN message="Failed to refresh PR state"'),
        );
        assert.notEqual(refresh, undefined);
        assert.include(
          (refresh!.raw as { line: string }).line,
          `timestamp=${refresh!.occurredAt} level=WARN`,
        );
        for (const failure of serverFailures) {
          assert.notMatch(failure.message, /timestamp=|fiber=/);
        }
        assert.equal(JSON.stringify(snapshot).includes("private-value"), false);
        Schema.decodeUnknownSync(DiagnosticsSnapshot)(snapshot);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("samples resources only while a diagnostics snapshot is requested", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
        const config = makeDiagnosticsConfig(tempDir);
        const setIntervalSpy = vi.spyOn(globalThis, "setInterval");

        try {
          const diagnostics = yield* makeDiagnosticsService(config);
          assert.equal(setIntervalSpy.mock.calls.length, 0);

          const first = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
          assert.equal(first.resources.history.length, 1);
          assert.equal(first.resources.current, first.resources.history[0]);
          assert.equal(setIntervalSpy.mock.calls.length, 0);

          fs.appendFileSync(
            config.serverLogPath,
            "2026-08-02T00:00:00.000Z error cached-second-failure\n",
          );
          const second = yield* diagnostics.getSnapshot({ providers: [], terminals: [] });
          assert.equal(second.resources.history.length, 2);
          assert.equal(second.resources.current, second.resources.history[1]);
          assert.equal(setIntervalSpy.mock.calls.length, 0);
          assert.equal(
            second.failures.latest.some((failure) =>
              failure.message.includes("cached-second-failure"),
            ),
            false,
          );
        } finally {
          setIntervalSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("includes bounded local timing and trace persistence health", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
        const config = makeDiagnosticsConfig(tempDir);

        try {
          const diagnostics = yield* makeDiagnosticsService(config, {
            traceSinkHealth: () => ({
              bufferedBytes: 128,
              bufferedRecords: 1,
              maxBufferedBytes: 1_024,
              maxBufferedRecords: 50,
              droppedRecords: 2,
              writeFailures: 3,
              retryDelayMs: 500,
              lastWriteFailureAt: "2026-08-02T00:00:00.000Z",
            }),
          });
          const snapshot = yield* diagnostics.getSnapshot({
            providers: [],
            terminals: [],
            localMetrics: {
              turnQuiescenceAvgMs: 120,
              checkpointDurationP95Ms: 250,
              latestThreadSnapshotDurationMs: 40,
              threadSnapshotDurationP95Ms: 80,
              wsReconnectCount: 2,
              windowSampleCounts: {
                turnQuiescence: 3,
                checkpointDuration: 4,
                threadSnapshotDuration: 5,
              },
              capturedAt: "2026-08-02T00:00:00.000Z",
            },
          });

          if (snapshot.performance === undefined) {
            return assert.fail("Expected operational performance diagnostics");
          }
          assert.equal(snapshot.performance.local.latestThreadSnapshotDurationMs, 40);
          assert.equal(snapshot.performance.local.wsReconnectCount, 2);
          assert.equal(snapshot.performance.traceSink?.bufferedBytes, 128);
          assert.equal(snapshot.performance.traceSink?.droppedRecords, 2);
          assert.equal(snapshot.performance.snapshotCollectionDurationMs >= 0, true);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("aggregates retained traces into diagnostics snapshots", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
        const config = makeDiagnosticsConfig(tempDir);

        const diagnostics = yield* makeDiagnosticsService(config);
        diagnostics.recordTraceRecords([makeTraceRecord()]);
        const snapshot = yield* diagnostics.getSnapshot({
          providers: [],
          terminals: [],
        });

        assert.equal(snapshot.tracing.retainedSpanCount, 1);
        assert.equal(snapshot.tracing.slowestSpans[0]?.name, "server.rpc.failure");
        assert.equal(snapshot.tracing.slowestSpans[0]?.attributes.apiToken, "[redacted]");
        assert.equal(snapshot.tracing.recentEvents[0]?.attributes.authorization, "[redacted]");
        assert.equal(snapshot.failures.latest.length >= 1, true);
        assert.equal(snapshot.failures.common.length >= 1, true);
        fs.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );

  it.effect("maps OTLP STATUS_CODE_ERROR spans to failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
        const config = makeDiagnosticsConfig(tempDir);

        const diagnostics = yield* makeDiagnosticsService(config);
        diagnostics.recordTraceRecords([makeOtlpErrorRecord()]);
        const snapshot = yield* diagnostics.getSnapshot({
          providers: [],
          terminals: [],
        });

        assert.equal(snapshot.tracing.recentSpans[0]?.status, "error");
        assert.equal(snapshot.tracing.recentSpans[0]?.source, "browser");
        assert.equal(
          snapshot.failures.latest.some((failure) => failure.message.includes("Network error")),
          true,
        );
        fs.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );

  it.effect("keeps interrupted spans visible without presenting them as failures", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
        const config = makeDiagnosticsConfig(tempDir);

        try {
          const diagnostics = yield* makeDiagnosticsService(config);
          diagnostics.recordTraceRecords([makeInterruptedTraceRecord()]);
          const snapshot = yield* diagnostics.getSnapshot({
            providers: [],
            terminals: [],
          });

          const interruptedSpan = snapshot.tracing.recentSpans.find(
            (span) => span.spanId === "span-interrupted",
          );
          assert.equal(interruptedSpan?.status, "interrupted");
          assert.equal(interruptedSpan?.failureMessage, undefined);
          assert.equal(
            snapshot.failures.latest.some((failure) =>
              failure.message.includes("All fibers interrupted without error"),
            ),
            false,
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("skips malformed trace records without emptying tracing", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-diag-"));
        const config = makeDiagnosticsConfig(tempDir);

        const diagnostics = yield* makeDiagnosticsService(config);
        diagnostics.recordTraceRecords([makeTraceRecord(), makeMalformedEffectSpanRecord()]);
        const snapshot = yield* diagnostics.getSnapshot({
          providers: [],
          terminals: [],
        });

        assert.equal(snapshot.tracing.retainedSpanCount, 2);
        assert.equal(snapshot.tracing.recentSpans.length, 1);
        assert.equal(snapshot.tracing.recentSpans[0]?.name, "server.rpc.failure");
        assert.equal(
          snapshot.warnings.some((warning) => warning.code === "diagnostics.trace-records-skipped"),
          true,
        );
        fs.rmSync(tempDir, { recursive: true, force: true });
      }),
    ),
  );
});
