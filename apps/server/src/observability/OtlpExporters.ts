/**
 * Ryco's OTLP exporters (traces, metrics, logs) and the context each is built in.
 *
 * Loaded through `loadOtlpExporters` only for a signal that is exported, so a server that exports
 * nothing never evaluates Effect's OTLP exporters or their protobuf encoder
 * (serverBundleBoundaries.test.ts). Never import this module statically from the server graph.
 *
 * @module observability/OtlpExporters
 */
import { ConfigProvider, Data, Effect, Layer, Redacted } from "effect";
import { Headers } from "effect/http";
import {
  OtlpExporter,
  OtlpLogger,
  OtlpMetrics,
  OtlpSerialization,
  OtlpTracer,
} from "effect/observability";

import type { ServerConfigShape } from "../config.ts";
import { otlpRedactedHeaderNames, type OtlpSignal } from "./OtelEnvironment.ts";

/**
 * Effect's OTLP exporters read `OTEL_RESOURCE_ATTRIBUTES`, `OTEL_SERVICE_NAME` and
 * `OTEL_SERVICE_VERSION` from the ConfigProvider themselves, and die on a value that does not
 * decode (`a=%zz` stopped a server with an OTLP URL from starting). Ryco hands them the validated
 * attributes in `resource.attributes` and builds them under an empty provider, so the raw
 * environment never reaches them. A fallback chain is not enough: the active provider is consulted
 * whenever the added one has no value.
 */
const emptyConfigProvider = ConfigProvider.fromEnv({ env: {} });

type OtlpExportConfig = Pick<
  ServerConfigShape,
  "otlpServiceName" | "otlpExportIntervalMs" | "mode" | "otlpExports" | "otlpResourceAttributes"
>;

/** Resource, headers and interval for one signal's Effect OTLP exporter. */
export function otlpExporterOptions(config: OtlpExportConfig, signal: OtlpSignal) {
  const headers = config.otlpExports?.[signal]?.headers;
  return {
    exportInterval: `${config.otlpExportIntervalMs} millis`,
    resource: {
      serviceName: config.otlpServiceName,
      attributes: {
        ...config.otlpResourceAttributes,
        "service.runtime": "ryco-server",
        "service.mode": config.mode,
      },
    },
    ...(headers !== undefined ? { headers: { ...Redacted.value(headers) } } : {}),
  } as const;
}

const serializationLayer = (config: OtlpExportConfig, signal: OtlpSignal) =>
  config.otlpExports?.[signal]?.protocol === "http/protobuf"
    ? OtlpSerialization.layerProtobuf
    : OtlpSerialization.layerJson;

/**
 * The context one signal's exporter is built in: its serialization, the empty ConfigProvider, and
 * header redaction covering the OTEL headers (an export failure logs its request). Provide it with
 * `Effect.provide` to an exporter that is an effect, or `Layer.provide` to one that is a layer.
 */
export const otlpExporterContext = (config: OtlpExportConfig, signal: OtlpSignal) =>
  Layer.mergeAll(
    serializationLayer(config, signal),
    ConfigProvider.layer(emptyConfigProvider),
    Layer.effect(Headers.CurrentRedactedNames, otlpRedactedHeaderNames(config)),
  );

/** The OTLP span exporter the local file tracer delegates to. */
export const makeOtlpTracer = (config: OtlpExportConfig, url: string) =>
  OtlpTracer.make({ url, ...otlpExporterOptions(config, "traces") }).pipe(
    Effect.provide(
      Layer.mergeAll(otlpExporterContext(config, "traces"), OtlpExporter.layerFlusher),
    ),
  );

/** The OTLP metrics exporter. */
export const otlpMetricsLayer = (config: OtlpExportConfig, url: string) =>
  OtlpMetrics.layer({ url, ...otlpExporterOptions(config, "metrics") }).pipe(
    Layer.provide(otlpExporterContext(config, "metrics")),
  );

export class OtlpTracesEncodeError extends Data.TaggedError("OtlpTracesEncodeError")<{
  readonly cause: unknown;
}> {}

/**
 * A browser trace batch as protobuf, for the trace proxy's `http/protobuf` OTEL endpoints: a
 * collector that takes only protobuf rejects the JSON the browser posts.
 */
export const protobufTracesBody = (data: OtlpTracer.TraceData) =>
  Effect.gen(function* () {
    const serialization = yield* OtlpSerialization.OtlpSerialization;
    return yield* Effect.try({
      try: () => serialization.traces(data),
      catch: (cause) => new OtlpTracesEncodeError({ cause }),
    });
  }).pipe(Effect.provide(OtlpSerialization.layerProtobuf));

/** The OTLP log exporter the server logger adds to its loggers. */
export const makeOtlpLogger = (config: OtlpExportConfig, url: string) =>
  OtlpLogger.make({ url, ...otlpExporterOptions(config, "logs") }).pipe(
    Effect.provide(Layer.mergeAll(otlpExporterContext(config, "logs"), OtlpExporter.layerFlusher)),
  );
