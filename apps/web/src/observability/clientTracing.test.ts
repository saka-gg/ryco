import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const exporter = vi.hoisted(() => ({
  moduleLoads: 0,
  starts: [] as Array<{ readonly url: string; readonly exportIntervalMs: number }>,
  disposals: 0,
  spans: [] as string[],
}));

vi.mock("../environments/primary", () => ({
  resolvePrimaryEnvironmentHttpUrl: (pathname: string) => `http://127.0.0.1:3773${pathname}`,
}));

vi.mock("./clientTracingExporter", async () => {
  exporter.moduleLoads += 1;
  const { Tracer } = await import("effect");
  return {
    startClientTracingExporter: async (input: { url: string; exportIntervalMs: number }) => {
      exporter.starts.push(input);
      return {
        tracer: Tracer.make({
          span(options) {
            exporter.spans.push(options.name);
            return new Tracer.NativeSpan(options);
          },
        }),
        dispose: async () => {
          exporter.disposals += 1;
        },
      };
    },
  };
});

import {
  __resetClientTracingForTests,
  ClientTracingLive,
  configureClientTracing,
} from "./clientTracing";

function runTracedSpan(name: string): Promise<void> {
  return Effect.runPromise(
    Effect.void.pipe(Effect.withSpan(name), Effect.provide(ClientTracingLive)),
  );
}

afterEach(async () => {
  await __resetClientTracingForTests();
  exporter.starts.length = 0;
  exporter.spans.length = 0;
  exporter.disposals = 0;
});

describe("client tracing", () => {
  it("records native spans without loading the OTLP exporter until configured", async () => {
    await runTracedSpan("before-configure");

    expect(exporter.moduleLoads).toBe(0);
    expect(exporter.spans).toEqual([]);
  });

  it("loads the exporter on configure and exports on the server's 10 s interval", async () => {
    await configureClientTracing();
    await runTracedSpan("after-configure");

    expect(exporter.moduleLoads).toBe(1);
    expect(exporter.starts).toEqual([
      { url: "http://127.0.0.1:3773/api/observability/v1/traces", exportIntervalMs: 10_000 },
    ]);
    expect(exporter.spans).toEqual(["after-configure"]);
  });

  it("replaces and disposes the exporter when the interval changes", async () => {
    await configureClientTracing();
    await configureClientTracing();
    expect(exporter.starts).toHaveLength(1);

    await configureClientTracing({ exportIntervalMs: 50 });

    expect(exporter.starts.map((start) => start.exportIntervalMs)).toEqual([10_000, 50]);
    expect(exporter.disposals).toBe(1);
  });
});
