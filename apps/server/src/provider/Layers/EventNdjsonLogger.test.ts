import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { ThreadId } from "@ryco/contracts";
import { AsyncRotatingFileSink } from "@ryco/shared/logging";
import { assert, describe, it, vi } from "@effect/vitest";
import { Effect, Metric } from "effect";

import { getResourceAttribution } from "../../diagnostics/ResourceAttribution.ts";
import { metricNames } from "../../observability/Metrics.ts";
import { hasMetricSnapshot } from "../../observability/testMetricSnapshots.ts";
import type { ProviderEventLogMode } from "@ryco/contracts";

import { makeEventNdjsonLogger, sweepLogDirectory } from "./EventNdjsonLogger.ts";

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const waitUntil = (condition: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 300 && !condition(); attempt += 1) {
      yield* sleep(10);
    }
    assert.isTrue(condition(), "condition not met within 3 s");
  });

/**
 * Holds the first `AsyncRotatingFileSink.close()` (an evicted writer's last
 * step, which waits for backup compression) open until `release()`.
 */
const holdFirstSinkClose = () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = AsyncRotatingFileSink.prototype.close;
  const spy = vi.spyOn(AsyncRotatingFileSink.prototype, "close").mockImplementationOnce(function (
    this: AsyncRotatingFileSink,
  ) {
    return gate.then(() => original.call(this));
  });
  return {
    calls: () => spy.mock.calls.length,
    release,
    restore: () => spy.mockRestore(),
  };
};

function readRecords(filePath: string): Array<Record<string, any>> {
  return fs
    .readFileSync(filePath, "utf8")
    .trim()
    .split("\n")
    .map((line) => JSON.parse(parseLogLine(line).payload) as Record<string, any>);
}

function parseLogLine(line: string) {
  const match = /^\[([^\]]+)\] ([A-Z]+): (.+)$/.exec(line);
  assert.notEqual(match, null);
  if (!match) {
    throw new Error(`invalid log line: ${line}`);
  }
  const observedAt = match[1];
  const stream = match[2];
  const payload = match[3];
  if (!observedAt || !stream || payload === undefined) {
    throw new Error(`invalid log line: ${line}`);
  }
  return {
    observedAt,
    stream,
    payload,
  };
}

describe("EventNdjsonLogger", () => {
  it.effect("writes effect-style lines to thread-scoped files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const attributedBefore = getResourceAttribution().find(
          (entry) => entry.component === "provider-native",
        );
        const logger = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* logger.write(
          { threadId: "provider-thread-1", id: "evt-1" },
          ThreadId.make("thread-1"),
        );
        yield* logger.write(
          { type: "turn.completed", threadId: "provider-thread-2", id: "evt-2" },
          ThreadId.make("thread-2"),
        );
        yield* logger.close();

        const threadOnePath = path.join(tempDir, "thread-1.native.log");
        const threadTwoPath = path.join(tempDir, "thread-2.native.log");
        assert.equal(fs.existsSync(threadOnePath), true);
        assert.equal(fs.existsSync(threadTwoPath), true);
        const attributedAfter = getResourceAttribution().find(
          (entry) => entry.component === "provider-native",
        );
        assert.equal(attributedAfter?.count, (attributedBefore?.count ?? 0) + 2);
        assert.equal(
          (attributedAfter?.logicalWriteBytes ?? 0) - (attributedBefore?.logicalWriteBytes ?? 0),
          fs.statSync(threadOnePath).size + fs.statSync(threadTwoPath).size,
        );

        const first = parseLogLine(fs.readFileSync(threadOnePath, "utf8").trim());
        const second = parseLogLine(fs.readFileSync(threadTwoPath, "utf8").trim());

        assert.equal(Number.isNaN(Date.parse(first.observedAt)), false);
        assert.equal(first.stream, "NTIVE");
        assert.equal(first.payload, '{"threadId":"provider-thread-1","id":"evt-1"}');

        assert.equal(Number.isNaN(Date.parse(second.observedAt)), false);
        assert.equal(second.stream, "NTIVE");
        assert.equal(
          second.payload,
          '{"type":"turn.completed","threadId":"provider-thread-2","id":"evt-2"}',
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(
    "falls back to a global segment when orchestration thread id is missing or invalid",
    () =>
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
        const basePath = path.join(tempDir, "provider-canonical.ndjson");

        try {
          const logger = yield* makeEventNdjsonLogger(basePath, { stream: "orchestration" });
          assert.notEqual(logger, undefined);
          if (!logger) {
            return;
          }

          yield* logger.write({ id: "evt-no-thread" }, null);
          yield* logger.write({ id: "evt-invalid-thread" }, "!!!" as unknown as ThreadId);
          yield* logger.close();

          const globalPath = path.join(tempDir, "_global.log");
          assert.equal(fs.existsSync(globalPath), true);
          const lines = fs
            .readFileSync(globalPath, "utf8")
            .trim()
            .split("\n")
            .map((line) => parseLogLine(line));
          assert.equal(lines.length, 2);
          assert.equal(Number.isNaN(Date.parse(lines[0]?.observedAt ?? "")), false);
          assert.equal(Number.isNaN(Date.parse(lines[1]?.observedAt ?? "")), false);
          assert.equal(lines[0]?.stream, "CANON");
          assert.equal(lines[0]?.payload, '{"id":"evt-no-thread"}');
          assert.equal(lines[1]?.stream, "CANON");
          assert.equal(lines[1]?.payload, '{"id":"evt-invalid-thread"}');
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
  );

  it.effect("serializes concurrent first writes for the same segment", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const basePath = path.join(tempDir, "provider-canonical.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "canonical",
          batchWindowMs: 0,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        yield* Effect.all(
          [
            logger.write({ id: "evt-concurrent-1" }, null),
            logger.write({ id: "evt-concurrent-2" }, null),
          ],
          { concurrency: "unbounded" },
        );
        yield* logger.close();

        const globalPath = path.join(tempDir, "_global.log");
        assert.equal(fs.existsSync(globalPath), true);
        const lines = fs
          .readFileSync(globalPath, "utf8")
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line));

        assert.equal(lines.length, 2);
        assert.deepEqual(lines.map((line) => line.payload).toSorted(), [
          '{"id":"evt-concurrent-1"}',
          '{"id":"evt-concurrent-2"}',
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("rotates per-thread files when max size is exceeded", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          maxBytes: 120,
          maxFiles: 2,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        for (let index = 0; index < 10; index += 1) {
          yield* logger.write(
            {
              threadId: "provider-thread-rotate",
              id: `evt-${index}`,
              payload: "x".repeat(40),
            },
            ThreadId.make("thread-rotate"),
          );
        }
        yield* logger.close();

        const fileStem = "thread-rotate.native.log";
        const matchingFiles = fs
          .readdirSync(tempDir)
          .filter((entry) => entry === fileStem || entry.startsWith(`${fileStem}.`))
          .toSorted();

        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.1`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === fileStem || entry === `${fileStem}.2`),
          true,
        );
        assert.equal(
          matchingFiles.some((entry) => entry === `${fileStem}.3`),
          false,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drops and counts records when the bounded logging queue is full", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "s3-provider-log-"));
      const basePath = path.join(tempDir, "provider-native.ndjson");

      try {
        const logger = yield* makeEventNdjsonLogger(basePath, {
          stream: "native",
          batchWindowMs: 100,
          maxQueueSize: 1,
        });
        assert.notEqual(logger, undefined);
        if (!logger) {
          return;
        }

        const attempts = 200;
        yield* Effect.all(
          Array.from({ length: attempts }, (_, index) =>
            logger.write({ id: `evt-drop-${index}` }, null),
          ),
          { concurrency: "unbounded", discard: true },
        );
        yield* logger.close();

        const snapshots = yield* Metric.snapshot;
        assert.equal(
          hasMetricSnapshot(snapshots, metricNames.providerEventLogRecordsDroppedTotal, {
            stream: "native",
            reason: "queue_full",
            maxQueueSize: "1",
          }),
          true,
        );

        const globalPath = path.join(tempDir, "_global.native.log");
        const lines = fs.existsSync(globalPath)
          ? fs.readFileSync(globalPath, "utf8").trim().split("\n").filter(Boolean)
          : [];
        assert.equal(lines.length < attempts, true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );
  it.effect("keeps native and canonical streams in separate per-thread files", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const basePath = path.join(tempDir, "events.log");

      try {
        const native = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        const canonical = yield* makeEventNdjsonLogger(basePath, { stream: "canonical" });
        assert.notEqual(native, undefined);
        assert.notEqual(canonical, undefined);
        if (!native || !canonical) {
          return;
        }

        const threadId = ThreadId.make("thread-split");
        yield* native.write({ id: "evt-native" }, threadId);
        yield* canonical.write({ id: "evt-canonical" }, threadId);
        yield* native.close();
        yield* canonical.close();

        const nativeLines = fs
          .readFileSync(path.join(tempDir, "thread-split.native.log"), "utf8")
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line));
        const canonicalLines = fs
          .readFileSync(path.join(tempDir, "thread-split.log"), "utf8")
          .trim()
          .split("\n")
          .map((line) => parseLogLine(line));

        assert.deepEqual(
          nativeLines.map((line) => line.stream),
          ["NTIVE"],
        );
        assert.deepEqual(
          canonicalLines.map((line) => line.stream),
          ["CANON"],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("coalesces consecutive streaming deltas into one record per content stream", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const basePath = path.join(tempDir, "events.log");
      const threadId = ThreadId.make("thread-deltas");
      const claudeDelta = (index: number, type: string, field: string, text: string) => ({
        observedAt: "2026-10-12T00:00:00.000Z",
        event: {
          id: `evt-${text}`,
          kind: "notification",
          provider: "claudeAgent",
          method: `claude/stream_event/content_block_delta/${type}`,
          turnId: "turn-1",
          payload: {
            type: "stream_event",
            event: { type: "content_block_delta", index, delta: { type, [field]: text } },
          },
        },
      });

      try {
        const native = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        const canonical = yield* makeEventNdjsonLogger(basePath, { stream: "canonical" });
        if (!native || !canonical) {
          return assert.fail("expected loggers");
        }

        yield* native.write(claudeDelta(0, "text_delta", "text", "he"), threadId);
        yield* native.write(claudeDelta(0, "text_delta", "text", "llo"), threadId);
        yield* native.write(
          {
            observedAt: "2026-10-12T00:00:00.000Z",
            event: { method: "claude/stream_event/content_block_stop", payload: { index: 0 } },
          },
          threadId,
        );
        yield* native.write(claudeDelta(1, "thinking_delta", "thinking", "a"), threadId);
        yield* native.write(claudeDelta(1, "thinking_delta", "thinking", "b"), threadId);
        for (const delta of ["x", "y", "z"]) {
          yield* canonical.write(
            {
              type: "content.delta",
              eventId: `evt-${delta}`,
              threadId: "thread-deltas",
              itemId: "item-1",
              payload: { streamKind: "assistant_text", delta },
              raw: { source: "codex.app-server.notification", payload: { delta } },
            },
            threadId,
          );
        }
        yield* native.close();
        yield* canonical.close();

        const nativeRecords = readRecords(path.join(tempDir, "thread-deltas.native.log"));
        assert.deepEqual(
          nativeRecords.map((record) => [record.event.kind, record.event.text ?? null]),
          [
            ["delta-run", "hello"],
            [undefined, null],
            ["delta-run", "ab"],
          ],
        );
        assert.equal(nativeRecords[0]?.event.count, 2);
        assert.equal(nativeRecords[0]?.event.index, 0);

        const canonicalRecords = readRecords(path.join(tempDir, "thread-deltas.log"));
        assert.equal(canonicalRecords.length, 1);
        assert.equal(canonicalRecords[0]?.type, "content.delta");
        assert.equal(canonicalRecords[0]?.kind, "delta-run");
        assert.equal(canonicalRecords[0]?.count, 3);
        assert.deepEqual(canonicalRecords[0]?.payload, {
          streamKind: "assistant_text",
          delta: "xyz",
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("coalesces OpenCode part deltas and Copilot assistant deltas", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const basePath = path.join(tempDir, "events.log");
      const openCodeThread = ThreadId.make("thread-opencode");
      const copilotThread = ThreadId.make("thread-copilot");
      const openCodeDelta = (partID: string, delta: string) => ({
        observedAt: "2026-10-12T00:00:00.000Z",
        event: {
          provider: "opencode",
          threadId: "thread-opencode",
          providerThreadId: "ses-1",
          type: "message.part.delta",
          turnId: "turn-1",
          payload: {
            type: "message.part.delta",
            properties: { sessionID: "ses-1", messageID: "msg-1", partID, field: "text", delta },
          },
        },
      });
      const copilotEvent = (type: string, data: Record<string, unknown>) => ({
        observedAt: "2026-10-12T00:00:00.000Z",
        event: { id: `evt-${type}`, timestamp: "t", parentId: null, ephemeral: true, type, data },
      });

      try {
        const native = yield* makeEventNdjsonLogger(basePath, { stream: "native" });
        if (!native) {
          return assert.fail("expected logger");
        }

        for (const delta of ["he", "llo"]) {
          yield* native.write(openCodeDelta("part-1", delta), openCodeThread);
        }
        for (const delta of ["wor", "ld"]) {
          yield* native.write(openCodeDelta("part-2", delta), openCodeThread);
        }
        for (const delta of ["th", "ink"]) {
          yield* native.write(
            copilotEvent("assistant.reasoning_delta", { reasoningId: "r-1", deltaContent: delta }),
            copilotThread,
          );
        }
        for (const delta of ["a", "b", "c"]) {
          yield* native.write(
            copilotEvent("assistant.message_delta", { messageId: "msg-1", deltaContent: delta }),
            copilotThread,
          );
        }
        yield* native.write(
          copilotEvent("assistant.message", { messageId: "msg-1", content: "abc" }),
          copilotThread,
        );
        yield* native.close();

        assert.deepEqual(
          readRecords(path.join(tempDir, "thread-opencode.native.log")).map((record) => [
            record.event.kind,
            record.event.type,
            record.event.partId,
            record.event.count,
            record.event.text,
          ]),
          [
            ["delta-run", "message.part.delta", "part-1", 2, "hello"],
            ["delta-run", "message.part.delta", "part-2", 2, "world"],
          ],
        );
        assert.deepEqual(
          readRecords(path.join(tempDir, "thread-copilot.native.log")).map((record) => [
            record.event.kind ?? null,
            record.event.type,
            record.event.reasoningId ?? record.event.messageId,
            record.event.text ?? null,
          ]),
          [
            ["delta-run", "assistant.reasoning_delta", "r-1", "think"],
            ["delta-run", "assistant.message_delta", "msg-1", "abc"],
            [null, "assistant.message", undefined, null],
          ],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("keeps canonical raw payloads the lifecycle native log does not hold", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const threadId = ThreadId.make("thread-lifecycle-raw");

      try {
        const canonical = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "canonical",
          mode: () => "lifecycle",
        });
        if (!canonical) {
          return assert.fail("expected logger");
        }
        yield* canonical.write(
          {
            type: "task.completed",
            payload: { taskId: "task-1", status: "completed" },
            raw: {
              source: "claude.sdk.message",
              method: "claude/system/task_notification",
              payload: { uuid: "sdk-uuid", task_id: "task-1", output_file: "/tmp/out.txt" },
            },
          },
          threadId,
        );
        yield* canonical.write(
          {
            type: "session.configured",
            payload: {},
            raw: {
              source: "claude.sdk.message",
              method: "claude/system/init",
              payload: { uuid: "init-uuid", tools: ["Bash"] },
            },
          },
          threadId,
        );
        yield* canonical.close();

        const records = readRecords(path.join(tempDir, "thread-lifecycle-raw.log"));
        assert.equal(records[0]?.raw.payload.output_file, "/tmp/out.txt");
        assert.deepEqual(records[1]?.raw, {
          source: "claude.sdk.message",
          method: "claude/system/init",
          nativeId: "init-uuid",
        });
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("applies the current detail level to every write", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const threadId = ThreadId.make("thread-mode");
      let mode: ProviderEventLogMode = "lifecycle";

      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "canonical",
          mode: () => mode,
        });
        if (!logger) {
          return assert.fail("expected logger");
        }

        yield* logger.write({ type: "content.delta", payload: { delta: "dropped" } }, threadId);
        yield* logger.write({ type: "turn.completed", payload: { state: "completed" } }, threadId);
        mode = "off";
        yield* logger.write({ type: "runtime.error", payload: { message: "dropped" } }, threadId);
        assert.equal(fs.existsSync(path.join(tempDir, "_global.log")), false);
        mode = "full";
        yield* logger.write({ type: "task.progress", payload: { taskId: "t" } }, threadId);
        yield* logger.close();

        assert.deepEqual(
          readRecords(path.join(tempDir, "thread-mode.log")).map((record) => record.type),
          ["turn.completed", "task.progress"],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("never fails the caller on a record the policy cannot inspect", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const threadId = ThreadId.make("thread-hostile");
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "canonical",
          mode: () => "lifecycle",
        });
        const hostile = {
          get type(): string {
            throw new Error("getter exploded");
          },
        };
        yield* logger!.write(hostile, threadId);
        yield* logger!.write({ type: "turn.completed", id: "after" }, threadId);
        yield* logger!.close();

        assert.deepEqual(
          readRecords(path.join(tempDir, "thread-hostile.log")).map((record) => record.id),
          ["after"],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("writes nothing and creates no file while logging is off", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
          mode: () => "off",
        });
        yield* logger!.write({ kind: "error", method: "error" }, ThreadId.make("thread-off"));
        yield* logger!.close();
        assert.deepEqual(fs.readdirSync(tempDir), []);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("bounds each thread's queue by size, not only by record count", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
          batchWindowMs: 1_000,
          maxQueueChars: 300,
        });
        for (let index = 0; index < 10; index += 1) {
          yield* logger!.write({ id: `evt-size-${index}`, text: "x".repeat(150) }, null);
        }
        yield* logger!.close();

        const snapshots = yield* Metric.snapshot;
        assert.equal(
          hasMetricSnapshot(snapshots, metricNames.providerEventLogRecordsDroppedTotal, {
            stream: "native",
            reason: "queue_full",
          }),
          true,
        );
        assert.equal(readRecords(path.join(tempDir, "_global.native.log")).length, 1);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("closes idle writers and reopens the file on the next record", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const filePath = path.join(tempDir, "thread-idle.native.log");
      const threadId = ThreadId.make("thread-idle");
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
          batchWindowMs: 5,
          idleWriterTtlMs: 1,
        });
        yield* logger!.write({ id: "before-eviction" }, threadId);
        yield* sleep(600);
        assert.deepEqual(readRecords(filePath), [{ id: "before-eviction" }]);

        // A writer still holding its handle would keep appending to the
        // unlinked file; an evicted one reopens the path.
        fs.rmSync(filePath);
        yield* logger!.write({ id: "after-eviction" }, threadId);
        yield* logger!.close();
        assert.deepEqual(readRecords(filePath), [{ id: "after-eviction" }]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("starts a replacement writer only after its evicted predecessor has closed", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const filePath = path.join(tempDir, "thread-recreate.native.log");
      const threadId = ThreadId.make("thread-recreate");
      const held = holdFirstSinkClose();
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
          batchWindowMs: 5,
          idleWriterTtlMs: 1,
        });
        yield* logger!.write({ id: "evt-0" }, threadId);
        // Flushed, idle, evicted: its close (backup compression included) is held open.
        yield* waitUntil(() => held.calls() === 1);

        yield* logger!.write({ id: "evt-1" }, threadId);
        yield* sleep(50);
        // Rotating the same file now could race the old sink's compression.
        assert.deepEqual(readRecords(filePath), [{ id: "evt-0" }]);

        held.release();
        yield* logger!.close();
        assert.deepEqual(readRecords(filePath), [{ id: "evt-0" }, { id: "evt-1" }]);
      } finally {
        held.restore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("close waits for evicted writers that are still closing", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const filePath = path.join(tempDir, "thread-closing.native.log");
      const threadId = ThreadId.make("thread-closing");
      const held = holdFirstSinkClose();
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "native",
          batchWindowMs: 5,
          idleWriterTtlMs: 1,
        });
        yield* logger!.write({ id: "evt-0" }, threadId);
        yield* waitUntil(() => held.calls() === 1);
        // A replacement that never writes a batch (its record serializes to
        // nothing) is evicted while the first writer is still closing.
        yield* logger!.write(undefined, threadId);
        yield* sleep(600);

        let closed = false;
        const closing = Effect.runPromise(logger!.close()).then(() => {
          closed = true;
        });
        yield* sleep(50);
        assert.isFalse(closed);

        held.release();
        yield* Effect.promise(() => closing);
        assert.deepEqual(readRecords(filePath), [{ id: "evt-0" }]);
      } finally {
        held.restore();
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("drains pending records on close and drops records written afterwards", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      try {
        const logger = yield* makeEventNdjsonLogger(path.join(tempDir, "events.log"), {
          stream: "canonical",
          batchWindowMs: 60_000,
        });
        yield* logger!.write({ type: "turn.completed", id: "pending" }, null);
        yield* logger!.close();
        yield* logger!.write({ type: "turn.completed", id: "late" }, null);
        yield* sleep(20);

        assert.deepEqual(
          readRecords(path.join(tempDir, "_global.log")).map((record) => record.id),
          ["pending"],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("removes the oldest files until the directory fits its byte budget", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const now = Date.now();
      try {
        const files = ["oldest.log", "older.native.log.1.gz", "newer.log", "newest.log"];
        files.forEach((name, index) => {
          const filePath = path.join(tempDir, name);
          fs.writeFileSync(filePath, "x".repeat(100));
          const mtime = new Date(now - (files.length - index) * 60_000);
          fs.utimesSync(filePath, mtime, mtime);
        });
        fs.writeFileSync(path.join(tempDir, "notes.txt"), "x".repeat(1_000));

        const removed = yield* sweepLogDirectory(tempDir, { maxTotalBytes: 250, now });

        assert.equal(removed, 2);
        assert.deepEqual(fs.readdirSync(tempDir).toSorted(), [
          "newer.log",
          "newest.log",
          "notes.txt",
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("sweeps stale log files past the retention window", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      const dayMs = 24 * 60 * 60 * 1000;
      const now = Date.now();

      try {
        const stale = path.join(tempDir, "old-thread.log");
        const staleRotated = path.join(tempDir, "old-thread.log.2");
        const fresh = path.join(tempDir, "fresh-thread.log");
        const unrelated = path.join(tempDir, "notes.txt");
        for (const file of [stale, staleRotated, fresh, unrelated]) {
          fs.writeFileSync(file, "x");
        }
        const staleTime = new Date(now - 40 * dayMs);
        fs.utimesSync(stale, staleTime, staleTime);
        fs.utimesSync(staleRotated, staleTime, staleTime);
        fs.utimesSync(unrelated, staleTime, staleTime);

        const removed = yield* sweepLogDirectory(tempDir, { maxAgeMs: 30 * dayMs, now });

        assert.equal(removed, 2);
        assert.equal(fs.existsSync(stale), false);
        assert.equal(fs.existsSync(staleRotated), false);
        assert.equal(fs.existsSync(fresh), true);
        // Non-log files are never touched, stale or not.
        assert.equal(fs.existsSync(unrelated), true);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("sweep of a missing directory is a no-op", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-log-"));
      fs.rmSync(tempDir, { recursive: true, force: true });
      const removed = yield* sweepLogDirectory(tempDir);
      assert.equal(removed, 0);
    }),
  );
});
