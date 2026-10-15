import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings, ThreadId } from "@ryco/contracts";
import { AsyncRotatingFileSink } from "@ryco/shared/logging";
import { assert, describe, it, vi } from "@effect/vitest";
import {
  ConfigProvider,
  Context,
  Effect,
  Exit,
  Layer,
  Option,
  PubSub,
  Queue,
  Ref,
  Scope,
  Semaphore,
  Stream,
} from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService, type ServerSettingsShape } from "../../serverSettings.ts";
import {
  NoOpProviderEventLoggers,
  PROVIDER_EVENT_LOGS_ENV,
  ProviderEventLoggers,
  ProviderEventLoggersLive,
  resolveProviderEventLogMode,
} from "./ProviderEventLoggers.ts";

const sleep = (ms: number) =>
  Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));

/**
 * Settings double whose changes stream replays the latest published value.
 * `publish` returns once the subscriber has handled the value: the stream
 * signals when it is asked for the next one.
 */
const makeSettingsLayer = (initial: Partial<ServerSettings>) => {
  const changes = Effect.runSync(PubSub.unbounded<ServerSettings>({ replay: 1 }));
  const handled = Effect.runSync(Queue.unbounded<ServerSettings>());
  const layer = Layer.effect(
    ServerSettingsService,
    Effect.gen(function* () {
      const current = yield* Ref.make<ServerSettings>({ ...DEFAULT_SERVER_SETTINGS, ...initial });
      const semaphore = yield* Semaphore.make(1);
      return {
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(current),
        withSettingsSnapshot: semaphore.withPermits(1),
        updateSettings: () => Ref.get(current),
        streamChanges: Stream.fromPubSub(changes).pipe(
          Stream.flatMap((settings) =>
            Stream.concat(
              Stream.make(settings),
              Stream.fromEffect(Queue.offer(handled, settings)).pipe(Stream.drain),
            ),
          ),
        ),
      } satisfies ServerSettingsShape;
    }),
  );
  const publish = (settings: Partial<ServerSettings>) =>
    PubSub.publish(changes, { ...DEFAULT_SERVER_SETTINGS, ...settings }).pipe(
      Effect.andThen(Queue.take(handled)),
      Effect.timeout("5 seconds"),
    );
  return { layer, publish };
};

const buildLoggers = (input: {
  readonly baseDir: string;
  readonly settings: Layer.Layer<ServerSettingsService>;
  readonly env?: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    const context = yield* Layer.buildWithScope(
      ProviderEventLoggersLive.pipe(
        Layer.provide(input.settings),
        Layer.provideMerge(ServerConfig.layerTest(process.cwd(), input.baseDir)),
        Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnvRecord(input.env ?? {}))),
      ),
      scope,
    );
    return {
      scope,
      loggers: Context.get(context, ProviderEventLoggers),
      config: Context.get(context, ServerConfig),
    };
  });

const readLines = (filePath: string) =>
  fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8").trim().split("\n") : [];

describe("resolveProviderEventLogMode", () => {
  it("prefers the environment, then the setting, then the build default", () => {
    assert.equal(
      resolveProviderEventLogMode({ envOverride: "off", setting: "full", development: true }),
      "off",
    );
    assert.equal(
      resolveProviderEventLogMode({ envOverride: undefined, setting: "off", development: true }),
      "off",
    );
    assert.equal(
      resolveProviderEventLogMode({ envOverride: undefined, setting: null, development: true }),
      "full",
    );
    assert.equal(
      resolveProviderEventLogMode({ envOverride: undefined, setting: null, development: false }),
      "lifecycle",
    );
  });
});

describe("ProviderEventLoggersLive shutdown", () => {
  it.live("bounds the shutdown drain when a log file never finishes closing", () =>
    Effect.gen(function* () {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-loggers-"));
      // Every sink close hangs until the end of the test, like a wedged fs write.
      let release!: () => void;
      const wedged = new Promise<void>((resolve) => {
        release = resolve;
      });
      const originalClose = AsyncRotatingFileSink.prototype.close;
      const close = vi.spyOn(AsyncRotatingFileSink.prototype, "close").mockImplementation(function (
        this: AsyncRotatingFileSink,
      ) {
        return wedged.then(() => originalClose.call(this));
      });
      try {
        const settings = makeSettingsLayer({ providerEventLogs: "full" });
        const { scope, loggers } = yield* buildLoggers({ baseDir, settings: settings.layer });
        yield* loggers.native!.write(
          { kind: "session", method: "thread/started" },
          ThreadId.make("thread-wedged"),
        );
        const startedAt = Date.now();
        const closed = yield* Scope.close(scope, Exit.void).pipe(
          Effect.timeoutOption("10 seconds"),
        );
        assert.isTrue(Option.isSome(closed), "scope close did not finish");
        assert.isAtLeast(close.mock.calls.length, 1);
        assert.isBelow(Date.now() - startedAt, 5_000);
      } finally {
        close.mockRestore();
        // Let the abandoned closes finish so no file handle outlives the test.
        release();
        yield* sleep(50);
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

it.layer(NodeServices.layer)("ProviderEventLoggersLive", (it) => {
  it.effect("drains both loggers when the layer is released", () =>
    Effect.gen(function* () {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-loggers-"));
      try {
        const settings = makeSettingsLayer({ providerEventLogs: "full" });
        const { scope, loggers, config } = yield* buildLoggers({
          baseDir,
          settings: settings.layer,
        });
        const threadId = ThreadId.make("thread-drain");
        yield* loggers.native!.write({ kind: "session", method: "thread/started" }, threadId);
        yield* loggers.canonical!.write({ type: "turn.completed" }, threadId);
        // Still inside the 200 ms batch window: only the finalizer can flush these.
        yield* Scope.close(scope, Exit.void);

        assert.equal(readLines(path.join(config.providerLogsDir, "thread-drain.log")).length, 1);
        assert.equal(
          readLines(path.join(config.providerLogsDir, "thread-drain.native.log")).length,
          1,
        );
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("follows the providerEventLogs setting without a restart", () =>
    Effect.gen(function* () {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-loggers-"));
      try {
        const settings = makeSettingsLayer({ providerEventLogs: "off" });
        const { scope, loggers, config } = yield* buildLoggers({
          baseDir,
          settings: settings.layer,
        });
        const threadId = ThreadId.make("thread-toggle");
        const filePath = path.join(config.providerLogsDir, "thread-toggle.log");

        yield* loggers.canonical!.write({ type: "turn.started", id: "while-off" }, threadId);
        // Returns once the layer's settings subscription has applied it.
        yield* settings.publish({ providerEventLogs: "lifecycle" });
        yield* loggers.canonical!.write({ type: "turn.started", id: "after-toggle" }, threadId);
        yield* loggers.canonical!.write(
          { type: "content.delta", payload: { delta: "x" } },
          threadId,
        );
        yield* Scope.close(scope, Exit.void);

        const lines = readLines(filePath);
        assert.equal(lines.length, 1);
        assert.include(lines[0], "after-toggle");
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(`provides no loggers when ${PROVIDER_EVENT_LOGS_ENV}=off`, () =>
    Effect.gen(function* () {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-loggers-"));
      try {
        const settings = makeSettingsLayer({ providerEventLogs: "full" });
        const { scope, loggers } = yield* buildLoggers({
          baseDir,
          settings: settings.layer,
          env: { [PROVIDER_EVENT_LOGS_ENV]: "off" },
        });
        assert.deepEqual(loggers, NoOpProviderEventLoggers);
        yield* Scope.close(scope, Exit.void);
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect(`ignores an invalid ${PROVIDER_EVENT_LOGS_ENV} and follows the setting`, () =>
    Effect.gen(function* () {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-loggers-"));
      try {
        const settings = makeSettingsLayer({ providerEventLogs: "lifecycle" });
        const { scope, loggers, config } = yield* buildLoggers({
          baseDir,
          settings: settings.layer,
          env: { [PROVIDER_EVENT_LOGS_ENV]: "verbose" },
        });
        const threadId = ThreadId.make("thread-invalid-env");
        yield* loggers.canonical!.write({ type: "task.progress", id: "progress" }, threadId);
        yield* loggers.canonical!.write({ type: "turn.started", id: "turn" }, threadId);
        yield* Scope.close(scope, Exit.void);

        const lines = readLines(path.join(config.providerLogsDir, "thread-invalid-env.log"));
        assert.equal(lines.length, 1);
        assert.include(lines[0], '"id":"turn"');
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );

  it.effect("sweeps expired provider and terminal logs at boot", () =>
    Effect.gen(function* () {
      const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-provider-loggers-"));
      try {
        const providerDir = path.join(baseDir, "userdata", "logs", "provider");
        const terminalDir = path.join(baseDir, "userdata", "logs", "terminals");
        fs.mkdirSync(providerDir, { recursive: true });
        fs.mkdirSync(terminalDir, { recursive: true });
        const expired = new Date(Date.now() - 120 * 24 * 60 * 60 * 1000);
        const staleProvider = path.join(providerDir, "old-thread.log.1.gz");
        const staleTerminal = path.join(terminalDir, "old-thread_default.log");
        const freshTerminal = path.join(terminalDir, "new-thread_default.log");
        for (const filePath of [staleProvider, staleTerminal, freshTerminal]) {
          fs.writeFileSync(filePath, "x");
        }
        fs.utimesSync(staleProvider, expired, expired);
        fs.utimesSync(staleTerminal, expired, expired);

        const settings = makeSettingsLayer({});
        const { scope } = yield* buildLoggers({ baseDir, settings: settings.layer });
        for (let attempt = 0; attempt < 100; attempt += 1) {
          if (!fs.existsSync(staleProvider) && !fs.existsSync(staleTerminal)) break;
          yield* sleep(10);
        }
        yield* Scope.close(scope, Exit.void);

        assert.isFalse(fs.existsSync(staleProvider));
        assert.isFalse(fs.existsSync(staleTerminal));
        assert.isTrue(fs.existsSync(freshTerminal));
      } finally {
        fs.rmSync(baseDir, { recursive: true, force: true });
      }
    }),
  );
});
