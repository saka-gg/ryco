import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Logger, References, Tracer } from "effect";

import type { EffectTraceRecord } from "./TraceRecord.ts";
import { makeLocalFileTracer } from "./LocalFileTracer.ts";

const makeTestLayer = (tracePath: string, sqlSpanMinDurationMs?: number) =>
  Layer.mergeAll(
    Layer.effect(
      Tracer.Tracer,
      makeLocalFileTracer({
        filePath: tracePath,
        maxBytes: 1024 * 1024,
        maxFiles: 2,
        batchWindowMs: 10_000,
        ...(sqlSpanMinDurationMs === undefined ? {} : { sqlSpanMinDurationMs }),
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

            yield* program.pipe(Effect.provide(makeTestLayer(tracePath)));
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
          }).pipe(Effect.provide(makeTestLayer(tracePath, 25))),
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
          }).pipe(Effect.provide(makeTestLayer(tracePath, 25))),
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
          sqlStatement("fast-sql", {}).pipe(Effect.provide(makeTestLayer(tracePath, 0))),
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
});
