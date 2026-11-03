/**
 * AnalyticsServiceLive - Opt-in anonymous PostHog telemetry layer.
 *
 * Off unless the operator sets both `RYCO_TELEMETRY_ENABLED=true` and a
 * `RYCO_POSTHOG_KEY`: Ryco ships no analytics key, so by default this is a
 * no-op that sends nothing and writes no install id. When enabled, it persists
 * a random installation-scoped anonymous id to the state dir, buffers events in
 * memory, and flushes batches to PostHog over Effect HttpClient.
 *
 * @module AnalyticsServiceLive
 */

import { Config, DateTime, Duration, Effect, Layer, Ref } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import { ServerConfig } from "../../config.ts";
import { AnalyticsService, type AnalyticsServiceShape } from "../Services/AnalyticsService.ts";
import { getTelemetryIdentifier } from "../Identify.ts";
import packageJson from "../../../package.json" with { type: "json" };

/**
 * Longest a shutdown waits for the final telemetry flush. Events still unsent
 * then are dropped: a slow or captive network must not hold up the process
 * exit (the desktop kills its backend 3 s after asking it to stop).
 */
export const ANALYTICS_SHUTDOWN_FLUSH_TIMEOUT = Duration.millis(300);

interface BufferedAnalyticsEvent {
  readonly event: string;
  readonly properties?: Readonly<Record<string, unknown>>;
  readonly capturedAt: string;
}

// Read first, on its own: until an operator opts in, nothing else is parsed.
const TelemetryOptInConfig = Config.all({
  // No default key: Ryco owns no analytics project, so nothing is sent unless
  // an operator configures one.
  posthogKey: Config.String("RYCO_POSTHOG_KEY").pipe(Config.withDefault("")),
  enabled: Config.Boolean("RYCO_TELEMETRY_ENABLED").pipe(Config.withDefault(false)),
});

const TelemetryDeliveryConfig = Config.all({
  posthogHost: Config.String("RYCO_POSTHOG_HOST").pipe(
    Config.withDefault("https://us.i.posthog.com"),
  ),
  flushBatchSize: Config.Number("RYCO_TELEMETRY_FLUSH_BATCH_SIZE").pipe(Config.withDefault(20)),
  flushIntervalMs: Config.Number("RYCO_TELEMETRY_FLUSH_INTERVAL_MS").pipe(Config.withDefault(1000)),
  maxBufferedEvents: Config.Number("RYCO_TELEMETRY_MAX_BUFFERED_EVENTS").pipe(
    Config.withDefault(1_000),
  ),
});

const atLeast = (value: number, minimum: number, fallback: number) =>
  Number.isFinite(value) ? Math.max(minimum, Math.floor(value)) : fallback;

// Telemetry is optional: a variable that cannot be parsed turns it off instead
// of failing the server's boot.
const readOrDisable = <A>(config: Config.Config<A>) =>
  config.pipe(
    Effect.catch((cause) =>
      Effect.logWarning("invalid telemetry configuration; telemetry stays off", { cause }).pipe(
        Effect.as(null),
      ),
    ),
  );

const makeAnalyticsService = Effect.gen(function* () {
  const optIn = yield* readOrDisable(TelemetryOptInConfig);
  const posthogKey = optIn?.posthogKey.trim() ?? "";
  if (optIn === null || !optIn.enabled || posthogKey.length === 0) {
    if (optIn?.enabled) {
      yield* Effect.logWarning(
        "RYCO_TELEMETRY_ENABLED is set but RYCO_POSTHOG_KEY is not; telemetry stays off",
      );
    }
    // No identifier, buffer, timer or finalizer: disabled telemetry does no work.
    return AnalyticsService.disabled;
  }

  const delivery = yield* readOrDisable(TelemetryDeliveryConfig);
  if (delivery === null) {
    return AnalyticsService.disabled;
  }
  const telemetryConfig = {
    posthogHost: delivery.posthogHost.trim().replace(/\/+$/, ""),
    flushBatchSize: atLeast(delivery.flushBatchSize, 1, 20),
    flushIntervalMs: atLeast(delivery.flushIntervalMs, 0, 1000),
    maxBufferedEvents: atLeast(delivery.maxBufferedEvents, 1, 1_000),
  };

  const identifier = yield* getTelemetryIdentifier(posthogKey);
  if (identifier === null) {
    return AnalyticsService.disabled;
  }

  const httpClient = yield* HttpClient.HttpClient;
  const serverConfig = yield* ServerConfig;
  const bufferRef = yield* Ref.make<ReadonlyArray<BufferedAnalyticsEvent>>([]);
  const clientType = serverConfig.mode === "desktop" ? "desktop-app" : "cli-web-client";
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);
  let flushTimeoutId: ReturnType<typeof setTimeout> | null = null;
  let flushRunning = false;

  const clearScheduledFlush = Effect.sync(() => {
    if (flushTimeoutId === null) {
      return;
    }

    clearTimeout(flushTimeoutId);
    flushTimeoutId = null;
  });

  const enqueueBufferedEvent = (event: string, properties?: Readonly<Record<string, unknown>>) =>
    Effect.flatMap(DateTime.now, (now) =>
      Ref.modify(bufferRef, (current) => {
        const appended = [
          ...current,
          {
            event,
            ...(properties ? { properties } : {}),
            capturedAt: DateTime.formatIso(now),
          } satisfies BufferedAnalyticsEvent,
        ];

        const next =
          appended.length > telemetryConfig.maxBufferedEvents
            ? appended.slice(appended.length - telemetryConfig.maxBufferedEvents)
            : appended;

        return [
          {
            size: next.length,
            dropped: next.length !== appended.length,
          } as const,
          next,
        ] as const;
      }),
    );

  const sendBatch = Effect.fn("sendBatch")(function* (
    events: ReadonlyArray<BufferedAnalyticsEvent>,
  ) {
    const payload = {
      api_key: posthogKey,
      batch: events.map((event) => ({
        event: event.event,
        distinct_id: identifier,
        properties: {
          ...event.properties,
          $process_person_profile: false,
          platform: process.platform,
          wsl: process.env.WSL_DISTRO_NAME,
          arch: process.arch,
          rycoVersion: packageJson.version,
          clientType,
        },
        timestamp: event.capturedAt,
      })),
    };

    yield* HttpClientRequest.post(`${telemetryConfig.posthogHost}/batch/`).pipe(
      HttpClientRequest.bodyJson(payload),
      Effect.flatMap(httpClient.execute),
      Effect.flatMap(HttpClientResponse.filterStatusOk),
    );
  });

  const scheduleFlush = Effect.sync(() => {
    if (flushTimeoutId !== null) {
      return;
    }

    flushTimeoutId = setTimeout(
      () => {
        flushTimeoutId = null;
        runFlushNow();
      },
      Math.max(0, telemetryConfig.flushIntervalMs),
    );
    flushTimeoutId.unref?.();
  });

  function scheduleFlushIfBuffered() {
    return Ref.get(bufferRef).pipe(
      Effect.flatMap((buffer) => (buffer.length > 0 ? scheduleFlush : Effect.void)),
    );
  }

  const flush: AnalyticsServiceShape["flush"] = Effect.gen(function* () {
    yield* clearScheduledFlush;

    while (true) {
      const batch = yield* Ref.modify(bufferRef, (current) => {
        if (current.length === 0) {
          return [[] as ReadonlyArray<BufferedAnalyticsEvent>, current] as const;
        }
        const nextBatch = current.slice(0, telemetryConfig.flushBatchSize);
        const remaining = current.slice(nextBatch.length);
        return [nextBatch, remaining] as const;
      });

      if (batch.length === 0) {
        return;
      }

      const sent = yield* sendBatch(batch).pipe(
        Effect.as(true),
        Effect.catch((cause) =>
          Ref.update(bufferRef, (current) => [...batch, ...current]).pipe(
            Effect.andThen(Effect.logDebug("Failed to flush telemetry", { cause })),
            Effect.as(false),
          ),
        ),
      );

      if (!sent) {
        yield* scheduleFlushIfBuffered();
        return;
      }
    }
  });

  function runFlushNow() {
    if (flushRunning) {
      return;
    }

    flushRunning = true;
    runFork(
      flush.pipe(
        Effect.ensuring(
          Effect.sync(() => {
            flushRunning = false;
          }),
        ),
      ),
    );
  }

  const record: AnalyticsServiceShape["record"] = Effect.fn("record")(
    function* (event, properties) {
      const enqueueResult = yield* enqueueBufferedEvent(event, properties);
      if (enqueueResult.dropped) {
        yield* Effect.logDebug("analytics buffer full; dropping oldest event", {
          size: enqueueResult.size,
          event,
        });
      }

      if (enqueueResult.size >= telemetryConfig.flushBatchSize) {
        yield* Effect.sync(() => {
          runFlushNow();
        });
        return;
      }

      yield* scheduleFlush;
    },
  );

  yield* Effect.addFinalizer(() =>
    clearScheduledFlush.pipe(
      Effect.andThen(flush),
      Effect.timeoutOption(ANALYTICS_SHUTDOWN_FLUSH_TIMEOUT),
      Effect.tap((flushed) =>
        flushed._tag === "None"
          ? Effect.logDebug("telemetry shutdown flush timed out; dropping unsent events")
          : Effect.void,
      ),
    ),
  );

  return {
    enabled: true,
    record,
    flush,
  } satisfies AnalyticsServiceShape;
});

export const AnalyticsServiceLayerLive = Layer.effect(AnalyticsService, makeAnalyticsService);
