/**
 * The standard OpenTelemetry exporter variables, as fallbacks for Ryco's own OTLP settings.
 *
 * Read through Effect `Config` as raw strings (a bad value never fails startup), then resolved by
 * pure functions:
 *
 * - `OTEL_SDK_DISABLED=true` and `OTEL_<SIGNAL>_EXPORTER=none` turn a signal off, whatever
 *   configured it.
 * - Otherwise Ryco's own sources win: `RYCO_OTLP_<SIGNAL>_URL`, then the desktop app's settings,
 *   then the persisted server settings. `OTEL_EXPORTER_OTLP_*` endpoints are used only for a signal
 *   none of those configured. They are often inherited from another tool's setup (Claude Code's
 *   telemetry, for one), and the desktop backend inherits the environment of the shell that started
 *   the app, so they must never override or disable an export the user set up in Ryco.
 * - An OTEL value Ryco cannot use (gRPC, a URL that is not http(s), malformed headers) leaves that
 *   signal's OTEL endpoint unused, with one startup warning. It never touches a Ryco source.
 * - OTEL headers go only to the OTEL endpoint they came with, never to a Ryco-configured URL.
 *
 * `OTEL_SERVICE_NAME`, `OTEL_SERVICE_VERSION` and `service.name`/`service.version` in
 * `OTEL_RESOURCE_ATTRIBUTES` are ignored: provider CLIs that Ryco starts inherit them and set their
 * own service names, and Ryco names itself through `RYCO_OTLP_SERVICE_NAME`.
 *
 * @module observability/OtelEnvironment
 */
import { Config, ConfigProvider, Effect, Layer, Option, Redacted } from "effect";
import { Headers } from "effect/http";
import { OtlpSerialization } from "effect/observability";

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

const signalVariable = (signal: OtlpSignal) => signal.toUpperCase();

const signalConfig = (signal: OtlpSignal) => {
  const upper = signalVariable(signal);
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

/** What the OTEL variables say about one signal. */
export interface OtelSignalSettings {
  /** `OTEL_<SIGNAL>_EXPORTER=none` (without `otlp`): the signal is off whatever configured it. */
  readonly disabled: boolean;
  /** A usable OTEL endpoint for this signal. */
  readonly endpoint: { readonly url: string; readonly export: OtlpSignalExport } | undefined;
  /**
   * Why an OTEL endpoint set for this signal cannot be used. Reported only when the endpoint
   * would otherwise have been used (no Ryco source configured the signal).
   */
  readonly endpointIssue: string | undefined;
}

export interface ResolvedOtelEnvironment {
  readonly sdkDisabled: boolean;
  readonly signals: Readonly<Record<OtlpSignal, OtelSignalSettings>>;
  /** Validated `OTEL_RESOURCE_ATTRIBUTES`, without `service.name`/`service.version`. */
  readonly resourceAttributes: Readonly<Record<string, string>>;
  readonly warnings: ReadonlyArray<string>;
}

const nonBlank = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed;
};

/** RFC 9110 token: what an HTTP header name may contain. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u;
// Header values with CR/LF would be refused by fetch; neither belongs in an attribute.
// oxlint-disable-next-line no-control-regex
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;

/**
 * Parses an OTEL `key=value,key=value` list with percent-encoded keys and values. Returns
 * undefined when any pair is malformed (the whole value is then ignored, as the OTEL spec asks).
 */
export function parseOtelKeyValueList(
  raw: string,
  options: { readonly headerNames?: boolean } = {},
): Record<string, string> | undefined {
  const result: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    if (pair.trim().length === 0) continue;
    const separator = pair.indexOf("=");
    if (separator <= 0) return undefined;
    let key: string;
    let value: string;
    try {
      key = decodeURIComponent(pair.slice(0, separator).trim());
      value = decodeURIComponent(pair.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
    if (key.length === 0 || CONTROL_CHARACTER.test(key) || CONTROL_CHARACTER.test(value)) {
      return undefined;
    }
    if (options.headerNames === true && !HEADER_NAME.test(key)) return undefined;
    Object.defineProperty(result, key, {
      value,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return result;
}

const parseHttpUrl = (raw: string): URL | undefined => {
  try {
    const url = new URL(raw);
    return url.protocol === "http:" || url.protocol === "https:" ? url : undefined;
  } catch {
    return undefined;
  }
};

/** The generic endpoint with `/v1/<signal>` appended to its path; the query is kept. */
const genericSignalUrl = (base: URL, signal: OtlpSignal): string => {
  const url = new URL(base.href);
  url.pathname = `${url.pathname.endsWith("/") ? url.pathname : `${url.pathname}/`}v1/${signal}`;
  return url.toString();
};

const resolveSignal = (raw: RawOtelEnvironment, signal: OtlpSignal): OtelSignalSettings => {
  const upper = signalVariable(signal);
  const signalRaw = raw[signal];
  const exporterVariable = `OTEL_${upper}_EXPORTER`;
  const exporters = (nonBlank(signalRaw.exporter) ?? "")
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter((name) => name.length > 0);
  const disabled = !exporters.includes("otlp") && exporters.includes("none");

  const signalEndpointVariable = `OTEL_EXPORTER_OTLP_${upper}_ENDPOINT`;
  const signalEndpoint = nonBlank(signalRaw.endpoint);
  const genericEndpoint = nonBlank(raw.endpoint);
  if (disabled || (signalEndpoint === undefined && genericEndpoint === undefined)) {
    return { disabled, endpoint: undefined, endpointIssue: undefined };
  }
  const unusable = (endpointIssue: string): OtelSignalSettings => ({
    disabled,
    endpoint: undefined,
    endpointIssue,
  });

  if (exporters.length > 0 && !exporters.includes("otlp")) {
    return unusable(
      `${exporterVariable} names no exporter Ryco has (it understands \`otlp\` and \`none\`), so ${signal} are not sent to the OTEL_EXPORTER_OTLP_* endpoint.`,
    );
  }

  // A set signal variable claims the signal: an invalid one does not fall back to the generic one.
  const endpointVariable =
    signalEndpoint !== undefined ? signalEndpointVariable : "OTEL_EXPORTER_OTLP_ENDPOINT";
  let url: string;
  if (signalEndpoint !== undefined) {
    if (parseHttpUrl(signalEndpoint) === undefined) {
      return unusable(
        `${signalEndpointVariable} is not an http(s) URL, so ${signal} are not sent to it.`,
      );
    }
    url = signalEndpoint;
  } else {
    const base = parseHttpUrl(genericEndpoint!);
    if (base === undefined) {
      return unusable(
        "OTEL_EXPORTER_OTLP_ENDPOINT is not an http(s) URL, so nothing is sent to it.",
      );
    }
    url = genericSignalUrl(base, signal);
  }

  const protocolVariable =
    nonBlank(signalRaw.protocol) !== undefined
      ? `OTEL_EXPORTER_OTLP_${upper}_PROTOCOL`
      : "OTEL_EXPORTER_OTLP_PROTOCOL";
  const protocolValue = (nonBlank(signalRaw.protocol) ?? nonBlank(raw.protocol))?.toLowerCase();
  let protocol: OtlpProtocol;
  if (protocolValue === undefined || protocolValue === "http/protobuf") {
    protocol = "http/protobuf";
  } else if (protocolValue === "http/json") {
    protocol = "http/json";
  } else if (protocolValue === "grpc") {
    return unusable(
      `${protocolVariable}=grpc is not supported (Ryco sends OTLP over HTTP only), so ${signal} are not sent to ${endpointVariable}.`,
    );
  } else {
    return unusable(
      `${protocolVariable} is not \`http/protobuf\` or \`http/json\`, so ${signal} are not sent to ${endpointVariable}.`,
    );
  }

  const headersVariable =
    nonBlank(signalRaw.headers) !== undefined
      ? `OTEL_EXPORTER_OTLP_${upper}_HEADERS`
      : "OTEL_EXPORTER_OTLP_HEADERS";
  const headersValue = nonBlank(signalRaw.headers) ?? nonBlank(raw.headers);
  let headers: Record<string, string> | undefined;
  if (headersValue !== undefined) {
    headers = parseOtelKeyValueList(headersValue, { headerNames: true });
    if (headers === undefined) {
      return unusable(
        `${headersVariable} is not a list of name=value pairs with percent-encoded values, so ${signal} are not sent to ${endpointVariable}.`,
      );
    }
  }
  return {
    disabled,
    endpoint: {
      url,
      export: {
        protocol,
        ...(headers !== undefined && Object.keys(headers).length > 0
          ? { headers: Redacted.make(headers) }
          : {}),
        endpointVariable,
      },
    },
    endpointIssue: undefined,
  };
};

export function resolveOtelEnvironment(raw: RawOtelEnvironment): ResolvedOtelEnvironment {
  const warnings = new Set<string>();
  // The OTEL spec: only `true` (any case) disables, and only a value other than `true` or `false`
  // deserves a warning.
  const sdkDisabledValue = nonBlank(raw.sdkDisabled)?.toLowerCase();
  const sdkDisabled = sdkDisabledValue === "true";
  if (sdkDisabledValue !== undefined && !sdkDisabled && sdkDisabledValue !== "false") {
    warnings.add("OTEL_SDK_DISABLED is neither `true` nor `false`, so it is read as false.");
  }

  let resourceAttributes: Record<string, string> = {};
  const resourceValue = nonBlank(raw.resourceAttributes);
  if (resourceValue !== undefined) {
    const parsed = parseOtelKeyValueList(resourceValue);
    if (parsed === undefined) {
      warnings.add(
        "OTEL_RESOURCE_ATTRIBUTES is not a list of key=value pairs with percent-encoded values, so it is ignored.",
      );
    } else {
      delete parsed["service.name"];
      delete parsed["service.version"];
      resourceAttributes = parsed;
    }
  }

  const signals = {
    traces: resolveSignal(raw, "traces"),
    metrics: resolveSignal(raw, "metrics"),
    logs: resolveSignal(raw, "logs"),
  };
  return { sdkDisabled, signals, resourceAttributes, warnings: [...warnings] };
}

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

/**
 * Where one signal is exported, if anywhere:
 *
 * 1. `OTEL_SDK_DISABLED=true`: off.
 * 2. `OTEL_<SIGNAL>_EXPORTER=none`: off.
 * 3. `RYCO_OTLP_<SIGNAL>_URL`.
 * 4. The desktop app's settings (traces and metrics only).
 * 5. The persisted server settings (traces and metrics only).
 * 6. An `OTEL_EXPORTER_OTLP_*` endpoint, with its protocol and headers.
 */
export function resolveOtlpSignal(
  otel: ResolvedOtelEnvironment,
  signal: OtlpSignal,
  sources: OtlpSignalSources,
): ResolvedOtlpSignal {
  const settings = otel.signals[signal];
  const rycoSource =
    sources.rycoEnvUrl !== undefined
      ? { url: sources.rycoEnvUrl, label: `RYCO_OTLP_${signalVariable(signal)}_URL` }
      : sources.bootstrapUrl !== undefined
        ? { url: sources.bootstrapUrl, label: "the desktop app's settings" }
        : sources.settingsUrl !== undefined
          ? { url: sources.settingsUrl, label: "Settings" }
          : undefined;

  const killSwitch = otel.sdkDisabled
    ? "OTEL_SDK_DISABLED=true"
    : settings.disabled
      ? `OTEL_${signalVariable(signal)}_EXPORTER=none`
      : undefined;
  if (killSwitch !== undefined) {
    return {
      url: undefined,
      export: undefined,
      warnings:
        rycoSource === undefined
          ? []
          : [`${killSwitch} turned off the OTLP ${signal} export set by ${rycoSource.label}.`],
    };
  }
  if (rycoSource !== undefined) {
    return { url: rycoSource.url, export: undefined, warnings: [] };
  }
  if (settings.endpoint !== undefined) {
    return { url: settings.endpoint.url, export: settings.endpoint.export, warnings: [] };
  }
  return {
    url: undefined,
    export: undefined,
    warnings: settings.endpointIssue === undefined ? [] : [settings.endpointIssue],
  };
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

/** Resolves the OTEL variables and every signal's export for the server config. */
export function resolveOtlpExports(
  raw: RawOtelEnvironment,
  sources: {
    readonly traces: OtlpSignalSources;
    readonly metrics: OtlpSignalSources;
    readonly logs: OtlpSignalSources;
  },
): ResolvedOtlpExports {
  const otel = resolveOtelEnvironment(raw);
  const traces = resolveOtlpSignal(otel, "traces", sources.traces);
  const metrics = resolveOtlpSignal(otel, "metrics", sources.metrics);
  const logs = resolveOtlpSignal(otel, "logs", sources.logs);
  const exports: Partial<Record<OtlpSignal, OtlpSignalExport>> = {
    ...(traces.export !== undefined ? { traces: traces.export } : {}),
    ...(metrics.export !== undefined ? { metrics: metrics.export } : {}),
    ...(logs.export !== undefined ? { logs: logs.export } : {}),
  };
  return {
    traces,
    metrics,
    logs,
    exports: Object.keys(exports).length > 0 ? exports : undefined,
    resourceAttributes:
      Object.keys(otel.resourceAttributes).length > 0 ? otel.resourceAttributes : undefined,
    warnings: [
      ...new Set([...otel.warnings, ...traces.warnings, ...metrics.warnings, ...logs.warnings]),
    ],
  };
}

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

/** `Headers.CurrentRedactedNames` plus every configured OTEL header name, each once. */
export const otlpRedactedHeaderNames = (config: Pick<ServerConfigShape, "otlpExports">) =>
  Effect.map(Effect.service(Headers.CurrentRedactedNames), (names) => [
    ...new Set([...names, ...otlpExportHeaderNames(config.otlpExports)]),
  ]);

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
