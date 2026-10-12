/**
 * ProviderEventLoggers — single observability service that owns the two
 * shared NDJSON streams the provider runtime writes:
 *
 *   - `native`    — provider-protocol events as the SDK emits them, written
 *                   from inside each `<X>Adapter` factory.
 *   - `canonical` — runtime events after `ProviderService` has normalized
 *                   them onto `ProviderRuntimeEvent`.
 *
 * Why a service tag and not constructor options?
 *
 *   - Adapters are now constructed *inside* drivers (`<X>Driver.create()`),
 *     not at the boot Layer. There is no longer a single `make<X>AdapterLive(options)`
 *     call site where we can hand an `EventNdjsonLogger` in by hand.
 *   - Multiple driver instances per kind (`codex_personal`, `codex_work`)
 *     should share one underlying log writer per stream — opening N writers
 *     against the same rotating file would race the rotation logic. Owning
 *     the loggers on a single tag keeps that invariant intact.
 *   - Tests can swap one (or both) loggers with in-memory recorders by
 *     `Layer.succeed(ProviderEventLoggers, { native, canonical })` instead of
 *     juggling per-Layer option threading.
 *
 * Both fields are optional. `makeEventNdjsonLogger` returns `undefined` when
 * the target directory cannot be created; we forward that as `undefined`
 * rather than failing the boot Layer, matching the previous best-effort
 * behavior of `server.ts`. `RYCO_PROVIDER_EVENT_LOGS=off` also leaves both
 * undefined, so adapters skip building log records entirely.
 *
 * Detail level (`ServerSettings.providerEventLogs`, overridden by
 * `RYCO_PROVIDER_EVENT_LOGS`) is read on every write, so a settings change
 * applies without a restart. The layer also owns retention for the provider
 * and terminal log directories (age + total-size budget, at boot and hourly)
 * and drains both loggers when it is released, after the adapters that
 * write through it.
 *
 * @module provider/Layers/ProviderEventLoggers
 */
import path from "node:path";

import { ProviderEventLogMode } from "@ryco/contracts";
import { Config, Context, Duration, Effect, Layer, Option, Schedule, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { PROVIDER_EVENT_LOG_FILE_PATTERN } from "../providerEventLogRecords.ts";
import {
  DEFAULT_EVENT_LOG_RETENTION_MS,
  type EventNdjsonLogger,
  type LogDirectoryRetention,
  makeEventNdjsonLogger,
  sweepLogDirectory,
} from "./EventNdjsonLogger.ts";

export interface ProviderEventLoggersShape {
  readonly native: EventNdjsonLogger | undefined;
  readonly canonical: EventNdjsonLogger | undefined;
}

/**
 * Shared logger pair for native + canonical provider event streams.
 *
 * Service value is intentionally a struct of two optional loggers rather
 * than two parallel tags. Construction site is one place
 * (`ProviderEventLoggersLive`); consumers (drivers, `ProviderService`) read
 * one tag and pluck the field they need.
 */
export class ProviderEventLoggers extends Context.Service<
  ProviderEventLoggers,
  ProviderEventLoggersShape
>()("ryco/provider/ProviderEventLoggers") {}

/**
 * Constant value used by tests / boot layers that want to opt out of native
 * + canonical logging entirely. Keeps the tag non-optional in the type
 * system while letting the runtime treat absence as a no-op.
 */
export const NoOpProviderEventLoggers: ProviderEventLoggersShape = {
  native: undefined,
  canonical: undefined,
};

export const PROVIDER_EVENT_LOGS_ENV = "RYCO_PROVIDER_EVENT_LOGS";

/** Total size the provider log directory may reach before the oldest files go. */
export const PROVIDER_EVENT_LOG_BUDGET_BYTES = 512 * 1024 * 1024;
/**
 * Terminal scrollback is restored when a thread's terminal reopens, so it
 * ages out later than debug logs; the budget still bounds the directory.
 */
export const TERMINAL_LOG_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
export const TERMINAL_LOG_BUDGET_BYTES = 256 * 1024 * 1024;
const TERMINAL_LOG_FILE_PATTERN = /\.log$/;
const LOG_RETENTION_INTERVAL = Duration.hours(1);

/**
 * Effective detail level: the environment override, else the setting, else
 * the build default (`full` while developing, `lifecycle` when packaged).
 */
export function resolveProviderEventLogMode(input: {
  readonly envOverride: ProviderEventLogMode | undefined;
  readonly setting: ProviderEventLogMode | null;
  readonly development: boolean;
}): ProviderEventLogMode {
  return input.envOverride ?? input.setting ?? (input.development ? "full" : "lifecycle");
}

const readEnvOverride = Effect.gen(function* () {
  const value = yield* Config.schema(ProviderEventLogMode, PROVIDER_EVENT_LOGS_ENV).pipe(
    Config.option,
  );
  return Option.getOrUndefined(value);
}).pipe(
  Effect.catch((error) =>
    Effect.logWarning(`ignoring invalid ${PROVIDER_EVENT_LOGS_ENV}`, { error }).pipe(
      Effect.as(undefined),
    ),
  ),
);

/** Retention policy for each log directory this layer owns. */
export function logRetentionTargets(config: {
  readonly providerEventLogPath: string;
  readonly terminalLogsDir: string;
}): ReadonlyArray<{ readonly directory: string } & LogDirectoryRetention> {
  return [
    {
      directory: path.dirname(config.providerEventLogPath),
      maxAgeMs: DEFAULT_EVENT_LOG_RETENTION_MS,
      maxTotalBytes: PROVIDER_EVENT_LOG_BUDGET_BYTES,
      filePattern: PROVIDER_EVENT_LOG_FILE_PATTERN,
    },
    {
      directory: config.terminalLogsDir,
      maxAgeMs: TERMINAL_LOG_RETENTION_MS,
      maxTotalBytes: TERMINAL_LOG_BUDGET_BYTES,
      filePattern: TERMINAL_LOG_FILE_PATTERN,
    },
  ];
}

/**
 * Live Layer that builds both loggers from `ServerConfig.providerEventLogPath`.
 * If the directory create fails for either stream, the corresponding field
 * is `undefined` and writes from that stream become no-ops downstream.
 */
export const ProviderEventLoggersLive = Layer.effect(
  ProviderEventLoggers,
  Effect.gen(function* () {
    const config = yield* ServerConfig;
    const serverSettings = yield* ServerSettingsService;

    // Retention runs off the boot path: rotation only bounds per-thread size;
    // these sweeps reclaim quiet threads and cap each directory's total.
    yield* Effect.forEach(
      logRetentionTargets(config),
      ({ directory, ...retention }) => sweepLogDirectory(directory, retention),
      { discard: true },
    ).pipe(Effect.repeat(Schedule.spaced(LOG_RETENTION_INTERVAL)), Effect.forkScoped);

    const envOverride = yield* readEnvOverride;
    if (envOverride === "off") {
      return NoOpProviderEventLoggers;
    }
    const development = config.devUrl !== undefined;
    const initialSetting = yield* serverSettings.getSettings.pipe(
      Effect.map((settings) => settings.providerEventLogs),
      Effect.catch(() => Effect.succeed(null)),
    );
    let mode = resolveProviderEventLogMode({ envOverride, setting: initialSetting, development });
    if (envOverride === undefined) {
      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach((settings) =>
          Effect.sync(() => {
            mode = resolveProviderEventLogMode({
              envOverride,
              setting: settings.providerEventLogs,
              development,
            });
          }),
        ),
        Effect.forkScoped,
      );
    }

    const loggerOptions = {
      mode: () => mode,
      compressRotatedFiles: true,
    } as const;
    const native = yield* makeEventNdjsonLogger(config.providerEventLogPath, {
      ...loggerOptions,
      stream: "native",
    });
    const canonical = yield* makeEventNdjsonLogger(config.providerEventLogPath, {
      ...loggerOptions,
      stream: "canonical",
    });
    // Registered after the loggers exist, so it runs once every layer built on
    // top of this one (drivers, adapters, ProviderService) has been released.
    yield* Effect.addFinalizer(() =>
      Effect.all([native?.close() ?? Effect.void, canonical?.close() ?? Effect.void], {
        concurrency: "unbounded",
        discard: true,
      }),
    );
    return {
      native,
      canonical,
    } satisfies ProviderEventLoggersShape;
  }),
);
