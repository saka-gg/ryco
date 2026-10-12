import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { vi } from "vite-plus/test";

import { getResourceAttribution } from "../diagnostics/ResourceAttribution.ts";

import type { EffectTraceRecord, TraceRecord } from "./TraceRecord.ts";
import { makeTraceSink } from "./TraceSink.ts";

const makeRecord = (name: string, suffix = ""): EffectTraceRecord => ({
  type: "effect-span",
  name,
  traceId: `trace-${name}-${suffix}`,
  spanId: `span-${name}-${suffix}`,
  sampled: true,
  kind: "internal",
  startTimeUnixNano: "1",
  endTimeUnixNano: "2",
  durationMs: 1,
  attributes: {
    payload: suffix,
  },
  events: [],
  links: [],
  exit: {
    _tag: "Success",
  },
});

describe("TraceSink", () => {
  it.effect("arms the batch-window timer only after records are buffered", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: Number.MAX_SAFE_INTEGER,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          assert.equal(setTimeoutSpy.mock.calls.length, 0);

          const attributedBefore =
            getResourceAttribution().find((entry) => entry.component === "server-trace")?.count ??
            0;
          sink.push(makeRecord("alpha"));
          assert.equal(setTimeoutSpy.mock.calls.length, 1);

          yield* sink.flush;
          assert.equal(
            getResourceAttribution().find((entry) => entry.component === "server-trace")?.count,
            attributedBefore + 1,
          );
          sink.push(makeRecord("beta"));
          assert.equal(setTimeoutSpy.mock.calls.length, 2);
        } finally {
          setTimeoutSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("re-arms the batch-window timer when a write fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const openSpy = vi
          .spyOn(fs.promises, "open")
          .mockRejectedValueOnce(new Error("forced trace sink write failure"));

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("alpha"));
          assert.equal(setTimeoutSpy.mock.calls.length, 1);

          yield* sink.flush;
          assert.equal(setTimeoutSpy.mock.calls.length, 2);
          assert.equal(sink.health().writeFailures, 1);
          assert.equal(sink.health().retryDelayMs, 10_000);
        } finally {
          openSpy.mockRestore();
          setTimeoutSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("bounds pending records and retains the newest diagnostics", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
            maxBufferedBytes: 10_000,
            maxBufferedRecords: 2,
          });

          sink.push(makeRecord("alpha"));
          sink.push(makeRecord("beta"));
          sink.push(makeRecord("gamma"));

          assert.deepStrictEqual(sink.health(), {
            bufferedBytes: sink.health().bufferedBytes,
            bufferedRecords: 2,
            maxBufferedBytes: 10_000,
            maxBufferedRecords: 2,
            droppedRecords: 1,
            writeFailures: 0,
            retryDelayMs: 0,
            lastWriteFailureAt: null,
          });

          yield* sink.close();

          const records = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);
          assert.deepStrictEqual(
            records.map((record) => record.name),
            ["beta", "gamma"],
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("retains failure diagnostics ahead of successful spans under pressure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 10_000,
            maxFiles: 2,
            batchWindowMs: 10_000,
            maxBufferedBytes: 10_000,
            maxBufferedRecords: 2,
          });

          sink.push({
            ...makeRecord("failure"),
            exit: { _tag: "Failure", cause: "boom" },
          });
          sink.push(makeRecord("success-old"));
          sink.push(makeRecord("success-new"));
          yield* sink.close();

          const records = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);
          assert.deepStrictEqual(
            records.map((record) => record.name),
            ["failure", "success-new"],
          );
          assert.equal(sink.health().droppedRecords, 1);
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("backs off repeated failures and resets the delay after recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");
        const openSpy = vi
          .spyOn(fs.promises, "open")
          .mockRejectedValueOnce(new Error("forced trace sink write failure"))
          .mockRejectedValueOnce(new Error("forced trace sink write failure"));

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 100,
            maxRetryDelayMs: 1_000,
          });

          sink.push(makeRecord("alpha"));
          yield* sink.flush;
          assert.equal(sink.health().retryDelayMs, 250);
          assert.equal(sink.health().bufferedRecords, 1);

          for (let index = 0; index < 40; index += 1) {
            sink.push(makeRecord("during-backoff", String(index)));
          }
          assert.equal(openSpy.mock.calls.length, 1);

          yield* sink.flush;
          assert.equal(sink.health().retryDelayMs, 500);
          assert.equal(sink.health().writeFailures, 2);

          yield* sink.flush;
          assert.equal(sink.health().retryDelayMs, 0);
          assert.equal(sink.health().bufferedRecords, 0);
          assert.equal(sink.health().writeFailures, 2);
          assert.notEqual(sink.health().lastWriteFailureAt, null);
        } finally {
          openSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("schedules a bounded retry instead of recursing when batching is disabled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");
        const setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
        const openSpy = vi
          .spyOn(fs.promises, "open")
          .mockRejectedValueOnce(new Error("forced trace sink write failure"));

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 0,
          });

          sink.push(makeRecord("alpha"));
          yield* sink.flush;

          assert.equal(sink.health().writeFailures, 1);
          assert.equal(sink.health().retryDelayMs, 250);
          assert.equal(setTimeoutSpy.mock.calls.at(-1)?.[1], 250);
        } finally {
          openSpy.mockRestore();
          setTimeoutSpy.mockRestore();
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("flushes buffered records on close", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          sink.push(makeRecord("alpha"));
          sink.push(makeRecord("beta"));
          yield* sink.close();

          const lines = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);

          assert.equal(lines.length, 2);
          assert.equal(lines[0]?.name, "alpha");
          assert.equal(lines[1]?.name, "beta");
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("rotates the trace file when the configured max size is exceeded", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 180,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          for (let index = 0; index < 8; index += 1) {
            sink.push(makeRecord("rotate", `${index}-${"x".repeat(48)}`));
            yield* sink.flush;
          }
          yield* sink.close();

          const matchingFiles = fs
            .readdirSync(tempDir)
            .filter(
              (entry) =>
                entry === "server.trace.ndjson" || entry.startsWith("server.trace.ndjson."),
            )
            .toSorted();

          assert.equal(
            matchingFiles.some((entry) => entry === "server.trace.ndjson.1"),
            true,
          );
          assert.equal(
            matchingFiles.some((entry) => entry === "server.trace.ndjson.3"),
            false,
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );

  it.effect("drops only the invalid record when serialization fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-trace-sink-"));
        const tracePath = path.join(tempDir, "server.trace.ndjson");

        try {
          const sink = yield* makeTraceSink({
            filePath: tracePath,
            maxBytes: 1024,
            maxFiles: 2,
            batchWindowMs: 10_000,
          });

          const circular: Array<unknown> = [];
          circular.push(circular);

          sink.push(makeRecord("alpha"));
          sink.push({
            ...makeRecord("invalid"),
            attributes: {
              circular,
            },
          } as TraceRecord);
          sink.push(makeRecord("beta"));
          assert.equal(sink.health().droppedRecords, 1);
          yield* sink.close();

          const lines = fs
            .readFileSync(tracePath, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as TraceRecord);

          assert.deepStrictEqual(
            lines.map((line) => line.name),
            ["alpha", "beta"],
          );
        } finally {
          fs.rmSync(tempDir, { recursive: true, force: true });
        }
      }),
    ),
  );
});
