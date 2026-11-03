import * as NodeHttp from "node:http";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Metric, Redacted } from "effect";
import { FetchHttpClient } from "effect/http";

import { ServerConfig, type ServerConfigShape } from "../../config.ts";
import { ObservabilityLive } from "./Observability.ts";

interface CollectedRequest {
  readonly path: string;
  readonly contentType: string | undefined;
  readonly headers: NodeHttp.IncomingHttpHeaders;
  readonly body: Buffer;
}

/** A local OTLP/HTTP collector that accepts everything and records each request. */
const fakeCollector = Effect.acquireRelease(
  Effect.promise(
    () =>
      new Promise<{
        readonly origin: string;
        readonly requests: Array<CollectedRequest>;
        readonly close: () => Promise<void>;
      }>((resolve, reject) => {
        const requests: Array<CollectedRequest> = [];
        const server = NodeHttp.createServer((request, response) => {
          const chunks: Array<Buffer> = [];
          request.on("data", (chunk: Buffer) => chunks.push(chunk));
          request.on("end", () => {
            requests.push({
              path: request.url ?? "",
              contentType: request.headers["content-type"],
              headers: request.headers,
              body: Buffer.concat(chunks),
            });
            response.statusCode = 200;
            response.end("{}");
          });
        });
        server.on("error", reject);
        server.listen(0, "127.0.0.1", () => {
          const address = server.address();
          if (address === null || typeof address === "string") {
            reject(new Error("Expected a TCP address"));
            return;
          }
          resolve({
            origin: `http://127.0.0.1:${address.port}`,
            requests,
            close: () => new Promise<void>((done) => server.close(() => done())),
          });
        });
      }),
  ),
  (collector) => Effect.promise(collector.close),
);

/** A data directory that outlives the layer, so the trace file can be read after it closes. */
const tempBaseDir = Effect.acquireRelease(
  Effect.sync(() => mkdtempSync(join(tmpdir(), "ryco-observability-"))),
  (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
);

const configLayer = (baseDir: string, overrides: Partial<ServerConfigShape>) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        logLevel: "Info" as const,
        otlpExportIntervalMs: 60_000,
        ...overrides,
      };
    }),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), baseDir)));

/** Builds ObservabilityLive the way the server does, runs `effect` under it, then closes it. */
const runUnderObservability = <A, E>(
  overrides: Partial<ServerConfigShape>,
  env: Record<string, string>,
  effect: Effect.Effect<A, E, ServerConfig>,
) =>
  Effect.flatMap(tempBaseDir, (baseDir) =>
    effect.pipe(
      Effect.provide(
        ObservabilityLive.pipe(
          Layer.provideMerge(configLayer(baseDir, overrides)),
          Layer.provide(FetchHttpClient.layer),
          Layer.provide(NodeServices.layer),
          // The process environment a server started with these variables would see.
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromEnv({ env }))),
        ),
      ),
    ),
  );

describe("ObservabilityLive", () => {
  it.live(
    "builds with an OTEL_RESOURCE_ATTRIBUTES that does not decode and exports traces and logs",
    () =>
      Effect.gen(function* () {
        const collector = yield* fakeCollector;
        const tracePath = yield* runUnderObservability(
          {
            otlpTracesUrl: `${collector.origin}/v1/traces`,
            otlpMetricsUrl: `${collector.origin}/v1/metrics`,
            otlpLogsUrl: `${collector.origin}/v1/logs?token=hidden`,
            otlpResourceAttributes: { team: "core" },
            observabilityWarnings: [
              "OTEL_SDK_DISABLED is neither `true` nor `false`, so it is read as false.",
            ],
          },
          { OTEL_RESOURCE_ATTRIBUTES: "a=%zz", OTEL_SERVICE_VERSION: "9.9.9" },
          Effect.gen(function* () {
            yield* Effect.logInfo("message inside a span").pipe(Effect.withSpan("test.span"));
            yield* Metric.update(Metric.counter("ryco_test_counter"), 1);
            return (yield* ServerConfig).serverTracePath;
          }),
        );

        const traces = collector.requests.filter((request) => request.path === "/v1/traces");
        const metrics = collector.requests.filter((request) => request.path === "/v1/metrics");
        const logs = collector.requests.filter((request) => request.path.startsWith("/v1/logs"));
        assert.isAbove(traces.length, 0);
        assert.isAbove(metrics.length, 0);
        assert.isAbove(logs.length, 0);
        expect(traces[0]!.contentType).toBe("application/json");
        expect(metrics[0]!.contentType).toBe("application/json");
        expect(logs[0]!.contentType).toBe("application/json");
        const metricBody = metrics.map((request) => request.body.toString("utf8")).join("\n");
        expect(metricBody).toContain("ryco_test_counter");
        expect(metricBody).toContain('"team"');
        expect(metricBody).not.toContain("9.9.9");

        const traceBody = traces.map((request) => request.body.toString("utf8")).join("\n");
        expect(traceBody).toContain('"test.span"');
        expect(traceBody).toContain('"team"');
        expect(traceBody).not.toContain("9.9.9");

        const logBody = logs.map((request) => request.body.toString("utf8")).join("\n");
        expect(logBody).toContain("message inside a span");
        expect(logBody).toContain(`Exporting traces over OTLP to ${collector.origin}/v1/traces`);
        // The logs URL's query value is redacted in the startup line.
        expect(logBody).toContain("Exporting logs over OTLP to");
        expect(logBody).not.toContain("token=hidden");
        expect(logBody).toContain(
          "OTEL_SDK_DISABLED is neither `true` nor `false`, so it is read as false.",
        );

        // The local trace file still gets the in-span message as a span event.
        expect(readFileSync(tracePath, "utf8")).toContain("message inside a span");
      }),
  );

  it.live("sends OTEL-configured signals as protobuf with their headers", () =>
    Effect.gen(function* () {
      const collector = yield* fakeCollector;
      yield* runUnderObservability(
        {
          otlpLogsUrl: `${collector.origin}/v1/logs`,
          otlpExports: {
            logs: {
              protocol: "http/protobuf",
              headers: Redacted.make({ "x-honeycomb-team": "SECRET-VALUE" }),
              endpointVariable: "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
            },
          },
        },
        {},
        Effect.logInfo("protobuf log line"),
      );

      const logs = collector.requests.filter((request) => request.path === "/v1/logs");
      // One exporter (the server logger is built once) flushed one batch at shutdown, holding the
      // startup line and the test's line.
      expect(logs).toHaveLength(1);
      expect(logs[0]!.contentType).toBe("application/x-protobuf");
      expect(logs[0]!.headers["x-honeycomb-team"]).toBe("SECRET-VALUE");
      // Protobuf keeps strings as UTF-8 bytes, so the messages are readable in the raw body.
      const body = Buffer.concat(logs.map((request) => request.body)).toString("latin1");
      expect(body).toContain("protobuf log line");
      // The startup line names the variable and protocol, never the header.
      expect(body).toContain("http/protobuf, from OTEL_EXPORTER_OTLP_LOGS_ENDPOINT");
      expect(body).not.toContain("SECRET-VALUE");
    }),
  );
});
