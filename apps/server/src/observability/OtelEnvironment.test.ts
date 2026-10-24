import { assert, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Redacted } from "effect";
import { OtlpResource } from "effect/observability";

import {
  OtelEnvironmentConfig,
  otlpExportHeaderNames,
  resolveServerOtlpExports,
  type OtlpSignalSources,
  type RawOtelEnvironment,
} from "./OtelEnvironment.ts";
import {
  parseOtelKeyValueList,
  resolveOtelEnvironment,
  resolveOtlpExports,
  resolveOtlpSignal,
} from "./OtelEnvironmentResolver.ts";
import { otlpExporterContext, otlpExporterOptions } from "./OtlpExporters.ts";

const readRaw = (env: Record<string, string>): RawOtelEnvironment =>
  Effect.runSync(
    Effect.gen(function* () {
      return yield* OtelEnvironmentConfig;
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env }))),
  );

const resolve = (env: Record<string, string>) => resolveOtelEnvironment(readRaw(env));

const exportsFor = (
  env: Record<string, string>,
  sources: Partial<Record<"traces" | "metrics" | "logs", OtlpSignalSources>> = {},
) =>
  resolveOtlpExports(readRaw(env), {
    traces: sources.traces ?? {},
    metrics: sources.metrics ?? {},
    logs: sources.logs ?? {},
  });

describe("resolveOtelEnvironment", () => {
  it("reads OTEL_SDK_DISABLED as true only for a case-insensitive `true`", () => {
    expect(resolve({ OTEL_SDK_DISABLED: "true" }).sdkDisabled).toBe(true);
    expect(resolve({ OTEL_SDK_DISABLED: "TRUE" }).sdkDisabled).toBe(true);
    const one = resolve({ OTEL_SDK_DISABLED: "1" });
    expect(one.sdkDisabled).toBe(false);
    expect(one.warnings).toEqual([
      "OTEL_SDK_DISABLED is neither `true` nor `false`, so it is read as false.",
    ]);
    // An explicit `false` is valid and quiet.
    for (const value of ["false", "False"]) {
      const explicit = resolve({ OTEL_SDK_DISABLED: value });
      expect(explicit.sdkDisabled).toBe(false);
      expect(explicit.warnings).toEqual([]);
    }
    expect(resolve({}).warnings).toEqual([]);
  });

  it("turns a signal off for `none` unless `otlp` is listed too", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
    expect(resolve({ ...env, OTEL_TRACES_EXPORTER: "none" }).signals.traces).toEqual({
      disabled: true,
      endpoint: undefined,
      endpointIssue: undefined,
    });
    const both = resolve({ ...env, OTEL_TRACES_EXPORTER: "otlp,none" }).signals.traces;
    expect(both.disabled).toBe(false);
    expect(both.endpoint?.url).toBe("http://collector:4318/v1/traces");
    const console = resolve({ ...env, OTEL_METRICS_EXPORTER: "console" }).signals.metrics;
    expect(console.disabled).toBe(false);
    expect(console.endpoint).toBeUndefined();
    expect(console.endpointIssue).toContain("OTEL_METRICS_EXPORTER names no exporter Ryco has");
  });

  it("appends /v1/<signal> to the generic endpoint and keeps its query", () => {
    const resolved = resolve({ OTEL_EXPORTER_OTLP_ENDPOINT: "https://otel.example/base?team=a" });
    expect(resolved.signals.traces.endpoint?.url).toBe(
      "https://otel.example/base/v1/traces?team=a",
    );
    expect(resolved.signals.metrics.endpoint?.url).toBe(
      "https://otel.example/base/v1/metrics?team=a",
    );
    expect(resolved.signals.logs.endpoint?.url).toBe("https://otel.example/base/v1/logs?team=a");
    expect(
      resolve({ OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318/" }).signals.traces.endpoint
        ?.url,
    ).toBe("http://collector:4318/v1/traces");
  });

  it("uses a signal endpoint verbatim and falls back to the generic one when it is blank", () => {
    const resolved = resolve({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "http://traces:9999/custom",
      OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: "   ",
    });
    expect(resolved.signals.traces.endpoint).toMatchObject({
      url: "http://traces:9999/custom",
      export: { endpointVariable: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT" },
    });
    expect(resolved.signals.metrics.endpoint).toMatchObject({
      url: "http://collector:4318/v1/metrics",
      export: { endpointVariable: "OTEL_EXPORTER_OTLP_ENDPOINT" },
    });
  });

  it("does not use an endpoint that is not an http(s) URL, and a set signal variable claims it", () => {
    const resolved = resolve({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_TRACES_ENDPOINT: "collector:4317",
    });
    expect(resolved.signals.traces.endpoint).toBeUndefined();
    expect(resolved.signals.traces.endpointIssue).toBe(
      "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT is not an http(s) URL, so traces are not sent to it.",
    );
    expect(resolved.signals.metrics.endpoint?.url).toBe("http://collector:4318/v1/metrics");
    expect(
      resolve({ OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://collector" }).signals.logs.endpointIssue,
    ).toBe("OTEL_EXPORTER_OTLP_ENDPOINT is not an http(s) URL, so nothing is sent to it.");
  });

  it("defaults to http/protobuf, accepts http/json, and refuses grpc", () => {
    const env = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
    expect(resolve(env).signals.traces.endpoint?.export.protocol).toBe("http/protobuf");
    const json = resolve({
      ...env,
      OTEL_EXPORTER_OTLP_PROTOCOL: "grpc",
      OTEL_EXPORTER_OTLP_LOGS_PROTOCOL: "http/json",
    });
    expect(json.signals.logs.endpoint?.export.protocol).toBe("http/json");
    expect(json.signals.traces.endpoint).toBeUndefined();
    expect(json.signals.traces.endpointIssue).toBe(
      "OTEL_EXPORTER_OTLP_PROTOCOL=grpc is not supported (Ryco sends OTLP over HTTP only), so traces are not sent to OTEL_EXPORTER_OTLP_ENDPOINT.",
    );
    expect(
      resolve({ ...env, OTEL_EXPORTER_OTLP_PROTOCOL: "thrift" }).signals.metrics.endpointIssue,
    ).toContain("is not `http/protobuf` or `http/json`");
  });

  it("percent-decodes headers, prefers the signal's, and refuses malformed ones", () => {
    const resolved = resolve({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "x-honeycomb-team=abc%20def, x-other = 1",
      OTEL_EXPORTER_OTLP_LOGS_HEADERS: "api-key=logs",
    });
    const traceHeaders = resolved.signals.traces.endpoint?.export.headers;
    assert.isDefined(traceHeaders);
    expect(Redacted.value(traceHeaders!)).toEqual({
      "x-honeycomb-team": "abc def",
      "x-other": "1",
    });
    expect(String(traceHeaders)).not.toContain("abc");
    expect(Redacted.value(resolved.signals.logs.endpoint!.export.headers!)).toEqual({
      "api-key": "logs",
    });

    const malformed = resolve({
      OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
      OTEL_EXPORTER_OTLP_HEADERS: "x-key=%zz",
    });
    expect(malformed.signals.traces.endpoint).toBeUndefined();
    expect(malformed.signals.traces.endpointIssue).toContain(
      "OTEL_EXPORTER_OTLP_HEADERS is not a list of name=value pairs",
    );
    expect(JSON.stringify(malformed)).not.toContain("%zz");
    expect(
      resolve({
        OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318",
        OTEL_EXPORTER_OTLP_HEADERS: "bad header=1",
      }).signals.traces.endpoint,
    ).toBeUndefined();
  });

  it("parses resource attributes and ignores an invalid value with a warning", () => {
    expect(
      resolve({
        OTEL_RESOURCE_ATTRIBUTES:
          "deployment.environment=prod,team=core%2Fobs,service.name=x,service.version=9",
      }).resourceAttributes,
    ).toEqual({ "deployment.environment": "prod", team: "core/obs" });
    const invalid = resolve({ OTEL_RESOURCE_ATTRIBUTES: "a=%zz" });
    expect(invalid.resourceAttributes).toEqual({});
    expect(invalid.warnings).toEqual([
      "OTEL_RESOURCE_ATTRIBUTES is not a list of key=value pairs with percent-encoded values, so it is ignored.",
    ]);
  });

  it("parses key=value lists strictly", () => {
    expect(parseOtelKeyValueList("a=1,,b=2")).toEqual({ a: "1", b: "2" });
    expect(parseOtelKeyValueList("noequals")).toBeUndefined();
    expect(parseOtelKeyValueList("=1")).toBeUndefined();
    expect(parseOtelKeyValueList("a=line%0Abreak")).toBeUndefined();
    const proto = parseOtelKeyValueList("__proto__=x");
    expect(Object.keys(proto ?? {})).toEqual(["__proto__"]);
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
  });
});

describe("resolveOtlpSignal precedence", () => {
  const otelEndpoint = { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" };
  const allRyco = {
    rycoEnvUrl: "http://ryco-env/v1/traces",
    bootstrapUrl: "http://desktop/v1/traces",
    settingsUrl: "http://settings/v1/traces",
  };

  it("ranks RYCO env > desktop > Settings > OTEL endpoint", () => {
    const otel = resolve(otelEndpoint);
    expect(resolveOtlpSignal(otel, "traces", allRyco).url).toBe("http://ryco-env/v1/traces");
    expect(resolveOtlpSignal(otel, "traces", { ...allRyco, rycoEnvUrl: undefined }).url).toBe(
      "http://desktop/v1/traces",
    );
    expect(resolveOtlpSignal(otel, "traces", { settingsUrl: allRyco.settingsUrl })).toEqual({
      url: "http://settings/v1/traces",
      export: undefined,
      warnings: [],
    });
    expect(resolveOtlpSignal(otel, "traces", {})).toEqual({
      url: "http://collector:4318/v1/traces",
      export: { protocol: "http/protobuf", endpointVariable: "OTEL_EXPORTER_OTLP_ENDPOINT" },
      warnings: [],
    });
  });

  it("never sends OTEL headers to a Ryco-configured URL", () => {
    const otel = resolve({ ...otelEndpoint, OTEL_EXPORTER_OTLP_HEADERS: "x-key=secret" });
    const resolved = resolveOtlpSignal(otel, "traces", { settingsUrl: allRyco.settingsUrl });
    expect(resolved.export).toBeUndefined();
  });

  it("lets an unusable OTEL value warn without disabling a Ryco source", () => {
    const grpc = resolve({ ...otelEndpoint, OTEL_EXPORTER_OTLP_PROTOCOL: "grpc" });
    expect(resolveOtlpSignal(grpc, "traces", { settingsUrl: allRyco.settingsUrl })).toEqual({
      url: "http://settings/v1/traces",
      export: undefined,
      warnings: [],
    });
    const alone = resolveOtlpSignal(grpc, "traces", {});
    expect(alone.url).toBeUndefined();
    expect(alone.warnings).toHaveLength(1);
  });

  it("lets OTEL_SDK_DISABLED beat RYCO env and warns about what it turned off", () => {
    const otel = resolve({ ...otelEndpoint, OTEL_SDK_DISABLED: "true" });
    expect(resolveOtlpSignal(otel, "traces", allRyco)).toEqual({
      url: undefined,
      export: undefined,
      warnings: [
        "OTEL_SDK_DISABLED=true turned off the OTLP traces export set by RYCO_OTLP_TRACES_URL.",
      ],
    });
    expect(resolveOtlpSignal(otel, "logs", {}).warnings).toEqual([]);
  });

  it("lets a per-signal `none` beat Settings", () => {
    const otel = resolve({ OTEL_METRICS_EXPORTER: "none" });
    expect(
      resolveOtlpSignal(otel, "metrics", { settingsUrl: "http://settings/v1/metrics" }),
    ).toEqual({
      url: undefined,
      export: undefined,
      warnings: ["OTEL_METRICS_EXPORTER=none turned off the OTLP metrics export set by Settings."],
    });
    expect(
      resolveOtlpSignal(otel, "traces", { settingsUrl: "http://settings/v1/traces" }).url,
    ).toBe("http://settings/v1/traces");
  });
});

describe("resolveOtlpExports", () => {
  it("keeps exports only for OTEL endpoints and each warning once", () => {
    const resolved = exportsFor(
      {
        OTEL_EXPORTER_OTLP_ENDPOINT: "ftp://nope",
        OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: "http://logs:4318/v1/logs",
        OTEL_EXPORTER_OTLP_LOGS_HEADERS: "dd-api-key=secret",
      },
      { traces: { settingsUrl: "http://settings/v1/traces" } },
    );
    expect(resolved.traces.url).toBe("http://settings/v1/traces");
    expect(resolved.metrics.url).toBeUndefined();
    expect(resolved.logs.url).toBe("http://logs:4318/v1/logs");
    expect(Object.keys(resolved.exports ?? {})).toEqual(["logs"]);
    expect(otlpExportHeaderNames(resolved.exports)).toEqual(["dd-api-key"]);
    expect(resolved.warnings).toEqual([
      "OTEL_EXPORTER_OTLP_ENDPOINT is not an http(s) URL, so nothing is sent to it.",
    ]);
    expect(resolved.resourceAttributes).toBeUndefined();
    expect(JSON.stringify(resolved)).not.toContain("secret");
  });

  it("leaves everything unset without OTEL variables", () => {
    expect(exportsFor({})).toEqual({
      traces: { url: undefined, export: undefined, warnings: [] },
      metrics: { url: undefined, export: undefined, warnings: [] },
      logs: { url: undefined, export: undefined, warnings: [] },
      exports: undefined,
      resourceAttributes: undefined,
      warnings: [],
    });
  });
});

describe("resolveServerOtlpExports", () => {
  const sourcesFor = (
    sources: Partial<Record<"traces" | "metrics" | "logs", OtlpSignalSources>> = {},
  ) => ({
    traces: sources.traces ?? {},
    metrics: sources.metrics ?? {},
    logs: sources.logs ?? {},
  });
  const cases: ReadonlyArray<{
    readonly env: Record<string, string>;
    readonly sources?: Partial<Record<"traces" | "metrics" | "logs", OtlpSignalSources>>;
  }> = [
    // Nothing set: answered without loading the resolver.
    { env: {} },
    { env: {}, sources: { traces: { settingsUrl: "http://settings/v1/traces" } } },
    { env: {}, sources: { logs: { rycoEnvUrl: "http://logs/v1/logs" } } },
    { env: { OTEL_SDK_DISABLED: "" } },
    { env: { OTEL_LOGS_EXPORTER: "none" } },
    { env: { OTEL_SDK_DISABLED: "maybe" } },
    { env: { OTEL_RESOURCE_ATTRIBUTES: "a=%zz" } },
    {
      env: { OTEL_SDK_DISABLED: "true" },
      sources: { metrics: { bootstrapUrl: "http://desktop/v1/metrics" } },
    },
    { env: { OTEL_EXPORTER_OTLP_ENDPOINT: "http://collector:4318" } },
  ];

  it.effect("answers exactly as resolveOtlpExports does", () =>
    Effect.gen(function* () {
      for (const { env, sources } of cases) {
        const raw = readRaw(env);
        expect(yield* resolveServerOtlpExports(raw, sourcesFor(sources))).toEqual(
          resolveOtlpExports(raw, sourcesFor(sources)),
        );
      }
    }),
  );
});

describe("OTLP exporter construction", () => {
  const config = {
    otlpServiceName: "ryco-server",
    otlpExportIntervalMs: 1_000,
    mode: "web" as const,
    otlpExports: undefined,
    otlpResourceAttributes: { team: "core" },
  };

  it.effect("builds the resource without the raw environment, even when it does not decode", () =>
    Effect.gen(function* () {
      const options = otlpExporterOptions(config, "traces");
      const resource = yield* OtlpResource.fromConfig(options.resource).pipe(
        Effect.provide(otlpExporterContext(config, "traces")),
        // The process environment as a server started with these variables would see it.
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: {
              OTEL_RESOURCE_ATTRIBUTES: "a=%zz",
              OTEL_SERVICE_NAME: "claude-code",
              OTEL_SERVICE_VERSION: "9.9.9",
            },
          }),
        ),
      );
      const attributes = Object.fromEntries(
        resource.attributes.map((attribute) => [attribute.key, attribute.value]),
      );
      expect(attributes["service.name"]).toEqual({ stringValue: "ryco-server" });
      expect(attributes["service.version"]).toBeUndefined();
      expect(attributes.team).toEqual({ stringValue: "core" });
      expect(attributes["service.runtime"]).toEqual({ stringValue: "ryco-server" });
      expect(attributes.a).toBeUndefined();
    }),
  );

  it.effect(
    "dies on the same environment without the exporter context (the old startup crash)",
    () =>
      Effect.gen(function* () {
        const exit = yield* OtlpResource.fromConfig(
          otlpExporterOptions(config, "traces").resource,
        ).pipe(
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromEnv({ env: { OTEL_RESOURCE_ATTRIBUTES: "a=%zz" } }),
          ),
          Effect.exit,
        );
        expect(exit._tag).toBe("Failure");
      }),
  );
});
