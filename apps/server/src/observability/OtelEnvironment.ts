/**
 * The OTLP export settings every server start reads: the raw OTEL variables, the shape of a
 * resolved export, and the two entry points that load the rest only when it is needed.
 *
 * Most servers export nothing, so neither of these is on the server's boot path
 * (serverBundleBoundaries.test.ts):
 *
 * - The OTEL variable resolver (`OtelEnvironmentResolver.ts`, which documents the precedence and
 *   the kill switches) loads only when an OTEL variable or a Ryco OTLP URL is set.
 * - Effect's OTLP exporters and their protobuf encoder (`OtlpExporters.ts`) load only when a
 *   signal is exported.
 *
 * @module observability/OtelEnvironment
 */
import { Config, Effect, Option, Redacted } from "effect";
import { Headers } from "effect/http";

import type { ServerConfigShape } from "../config.ts";

export const OTLP_SIGNALS = ["traces", "metrics", "logs"] as const;
export type OtlpSignal = (typeof OTLP_SIGNALS)[number];

export type OtlpProtocol = "http/json" | "http/protobuf";

/** How a signal whose endpoint came from `OTEL_EXPORTER_OTLP_*` variables is sent. */
export interface OtlpSignalExport {
  readonly protocol: OtlpProtocol;
  /** Sent with this signal's requests only. Never logged. */
  readonly headers?: Redacted.Redacted<Readonly<Record<string, string>>> | undefined;
  /** The variable the endpoint came from, named in the startup log line. */
  readonly endpointVariable: string;
}

interface RawOtelSignalEnvironment {
  readonly exporter: string | undefined;
  readonly endpoint: string | undefined;
  readonly headers: string | undefined;
  readonly protocol: string | undefined;
}

export interface RawOtelEnvironment {
  readonly sdkDisabled: string | undefined;
  readonly endpoint: string | undefined;
  readonly headers: string | undefined;
  readonly protocol: string | undefined;
  readonly resourceAttributes: string | undefined;
  readonly traces: RawOtelSignalEnvironment;
  readonly metrics: RawOtelSignalEnvironment;
  readonly logs: RawOtelSignalEnvironment;
}

const optionalString = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined));

/** The signal as OTEL variable names spell it (`TRACES`). */
export const otelSignalVariable = (signal: OtlpSignal) => signal.toUpperCase();

const signalConfig = (signal: OtlpSignal) => {
  const upper = otelSignalVariable(signal);
  return Config.all({
    exporter: optionalString(`OTEL_${upper}_EXPORTER`),
    endpoint: optionalString(`OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`),
    headers: optionalString(`OTEL_EXPORTER_OTLP_${upper}_HEADERS`),
    protocol: optionalString(`OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`),
  });
};

/** Every OTEL variable Ryco reads, as raw strings. Never fails. */
export const OtelEnvironmentConfig: Config.Config<RawOtelEnvironment> = Config.all({
  sdkDisabled: optionalString("OTEL_SDK_DISABLED"),
  endpoint: optionalString("OTEL_EXPORTER_OTLP_ENDPOINT"),
  headers: optionalString("OTEL_EXPORTER_OTLP_HEADERS"),
  protocol: optionalString("OTEL_EXPORTER_OTLP_PROTOCOL"),
  resourceAttributes: optionalString("OTEL_RESOURCE_ATTRIBUTES"),
  traces: signalConfig("traces"),
  metrics: signalConfig("metrics"),
  logs: signalConfig("logs"),
});

export interface OtlpSignalSources {
  /** `RYCO_OTLP_<SIGNAL>_URL`. */
  readonly rycoEnvUrl?: string | undefined;
  /** The desktop app's observability settings, from the bootstrap envelope. */
  readonly bootstrapUrl?: string | undefined;
  /** The server's persisted observability settings. */
  readonly settingsUrl?: string | undefined;
}

export interface ResolvedOtlpSignal {
  readonly url: string | undefined;
  /** Present only when the endpoint came from OTEL variables; absent means OTLP/HTTP JSON, no headers. */
  readonly export: OtlpSignalExport | undefined;
  readonly warnings: ReadonlyArray<string>;
}

export interface ResolvedOtlpExports {
  readonly traces: ResolvedOtlpSignal;
  readonly metrics: ResolvedOtlpSignal;
  readonly logs: ResolvedOtlpSignal;
  /** Only the signals whose endpoint came from OTEL variables; undefined when there are none. */
  readonly exports: Partial<Record<OtlpSignal, OtlpSignalExport>> | undefined;
  /** Undefined when `OTEL_RESOURCE_ATTRIBUTES` holds no usable attribute. */
  readonly resourceAttributes: Readonly<Record<string, string>> | undefined;
  /** Every startup warning, each once. */
  readonly warnings: ReadonlyArray<string>;
}

export type OtlpExportSources = Readonly<Record<OtlpSignal, OtlpSignalSources>>;

/** Any OTEL variable Ryco reads is set, even to a blank value (the resolver decides what it means). */
const hasOtelVariable = (raw: RawOtelEnvironment): boolean =>
  Object.values(raw).some((value) =>
    typeof value === "object"
      ? Object.values(value).some((signalValue) => signalValue !== undefined)
      : value !== undefined,
  );

const hasRycoSource = (sources: OtlpExportSources): boolean =>
  OTLP_SIGNALS.some((signal) => {
    const source = sources[signal];
    return (
      source.rycoEnvUrl !== undefined ||
      source.bootstrapUrl !== undefined ||
      source.settingsUrl !== undefined
    );
  });

const NO_OTLP_SIGNAL: ResolvedOtlpSignal = { url: undefined, export: undefined, warnings: [] };

/** What `resolveOtlpExports` returns when no OTEL variable and no Ryco source is set. */
const NO_OTLP_EXPORTS: ResolvedOtlpExports = {
  traces: NO_OTLP_SIGNAL,
  metrics: NO_OTLP_SIGNAL,
  logs: NO_OTLP_SIGNAL,
  exports: undefined,
  resourceAttributes: undefined,
  warnings: [],
};

/**
 * Every signal's export for the server config (`resolveOtlpExports`). The resolver loads only when
 * there is something to resolve: with no OTEL variable and no Ryco OTLP URL set, nothing is
 * exported and there is nothing to warn about.
 */
export const resolveServerOtlpExports = (
  raw: RawOtelEnvironment,
  sources: OtlpExportSources,
): Effect.Effect<ResolvedOtlpExports> =>
  hasOtelVariable(raw) || hasRycoSource(sources)
    ? Effect.map(
        Effect.promise(() => import("./OtelEnvironmentResolver.ts")),
        (resolver) => resolver.resolveOtlpExports(raw, sources),
      )
    : Effect.succeed(NO_OTLP_EXPORTS);

/** Header names of every OTEL-configured export, lower-cased, for log and span redaction. */
export function otlpExportHeaderNames(
  exports: Partial<Record<OtlpSignal, OtlpSignalExport>> | undefined,
): ReadonlyArray<string> {
  const names = new Set<string>();
  for (const signal of OTLP_SIGNALS) {
    const headers = exports?.[signal]?.headers;
    if (headers === undefined) continue;
    for (const name of Object.keys(Redacted.value(headers))) names.add(name.toLowerCase());
  }
  return [...names];
}

/** `Headers.CurrentRedactedNames` plus every configured OTEL header name, each once. */
export const otlpRedactedHeaderNames = (config: Pick<ServerConfigShape, "otlpExports">) =>
  Effect.map(Effect.service(Headers.CurrentRedactedNames), (names) => [
    ...new Set([...names, ...otlpExportHeaderNames(config.otlpExports)]),
  ]);

/**
 * Effect's OTLP exporters, built the way Ryco builds them. Load them only for a signal that is
 * exported (its `otlp<Signal>Url` is set).
 */
export const loadOtlpExporters = Effect.promise(() => import("./OtlpExporters.ts"));
