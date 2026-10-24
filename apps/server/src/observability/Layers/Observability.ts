import { redactUrlCredentials } from "@ryco/shared/settingsSecrets";
import { Config, Effect, Layer, References, Tracer } from "effect";
import { Headers } from "effect/http";
import { OtlpExporter, OtlpMetrics, OtlpTracer } from "effect/observability";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { makeDiagnosticsService } from "../../diagnostics/Layers/Diagnostics.ts";
import { Diagnostics } from "../../diagnostics/Services/Diagnostics.ts";
import { ServerLoggerLive } from "../../serverLogger.ts";
import { HttpSpanHeadersLive } from "../HttpHeaderRedaction.ts";
import {
  DEFAULT_LOCAL_TRACE_SPAN_MIN_DURATION_MS,
  DEFAULT_LOCAL_TRACE_SQL_MIN_DURATION_MS,
  makeLocalFileTracer,
} from "../LocalFileTracer.ts";
import { LocalDiagnosticsMetricsLive } from "../Services/LocalDiagnosticsMetrics.ts";
import { BrowserTraceCollector } from "../Services/BrowserTraceCollector.ts";
import {
  OTLP_SIGNALS,
  otlpExporterContext,
  otlpExporterOptions,
  otlpRedactedHeaderNames,
} from "../OtelEnvironment.ts";
import { makeTraceSink, type TraceSink } from "../TraceSink.ts";

/**
 * Fast SQL statements are left out of the local trace file by default; set
 * `RYCO_TRACE_SQL_MIN_DURATION_MS=0` to record every statement.
 */
const TraceSqlMinDurationConfig = Config.Int("RYCO_TRACE_SQL_MIN_DURATION_MS").pipe(
  Config.withDefault(DEFAULT_LOCAL_TRACE_SQL_MIN_DURATION_MS),
);

/**
 * Short successful child spans are left out of the local trace file by default; set
 * `RYCO_TRACE_SPAN_MIN_DURATION_MS=0` to record every span.
 */
const TraceSpanMinDurationConfig = Config.Int("RYCO_TRACE_SPAN_MIN_DURATION_MS").pipe(
  Config.withDefault(DEFAULT_LOCAL_TRACE_SPAN_MIN_DURATION_MS),
);

const OTLP_SIGNAL_URLS = {
  traces: "otlpTracesUrl",
  metrics: "otlpMetricsUrl",
  logs: "otlpLogsUrl",
} as const;

/**
 * One line per exported signal, naming where it goes (credentials and query values redacted) and,
 * for an endpoint taken from the OTEL variables, which variable and protocol; then every warning
 * about OTEL settings that were ignored or turned an export off.
 */
const logObservabilityStartup = (config: ServerConfigShape) =>
  Effect.gen(function* () {
    for (const signal of OTLP_SIGNALS) {
      const url = config[OTLP_SIGNAL_URLS[signal]];
      if (url === undefined) continue;
      const otel = config.otlpExports?.[signal];
      yield* Effect.logInfo(
        `Exporting ${signal} over OTLP to ${redactUrlCredentials(url)}${
          otel === undefined ? "" : ` (${otel.protocol}, from ${otel.endpointVariable})`
        }`,
      );
    }
    for (const warning of config.observabilityWarnings ?? []) {
      yield* Effect.logWarning(warning);
    }
  });

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    // OTEL header values never reach spans or logs: every configured header name is redacted
    // wherever Effect prints headers (span attributes, a failed request in a log).
    const redactedHeaderNamesLayer = Layer.succeed(
      Headers.CurrentRedactedNames,
      yield* otlpRedactedHeaderNames(config),
    );
    const traceReferencesLayer = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
      HttpSpanHeadersLive,
      redactedHeaderNamesLayer,
    );

    const tracerLayer = Layer.unwrap(
      Effect.gen(function* () {
        const sink = yield* makeTraceSink({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
        });
        const diagnostics = yield* makeDiagnosticsService(config, {
          traceSinkHealth: sink.health,
        });
        const diagnosticsSink = {
          filePath: sink.filePath,
          push(record) {
            sink.push(record);
            diagnostics.recordTraceRecords([record]);
          },
          flush: sink.flush,
          close: sink.close,
          health: sink.health,
        } satisfies TraceSink;
        const delegate =
          config.otlpTracesUrl === undefined
            ? undefined
            : yield* OtlpTracer.make({
                url: config.otlpTracesUrl,
                ...otlpExporterOptions(config, "traces"),
              }).pipe(Effect.provide(otlpExporterContext(config, "traces")));

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sqlSpanMinDurationMs: yield* TraceSqlMinDurationConfig,
          spanMinDurationMs: yield* TraceSpanMinDurationConfig,
          sink: diagnosticsSink,
          ...(delegate ? { delegate } : {}),
        });

        return Layer.mergeAll(
          Layer.succeed(Diagnostics, diagnostics),
          Layer.succeed(Tracer.Tracer, tracer),
          Layer.succeed(BrowserTraceCollector, {
            record: (records) =>
              Effect.sync(() => {
                for (const record of records) {
                  diagnosticsSink.push(record);
                }
              }),
          }),
        );
      }),
    ).pipe(Layer.provide([OtlpExporter.layerFlusher, redactedHeaderNamesLayer]));

    const metricsLayer =
      config.otlpMetricsUrl === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: config.otlpMetricsUrl,
            ...otlpExporterOptions(config, "metrics"),
          }).pipe(Layer.provide(otlpExporterContext(config, "metrics")));

    // After the server logger exists, so these lines reach the server log and an OTLP log export.
    const startupLogLayer = Layer.effectDiscard(logObservabilityStartup(config)).pipe(
      Layer.provide(ServerLoggerLive),
    );

    return Layer.mergeAll(
      ServerLoggerLive,
      traceReferencesLayer,
      tracerLayer,
      metricsLayer,
      LocalDiagnosticsMetricsLive,
      startupLogLayer,
    );
  }),
);
