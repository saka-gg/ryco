import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect, FileSystem, Layer } from "effect";
import * as Crypto from "node:crypto";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";

import { ServerConfig } from "../../config.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import { AnalyticsService } from "../Services/AnalyticsService.ts";
import { AnalyticsServiceLayerLive } from "./AnalyticsService.ts";

interface RecordedBatchRequest {
  readonly path: string;
  readonly body: {
    readonly batch?: ReadonlyArray<{
      readonly event?: string;
      readonly distinct_id?: string;
      readonly properties?: {
        readonly index?: number;
        readonly clientType?: string;
      };
    }>;
  } | null;
}

interface RecordedBatchBody {
  readonly batch: ReadonlyArray<{
    readonly event?: string;
    readonly distinct_id?: string;
    readonly properties?: {
      readonly index?: number;
      readonly clientType?: string;
    };
  }>;
}

function waitFor(predicate: () => boolean, timeoutMs = 1_000): Effect.Effect<void> {
  return Effect.promise(
    () =>
      new Promise<void>((resolve, reject) => {
        const deadline = Date.now() + timeoutMs;
        const poll = () => {
          if (predicate()) {
            resolve();
            return;
          }
          if (Date.now() >= deadline) {
            reject(new Error("Timed out waiting for expectation."));
            return;
          }
          setTimeout(poll, 10);
        };
        poll();
      }),
  );
}

function captureBatchRequests(capturedRequests: Array<RecordedBatchRequest>) {
  return HttpServer.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const payload = yield* request.json.pipe(
        Effect.map((body) => body as RecordedBatchRequest["body"]),
        Effect.catch(() => Effect.succeed(null)),
      );
      capturedRequests.push({ path: request.url, body: payload });
      return HttpServerResponse.jsonUnsafe({});
    }),
  );
}

it.layer(NodeServices.layer)("AnalyticsService test", (it) => {
  const offConfigurations: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    // The host points at the capture server in every case, so a regression
    // that sends anyway is recorded here instead of reaching PostHog.
    ["neither a key nor the flag is set", { RYCO_POSTHOG_HOST: "" }],
    ["telemetry is enabled without a key", { RYCO_TELEMETRY_ENABLED: true, RYCO_POSTHOG_HOST: "" }],
    [
      "a key is configured without enabling telemetry",
      { RYCO_POSTHOG_KEY: "phc_test_key", RYCO_POSTHOG_HOST: "" },
    ],
    [
      "the key is blank",
      { RYCO_TELEMETRY_ENABLED: true, RYCO_POSTHOG_KEY: "  ", RYCO_POSTHOG_HOST: "" },
    ],
    // Invalid values turn telemetry off rather than failing the server's boot.
    [
      "the flag is malformed",
      {
        RYCO_TELEMETRY_ENABLED: "sometimes",
        RYCO_POSTHOG_KEY: "phc_test_key",
        RYCO_POSTHOG_HOST: "",
      },
    ],
    [
      "a delivery setting is malformed",
      {
        RYCO_TELEMETRY_ENABLED: true,
        RYCO_POSTHOG_KEY: "phc_test_key",
        RYCO_POSTHOG_HOST: "",
        RYCO_TELEMETRY_FLUSH_BATCH_SIZE: "many",
      },
    ],
  ];

  for (const [label, env] of offConfigurations) {
    it.effect(`sends nothing and writes no install id when ${label}`, () =>
      Effect.gen(function* () {
        const capturedRequests: Array<RecordedBatchRequest> = [];
        const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
          prefix: "ryco-telemetry-off-",
        });
        const runtimeLayer = AnalyticsServiceLayerLive.pipe(
          Layer.provideMerge(serverConfigLayer),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown(env))),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        const anonymousIdExists = yield* Effect.gen(function* () {
          yield* Layer.launch(captureBatchRequests(capturedRequests)).pipe(Effect.forkScoped);
          const analytics = yield* AnalyticsService;
          for (let index = 0; index < 25; index += 1) {
            yield* analytics.record("test.telemetry.off", { index });
          }
          yield* analytics.flush;

          const { anonymousIdPath } = yield* ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          return yield* fileSystem.exists(anonymousIdPath);
        }).pipe(Effect.provide(runtimeLayer));

        assert.equal(capturedRequests.length, 0);
        assert.equal(anonymousIdExists, false);
      }),
    );
  }

  it.effect("identifies events only by the hashed random install id", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "ryco-telemetry-identity-",
      });
      const runtimeLayer = AnalyticsServiceLayerLive.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              RYCO_TELEMETRY_ENABLED: true,
              RYCO_POSTHOG_KEY: "phc_test_key",
              RYCO_POSTHOG_HOST: "",
            }),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      const installId = yield* Effect.gen(function* () {
        yield* Layer.launch(captureBatchRequests(capturedRequests)).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService;
        yield* analytics.record("test.telemetry.identity");
        yield* analytics.flush;

        const { anonymousIdPath } = yield* ServerConfig;
        const fileSystem = yield* FileSystem.FileSystem;
        return yield* fileSystem.readFileString(anonymousIdPath);
      }).pipe(Effect.provide(runtimeLayer));

      const expected = Crypto.createHash("sha256")
        .update(`phc_test_key\n${installId.trim()}`)
        .digest("hex");
      const distinctIds = capturedRequests.flatMap(
        (request) => request.body?.batch?.map((event) => event.distinct_id) ?? [],
      );
      assert.deepEqual(distinctIds, [expected]);
    }),
  );

  // A write-only id file: reading fails with EACCES while an overwrite would
  // succeed. Root ignores the mode and Windows has no such mode.
  it.effect.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "sends nothing and keeps the stored id when the install id cannot be read",
    () =>
      Effect.gen(function* () {
        const capturedRequests: Array<RecordedBatchRequest> = [];
        const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
          prefix: "ryco-telemetry-unreadable-id-",
        });
        const unreadableIdLayer = Layer.effectDiscard(
          Effect.gen(function* () {
            const { anonymousIdPath } = yield* ServerConfig;
            const fileSystem = yield* FileSystem.FileSystem;
            yield* fileSystem.writeFileString(anonymousIdPath, "existing-install-id");
            yield* fileSystem.chmod(anonymousIdPath, 0o200);
          }),
        ).pipe(Layer.provideMerge(serverConfigLayer));
        const runtimeLayer = AnalyticsServiceLayerLive.pipe(
          Layer.provideMerge(unreadableIdLayer),
          Layer.provide(
            ConfigProvider.layer(
              ConfigProvider.fromUnknown({
                RYCO_TELEMETRY_ENABLED: true,
                RYCO_POSTHOG_KEY: "phc_test_key",
                RYCO_POSTHOG_HOST: "",
              }),
            ),
          ),
          Layer.provideMerge(NodeHttpServer.layerTest),
        );

        const { enabled, storedId } = yield* Effect.gen(function* () {
          yield* Layer.launch(captureBatchRequests(capturedRequests)).pipe(Effect.forkScoped);
          const analytics = yield* AnalyticsService;
          yield* analytics.record("test.telemetry.unreadable-id");
          yield* analytics.flush;

          const { anonymousIdPath } = yield* ServerConfig;
          const fileSystem = yield* FileSystem.FileSystem;
          yield* fileSystem.chmod(anonymousIdPath, 0o600);
          return {
            enabled: analytics.enabled,
            storedId: yield* fileSystem.readFileString(anonymousIdPath),
          };
        }).pipe(Effect.provide(runtimeLayer));

        assert.equal(enabled, false);
        assert.equal(storedId, "existing-install-id");
        assert.equal(capturedRequests.length, 0);
      }),
  );

  it.effect("still delivers when the batch size is configured below one", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "ryco-telemetry-batch-size-",
      });
      const runtimeLayer = AnalyticsServiceLayerLive.pipe(
        Layer.provideMerge(serverConfigLayer),
        Layer.provide(
          ConfigProvider.layer(
            ConfigProvider.fromUnknown({
              RYCO_TELEMETRY_ENABLED: true,
              RYCO_POSTHOG_KEY: "phc_test_key",
              RYCO_POSTHOG_HOST: "",
              RYCO_TELEMETRY_FLUSH_BATCH_SIZE: 0,
              RYCO_TELEMETRY_FLUSH_INTERVAL_MS: 60_000,
            }),
          ),
        ),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(captureBatchRequests(capturedRequests)).pipe(Effect.forkScoped);
        const analytics = yield* AnalyticsService;
        for (let index = 0; index < 3; index += 1) {
          yield* analytics.record("test.telemetry.batch-size", { index });
        }
        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const delivered = capturedRequests.flatMap((request) => request.body?.batch ?? []);
      assert.equal(delivered.length, 3);
    }),
  );

  it.effect("flush drains all buffered events across multiple batches", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "ryco-telemetry-base-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          RYCO_TELEMETRY_ENABLED: true,
          RYCO_POSTHOG_KEY: "phc_test_key",
          RYCO_POSTHOG_HOST: "",
          RYCO_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier("phc_test_key");
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService;

        for (let index = 0; index < 45; index += 1) {
          yield* analytics.record("test.flush.drain", { index });
        }

        yield* analytics.flush;
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 3);
      assert.equal(
        batchRequests.every((request) => request.path.endsWith("/batch/")),
        true,
      );
      const deliveredIndexes = batchRequests.flatMap((request) =>
        request.body.batch
          .filter((event) => event.event === "test.flush.drain")
          .map((event) => event.properties?.index)
          .filter((index): index is number => typeof index === "number"),
      );

      const sorted = deliveredIndexes.toSorted((a, b) => a - b);
      assert.equal(sorted.length, 45);
      assert.deepEqual(
        sorted,
        Array.from({ length: 45 }, (_, index) => index),
      );
      assert.equal(
        batchRequests.every((request) =>
          request.body.batch.every((event) => event.properties?.clientType === "cli-web-client"),
        ),
        true,
      );
    }),
  );

  it.effect("flushes buffered events after the scheduled flush interval", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "ryco-telemetry-scheduled-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          RYCO_TELEMETRY_ENABLED: true,
          RYCO_POSTHOG_KEY: "phc_test_key",
          RYCO_POSTHOG_HOST: "",
          RYCO_TELEMETRY_FLUSH_BATCH_SIZE: 20,
          RYCO_TELEMETRY_FLUSH_INTERVAL_MS: 10,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );

          capturedRequests.push({ path: request.url, body: payload });

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier("phc_test_key");
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService;

        yield* analytics.record("test.flush.scheduled", { index: 1 });
        yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 80)));
      }).pipe(Effect.provide(runtimeLayer));

      const batchRequests = capturedRequests.filter(
        (request): request is RecordedBatchRequest & { readonly body: RecordedBatchBody } =>
          Array.isArray(request.body?.batch),
      );
      assert.equal(batchRequests.length, 1);
      assert.equal(batchRequests[0]?.body.batch[0]?.event, "test.flush.scheduled");
    }),
  );

  it.effect("keeps background flushes single-flight during bursts", () =>
    Effect.gen(function* () {
      const capturedRequests: Array<RecordedBatchRequest> = [];
      let activeRequests = 0;
      let maxActiveRequests = 0;
      const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
        prefix: "ryco-telemetry-single-flight-",
      });

      const telemetryLayer = AnalyticsServiceLayerLive.pipe(Layer.provideMerge(serverConfigLayer));
      const configLayer = ConfigProvider.layer(
        ConfigProvider.fromUnknown({
          RYCO_TELEMETRY_ENABLED: true,
          RYCO_POSTHOG_KEY: "phc_test_key",
          RYCO_POSTHOG_HOST: "",
          RYCO_TELEMETRY_FLUSH_BATCH_SIZE: 1,
          RYCO_TELEMETRY_FLUSH_INTERVAL_MS: 1,
        }),
      );
      const batchServerLayer = HttpServer.serve(
        Effect.gen(function* () {
          activeRequests += 1;
          maxActiveRequests = Math.max(maxActiveRequests, activeRequests);
          const request = yield* HttpServerRequest.HttpServerRequest;
          if (request.method !== "POST") {
            activeRequests -= 1;
            return HttpServerResponse.empty({ status: 404 });
          }

          const payload = yield* request.json.pipe(
            Effect.map((body) => body as RecordedBatchRequest["body"]),
            Effect.catch(() => Effect.succeed(null)),
          );

          yield* Effect.promise(() => new Promise((resolve) => setTimeout(resolve, 20)));
          capturedRequests.push({ path: request.url, body: payload });
          activeRequests -= 1;

          return HttpServerResponse.jsonUnsafe({});
        }),
      );
      const runtimeLayer = telemetryLayer.pipe(
        Layer.provide(configLayer),
        Layer.provideMerge(NodeHttpServer.layerTest),
      );

      yield* Effect.gen(function* () {
        yield* Layer.launch(batchServerLayer).pipe(Effect.forkScoped);
        const telemetryIdentifier = yield* getTelemetryIdentifier("phc_test_key");
        assert.equal(telemetryIdentifier !== null, true);
        const analytics = yield* AnalyticsService;

        for (let index = 0; index < 5; index += 1) {
          yield* analytics.record("test.flush.single-flight", { index });
        }

        yield* waitFor(() => capturedRequests.length === 5);
      }).pipe(Effect.provide(runtimeLayer));

      assert.equal(maxActiveRequests, 1);
    }),
  );
});

// Live clock: the shutdown bound is a real timeout.
it.live("bounds the shutdown flush when the telemetry host is slow", () =>
  Effect.gen(function* () {
    let requests = 0;
    const serverConfigLayer = ServerConfig.layerTest(process.cwd(), {
      prefix: "ryco-telemetry-shutdown-",
    });
    const configLayer = ConfigProvider.layer(
      ConfigProvider.fromUnknown({
        RYCO_TELEMETRY_ENABLED: true,
        RYCO_POSTHOG_KEY: "phc_test_key",
        RYCO_POSTHOG_HOST: "",
        RYCO_TELEMETRY_FLUSH_BATCH_SIZE: 20,
        RYCO_TELEMETRY_FLUSH_INTERVAL_MS: 60_000,
      }),
    );
    // A host that never answers. Request handlers run uninterruptibly, so the
    // wait opts back in: otherwise the test's teardown would wait for it.
    yield* Layer.launch(
      HttpServer.serve(
        Effect.gen(function* () {
          requests += 1;
          return yield* Effect.interruptible(Effect.never);
        }),
      ),
    ).pipe(Effect.forkScoped);

    const startedAt = Date.now();
    yield* Effect.gen(function* () {
      const analytics = yield* AnalyticsService;
      yield* analytics.record("test.flush.shutdown", { index: 0 });
    }).pipe(
      Effect.provide(
        AnalyticsServiceLayerLive.pipe(
          Layer.provideMerge(serverConfigLayer),
          Layer.provide(configLayer),
        ),
      ),
    );
    const shutdownMs = Date.now() - startedAt;

    assert.equal(requests, 1);
    assert.isBelow(shutdownMs, 2_000);
  }).pipe(Effect.provide(Layer.merge(NodeHttpServer.layerTest, NodeServices.layer))),
);
