import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References, Tracer } from "effect";

import type { EffectTraceRecord } from "./TraceRecord.ts";
import { makeLocalFileTracer, type LocalFileTracerOptions } from "./LocalFileTracer.ts";

type ThresholdOptions = Pick<
  LocalFileTracerOptions,
  "sqlSpanMinDurationMs" | "spanMinDurationMs" | "delegate"
>;

const makeTestLayer = (tracePath: string, thresholds: ThresholdOptions = {}) =>
  Layer.mergeAll(
    Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 10_000,
        ...thresholds,
      }),
    ),
    Logger.layer([Logger.tracerLogger], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

const readTraceRecords = (tracePath: string): Array<EffectTraceRecord> =>
  fs
    .readFileSync(tracePath, "utf8")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as EffectTraceRecord);

describe("LocalFileTracer", () => {
  it.effect("writes nested spans to disk and captures log messages as span events", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            const program = Effect.gen(function* () {
              yield* Effect.annotateCurrentSpan({
                "demo.parent": true,
              });
              yield* Effect.logInfo("parent event");
              yield* Effect.gen(function* () {
                yield* Effect.annotateCurrentSpan({
                  "demo.child": true,
                });
                yield* Effect.logInfo("child event");
              }).pipe(Effect.withSpan("child-span"));
            }).pipe(Effect.withSpan("parent-span"));

            yield* program.pipe(Effect.provide(makeTestLayer(tracePath, { spanMinDurationMs: 0 })));
          }),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(records.length, 2);

        const parent = records.find((record) => record.name === "parent-span");
        const child = records.find((record) => record.name === "child-span");

        assert.notEqual(parent, undefined);
        assert.notEqual(child, undefined);
        if (!parent || !child) {
          return;
        }

        assert.equal(child.parentSpanId, parent.spanId);
        assert.equal(parent.attributes["demo.parent"], true);
        assert.equal(child.attributes["demo.child"], true);
        assert.equal(
          parent.events.some((event) => event.name === "parent event"),
          true,
        );
        assert.equal(
          child.events.some((event) => event.name === "child event"),
          true,
        );
        assert.equal(
          child.events.some((event) => event.attributes["effect.logLevel"] === "INFO"),
          true,
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("serializes interrupted spans with an interrupted exit status", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.exit(
            Effect.interrupt.pipe(
              Effect.withSpan("interrupt-span"),
              Effect.provide(makeTestLayer(tracePath)),
            ),
          ),
        );

        const records = readTraceRecords(tracePath);
        assert.equal(records.length, 1);
        assert.equal(records[0]?.name, "interrupt-span");
        assert.equal(records[0]?.exit._tag, "Interrupted");
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  const sqlStatement = (
    name: string,
    options: { readonly sleepMs?: number; readonly fail?: boolean },
  ) =>
    Effect.gen(function* () {
      yield* Effect.annotateCurrentSpan({
        "db.query.text": "SELECT *\n  FROM   projection_threads\n  WHERE id = ?",
      });
      if (options.sleepMs !== undefined) yield* Effect.sleep(`${options.sleepMs} millis`);
      if (options.fail) return yield* Effect.fail("constraint failed");
    }).pipe(Effect.withSpan(name), Effect.ignore);

  it.live("keeps only slow or failed SQL statement spans in the local trace", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* sqlStatement("fast-sql", {});
            yield* sqlStatement("slow-sql", { sleepMs: 40 });
            yield* sqlStatement("failed-sql", { fail: true });
            yield* Effect.void.pipe(Effect.withSpan("plain-span"));
          }).pipe(Effect.provide(makeTestLayer(tracePath, { sqlSpanMinDurationMs: 25 }))),
        );

        const records = readTraceRecords(tracePath);
        assert.deepEqual(records.map((record) => record.name).toSorted(), [
          "failed-sql",
          "plain-span",
          "slow-sql",
        ]);
        assert.equal(
          records.find((record) => record.name === "slow-sql")?.attributes["db.query.text"],
          "SELECT * FROM projection_threads WHERE id = ?",
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("normalizes SQL text only for the statement spans it keeps", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");
      const rawSql = "SELECT *\n  FROM   projection_threads\n  WHERE id = ?";
      const spans: Array<Tracer.Span> = [];
      const statement = (name: string, sleepMs: number) =>
        Effect.gen(function* () {
          yield* Effect.annotateCurrentSpan({ "db.query.text": rawSql });
          spans.push(yield* Effect.currentSpan);
          yield* Effect.sleep(`${sleepMs} millis`);
        }).pipe(Effect.withSpan(name), Effect.ignore);

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* statement("fast-sql", 0);
            yield* statement("slow-sql", 40);
          }).pipe(Effect.provide(makeTestLayer(tracePath, { sqlSpanMinDurationMs: 25 }))),
        );

        const [fast, slow] = spans;
        // The dropped statement's text was never rewritten.
        assert.equal(fast?.attributes.get("db.query.text"), rawSql);
        assert.equal(
          slow?.attributes.get("db.query.text"),
          "SELECT * FROM projection_threads WHERE id = ?",
        );
        assert.deepEqual(
          readTraceRecords(tracePath).map((record) => [
            record.name,
            record.attributes["db.query.text"],
          ]),
          [["slow-sql", "SELECT * FROM projection_threads WHERE id = ?"]],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("records every SQL statement when the threshold is zero", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          sqlStatement("fast-sql", {}).pipe(
            Effect.provide(makeTestLayer(tracePath, { sqlSpanMinDurationMs: 0 })),
          ),
        );
        assert.deepEqual(
          readTraceRecords(tracePath).map((record) => record.name),
          ["fast-sql"],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  const spanNames = (tracePath: string) =>
    readTraceRecords(tracePath)
      .map((record) => record.name)
      .toSorted();

  /** A root span around a fast child, a slow child and a failed child. */
  const childSpans = Effect.gen(function* () {
    yield* Effect.void.pipe(Effect.withSpan("fast-child"));
    yield* Effect.sleep("40 millis").pipe(Effect.withSpan("slow-child"));
    yield* Effect.fail("boom").pipe(Effect.withSpan("failed-child"), Effect.ignore);
  }).pipe(Effect.withSpan("root"));

  const runChildSpans = (thresholds?: ThresholdOptions) =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");
      try {
        yield* Effect.scoped(childSpans.pipe(Effect.provide(makeTestLayer(tracePath, thresholds))));
        return spanNames(tracePath);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

  it.live("leaves short successful child spans out of the local trace", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* runChildSpans({ spanMinDurationMs: 25 }), [
        "failed-child",
        "root",
        "slow-child",
      ]);
    }),
  );

  it.live("drops short child spans by default", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* runChildSpans(), ["failed-child", "root", "slow-child"]);
    }),
  );

  it.live("keeps every span when the span threshold is zero", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* runChildSpans({ spanMinDurationMs: 0 }), [
        "failed-child",
        "fast-child",
        "root",
        "slow-child",
      ]);
    }),
  );

  it.live("keeps short root spans, including ones continuing a remote trace", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.void.pipe(Effect.withSpan("plain-root"));
            yield* Effect.void.pipe(
              Effect.withSpan("remote-continuation", {
                parent: Tracer.externalSpan({ traceId: "remote-trace", spanId: "remote-span" }),
              }),
            );
          }).pipe(Effect.provide(makeTestLayer(tracePath, { spanMinDurationMs: 25 }))),
        );
        assert.deepEqual(spanNames(tracePath), ["plain-root", "remote-continuation"]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("keeps interrupted child spans", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.exit(
            Effect.interrupt.pipe(
              Effect.withSpan("interrupted-child"),
              Effect.withSpan("root"),
              Effect.provide(makeTestLayer(tracePath, { spanMinDurationMs: 25 })),
            ),
          ),
        );
        assert.deepEqual(spanNames(tracePath), ["interrupted-child", "root"]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("keeps short child spans that recorded a log message", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Effect.logWarning("recovered from a hiccup").pipe(Effect.withSpan("warned"));
            yield* Effect.logError("gave up on a retry").pipe(Effect.withSpan("errored"));
            yield* Effect.logInfo("finished quickly").pipe(Effect.withSpan("informed"));
            yield* Effect.void.pipe(Effect.withSpan("silent"));
          }).pipe(
            Effect.withSpan("root"),
            Effect.provide(makeTestLayer(tracePath, { spanMinDurationMs: 25 })),
          ),
        );

        const records = readTraceRecords(tracePath);
        assert.deepEqual(spanNames(tracePath), ["errored", "informed", "root", "warned"]);
        assert.deepEqual(
          records
            .filter((record) => record.name !== "root")
            .map((record) => [
              record.name,
              record.events.map((event) => [event.name, event.attributes["effect.logLevel"]]),
            ])
            .toSorted(),
          [
            ["errored", [["gave up on a retry", "ERROR"]]],
            ["informed", [["finished quickly", "INFO"]]],
            ["warned", [["recovered from a hiccup", "WARN"]]],
          ],
        );
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("applies no duration threshold when tracer timing is disabled", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* childSpans;
            yield* sqlStatement("fast-sql", {});
          }).pipe(
            Effect.provideService(References.TracerTimingEnabled, false),
            Effect.provide(makeTestLayer(tracePath, { sqlSpanMinDurationMs: 25 })),
          ),
        );
        assert.deepEqual(spanNames(tracePath), [
          "failed-child",
          "fast-child",
          "fast-sql",
          "root",
          "slow-child",
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("sends every span to the delegate tracer", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");
      const delegated: Array<string> = [];
      const delegate = Tracer.make({
        span: (spanOptions) => {
          const span = new Tracer.NativeSpan(spanOptions);
          const end = span.end.bind(span);
          span.end = (endTime, exit) => {
            delegated.push(span.name);
            end(endTime, exit);
          };
          return span;
        },
      });

      try {
        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* childSpans;
            yield* sqlStatement("fast-sql", {}).pipe(Effect.withSpan("sql-parent"));
          }).pipe(Effect.provide(makeTestLayer(tracePath, { spanMinDurationMs: 25, delegate }))),
        );
        assert.deepEqual(spanNames(tracePath), [
          "failed-child",
          "root",
          "slow-child",
          "sql-parent",
        ]);
        assert.deepEqual(delegated.toSorted(), [
          "failed-child",
          "fast-child",
          "fast-sql",
          "root",
          "slow-child",
          "sql-parent",
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }),
  );

  it.live("applies only the statement threshold to child statement spans", () =>
    Effect.gen(function* () {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const tracePath = path.join(tempDir, "server.trace.ndjson");
      const statements = sqlStatement("fast-sql", {}).pipe(Effect.withSpan("parent"));

      try {
        // Zero keeps the statement even though it is faster than the span threshold.
        yield* Effect.scoped(
          statements.pipe(
            Effect.provide(
              makeTestLayer(tracePath, { sqlSpanMinDurationMs: 0, spanMinDurationMs: 25 }),
            ),
          ),
        );
        assert.deepEqual(spanNames(tracePath), ["fast-sql", "parent"]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }

      const otherDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-local-tracer-"));
      const otherPath = path.join(otherDir, "server.trace.ndjson");
      try {
        // A zero span threshold does not bring back statements the statement threshold drops.
        yield* Effect.scoped(
          statements.pipe(
            Effect.provide(
              makeTestLayer(otherPath, { sqlSpanMinDurationMs: 25, spanMinDurationMs: 0 }),
            ),
          ),
        );
        assert.deepEqual(spanNames(otherPath), ["parent"]);
      } finally {
        fs.rmSync(otherDir, { recursive: true, force: true });
      }
    }),
  );
});
