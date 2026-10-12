import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Layer, Logger, References } from "effect";

import { ServerConfig, type RuntimeMode } from "./config.ts";
import {
  makeServerLogFileLogger,
  ServerLoggerLive,
  type ServerLogFileLoggerOptions,
} from "./serverLogger.ts";

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

const readLines = (filePath: string) =>
  fs.existsSync(filePath)
    ? fs
        .readFileSync(filePath, "utf8")
        .split("\n")
        .filter((line) => line.length > 0)
    : [];

const withTempDir = <A, E, R>(use: (dir: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => fs.mkdtempSync(path.join(os.tmpdir(), "ryco-server-log-"))),
    use,
    (dir) => Effect.sync(() => fs.rmSync(dir, { recursive: true, force: true })),
  );

const fileLoggerLayer = (options: ServerLogFileLoggerOptions) =>
  Layer.mergeAll(
    Logger.layer([makeServerLogFileLogger(options)], { mergeWithExisting: false }),
    Layer.succeed(References.MinimumLogLevel, "Info"),
  );

describe("makeServerLogFileLogger", () => {
  it.live("writes one logfmt line per record and drains the batch when the scope closes", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const filePath = path.join(dir, "logs", "server.log");
        yield* Effect.gen(function* () {
          yield* Effect.logInfo("server started", { port: 3773 });
          yield* Effect.logWarning("refresh failed", Cause.fail(new Error("first\nsecond")));
        }).pipe(Effect.provide(fileLoggerLayer({ filePath, batchWindowMs: 60_000 })));

        const lines = readLines(filePath);
        assert.equal(lines.length, 2);
        assert.match(lines[0]!, /^timestamp=\S+ level=INFO fiber=#\d+ message="server started"/);
        assert.match(lines[1]!, /level=WARN .*message="refresh failed" cause=".*first\\nsecond/);
      }),
    ),
  );

  it.live("writes an error at once, together with the lines batched before it", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const filePath = path.join(dir, "server.log");
        yield* Effect.gen(function* () {
          yield* Effect.logInfo("batched line");
          yield* sleep(50);
          assert.deepEqual(readLines(filePath), []);

          yield* Effect.logError("backend failed");
          for (let attempt = 0; attempt < 300 && readLines(filePath).length < 2; attempt += 1) {
            yield* sleep(10);
          }
          // Still inside the scope: written by the error, not by the final drain.
          const lines = readLines(filePath);
          assert.equal(lines.length, 2);
          assert.match(lines[0]!, /level=INFO .*message="batched line"/);
          assert.match(lines[1]!, /level=ERROR .*message="backend failed"/);
        }).pipe(Effect.provide(fileLoggerLayer({ filePath, batchWindowMs: 60_000 })));
      }),
    ),
  );

  it.live("drops lines past the pending cap and writes how many it dropped", () =>
    withTempDir((dir) =>
      Effect.gen(function* () {
        const filePath = path.join(dir, "server.log");
        const padding = "x".repeat(100);
        yield* Effect.gen(function* () {
          for (let index = 0; index < 10; index += 1) {
            yield* Effect.logInfo(`line ${index} ${padding}`);
          }
        }).pipe(
          Effect.provide(
            fileLoggerLayer({ filePath, batchWindowMs: 60_000, maxPendingChars: 400 }),
          ),
        );

        const lines = readLines(filePath);
        assert.equal(lines.length, 3);
        assert.match(lines[0]!, /message="line 0 x+"/);
        assert.match(lines[1]!, /message="line 1 x+"/);
        assert.match(lines[2]!, /level=WARN message="server log dropped 8 lines/);
      }),
    ),
  );
});

const configLayer = (baseDir: string, mode: RuntimeMode) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return { ...config, mode, logLevel: "Info" as const };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

it.layer(NodeServices.layer)("ServerLoggerLive", (it) => {
  for (const [mode, writesFile] of [
    ["desktop", true],
    ["web", false],
  ] as const) {
    it.effect(`${writesFile ? "writes" : "does not write"} its own log in ${mode} mode`, () =>
      withTempDir((baseDir) =>
        Effect.gen(function* () {
          const config = yield* Effect.gen(function* () {
            yield* Effect.logInfo("probe line");
            return yield* ServerConfig;
          }).pipe(
            Effect.provide(ServerLoggerLive.pipe(Layer.provideMerge(configLayer(baseDir, mode)))),
          );
          assert.equal(path.basename(config.serverLogPath), "server.log");
          const lines = readLines(config.serverLogPath);
          assert.equal(lines.length, writesFile ? 1 : 0);
          if (writesFile) assert.include(lines[0], 'message="probe line"');
        }),
      ),
    );
  }
});
