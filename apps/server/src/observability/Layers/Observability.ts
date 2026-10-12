import { Config, Effect, Layer, References, Tracer } from "effect";
import { OtlpExporter, OtlpMetrics, OtlpSerialization, OtlpTracer } from "effect/observability";

import { ServerConfig } from "../../config.ts";
import { makeDiagnosticsService } from "../../diagnostics/Layers/Diagnostics.ts";
import { Diagnostics } from "../../diagnostics/Services/Diagnostics.ts";
import { ServerLoggerLive } from "../../serverLogger.ts";
import { HttpSpanHeadersLive } from "../HttpHeaderRedaction.ts";
import {
  DEFAULT_LOCAL_TRACE_SQL_MIN_DURATION_MS,
  makeLocalFileTracer,
} from "../LocalFileTracer.ts";
import { LocalDiagnosticsMetricsLive } from "../Services/LocalDiagnosticsMetrics.ts";
import { BrowserTraceCollector } from "../Services/BrowserTraceCollector.ts";
import { makeTraceSink, type TraceSink } from "../TraceSink.ts";

const otlpSerializationLayer = OtlpSerialization.layerJson;

/**
 * Fast SQL statements are left out of the local trace file by default; set
 * `RYCO_TRACE_SQL_MIN_DURATION_MS=0` to record every statement.
 */
const TraceSqlMinDurationConfig = Config.Int("RYCO_TRACE_SQL_MIN_DURATION_MS").pipe(
  Config.withDefault(DEFAULT_LOCAL_TRACE_SQL_MIN_DURATION_MS),
);

export const ObservabilityLive = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig;

    const traceReferencesLayer = Layer.mergeAll(
      Layer.succeed(Tracer.MinimumTraceLevel, config.traceMinLevel),
      Layer.succeed(References.TracerTimingEnabled, config.traceTimingEnabled),
      HttpSpanHeadersLive,
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
                exportInterval: `${config.otlpExportIntervalMs} millis`,
                resource: {
                  serviceName: config.otlpServiceName,
                  attributes: {
                    "service.runtime": "ryco-server",
                    "service.mode": config.mode,
                  },
                },
              });

        const tracer = yield* makeLocalFileTracer({
          filePath: config.serverTracePath,
          maxBytes: config.traceMaxBytes,
          maxFiles: config.traceMaxFiles,
          batchWindowMs: config.traceBatchWindowMs,
          sqlSpanMinDurationMs: yield* TraceSqlMinDurationConfig,
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
    ).pipe(Layer.provideMerge(otlpSerializationLayer), Layer.provide(OtlpExporter.layerFlusher));

    const metricsLayer =
      config.otlpMetricsUrl === undefined
        ? Layer.empty
        : OtlpMetrics.layer({
            url: config.otlpMetricsUrl,
            exportInterval: `${config.otlpExportIntervalMs} millis`,
            resource: {
              serviceName: config.otlpServiceName,
              attributes: {
                "service.runtime": "ryco-server",
                "service.mode": config.mode,
              },
            },
          }).pipe(Layer.provideMerge(otlpSerializationLayer));

    return Layer.mergeAll(
      ServerLoggerLive,
      traceReferencesLayer,
      tracerLayer,
      metricsLayer,
      LocalDiagnosticsMetricsLive,
    );
  }),
);
