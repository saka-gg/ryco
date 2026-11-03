/**
 * Resolves the standard OpenTelemetry exporter variables, as fallbacks for Ryco's own OTLP
 * settings. Pure functions over the raw strings `OtelEnvironmentConfig` read, so a bad value never
 * fails startup. Loaded by `resolveServerOtlpExports` only when an OTEL variable or a Ryco OTLP
 * URL is set.
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
 * @module observability/OtelEnvironmentResolver
 */
import { Redacted } from "effect";

import {
  otelSignalVariable,
  type OtlpExportSources,
  type OtlpProtocol,
  type OtlpSignal,
  type OtlpSignalExport,
  type OtlpSignalSources,
  type RawOtelEnvironment,
  type ResolvedOtlpExports,
  type ResolvedOtlpSignal,
} from "./OtelEnvironment.ts";

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
  const upper = otelSignalVariable(signal);
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
      ? { url: sources.rycoEnvUrl, label: `RYCO_OTLP_${otelSignalVariable(signal)}_URL` }
      : sources.bootstrapUrl !== undefined
        ? { url: sources.bootstrapUrl, label: "the desktop app's settings" }
        : sources.settingsUrl !== undefined
          ? { url: sources.settingsUrl, label: "Settings" }
          : undefined;

  const killSwitch = otel.sdkDisabled
    ? "OTEL_SDK_DISABLED=true"
    : settings.disabled
      ? `OTEL_${otelSignalVariable(signal)}_EXPORTER=none`
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

/** Resolves the OTEL variables and every signal's export for the server config. */
export function resolveOtlpExports(
  raw: RawOtelEnvironment,
  sources: OtlpExportSources,
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
