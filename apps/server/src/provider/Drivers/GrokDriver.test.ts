import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ServerProvider } from "@ryco/contracts";
import { Effect, FileSystem, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { ChildProcessSpawner } from "effect/process";
import { TestClock } from "effect/testing";
import { afterEach, vi } from "vite-plus/test";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { GROK_ALTERNATE_AUTH_VARIABLES, GrokAccountReadOptions } from "../Layers/GrokUsage.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AgentProcessPriorityOffLive } from "../agentProcessPriority.ts";
import { GrokDriver } from "./GrokDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "grok-driver-test" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        Effect.succeed(HttpClientResponse.fromWeb(request, Response.json({ version: "0.0.0" }))),
      ),
    ),
  ),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(AgentProcessPriorityOffLive),
  Layer.provideMerge(ServerSettingsService.layerTest()),
);

const NOW_MS = Date.parse("2026-09-16T00:00:00.000Z");
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const WEEKLY_PERIOD = {
  type: "USAGE_PERIOD_TYPE_WEEKLY",
  start: "2026-09-11T03:10:30.159171+00:00",
  end: "2026-09-18T03:10:30.159171+00:00",
};

// The runner's own Grok sign-in and auth settings, blanked in the instance environment so they
// never reach the read: only the test's temporary login counts.
const RUNNER_GROK_AUTH_VARIABLES = ["XAI_API_KEY", "GROK_AUTH", ...GROK_ALTERNATE_AUTH_VARIABLES];

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GrokDriver", () => {
  it.effect("never probes in the background; probes stay demand-driven", () =>
    Effect.gen(function* () {
      // Its probe fingerprint stats the login file: a temporary home keeps that off `~/.grok`.
      const fs = yield* FileSystem.FileSystem;
      const grokHome = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-grok-driver-" });
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok"),
        displayName: undefined,
        environment: [{ name: "GROK_HOME", value: grokHome, sensitive: false }],
        enabled: false,
        config: GrokDriver.defaultConfig(),
      });
      const isFresh = instance.snapshot.isFresh ?? Effect.succeed(false);
      expect(yield* isFresh).toBe(false);

      // A periodic refresh would have probed by now and left a fresh snapshot.
      yield* TestClock.adjust("16 minutes");
      expect(yield* isFresh).toBe(false);

      // Demand still probes.
      yield* instance.snapshot.refresh;
      expect(yield* isFresh).toBe(true);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("re-reads a ready snapshot's credits over HTTP without starting grok", () => {
    let spawns = 0;
    const countingSpawner = ChildProcessSpawner.make(() =>
      Effect.sync(() => {
        spawns += 1;
      }).pipe(Effect.andThen(Effect.die("a usage re-read must not start grok"))),
    );
    const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(url),
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({ config: { creditUsagePercent: 41, currentPeriod: WEEKLY_PERIOD } });
    }) as typeof globalThis.fetch;
    // Every request goes through the injected fetch; nothing leaves the machine.
    vi.stubGlobal("fetch", async () => {
      throw new Error("The driver test must not send a real request.");
    });

    return Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      // A login in a temporary Grok home, and an empty machine-wide config directory: the real
      // `~/.grok` and `/etc/grok` are never read.
      const fs = yield* FileSystem.FileSystem;
      const grokHome = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-grok-driver-" });
      const systemConfigDir = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-grok-etc-" });
      yield* fs.writeFileString(
        NodePath.join(grokHome, "auth.json"),
        JSON.stringify({
          "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828": {
            key: "session-token",
            email: "someone@example.com",
          },
        }),
      );
      const instance = yield* GrokDriver.create({
        instanceId: ProviderInstanceId.make("grok"),
        displayName: undefined,
        environment: [
          { name: "GROK_HOME", value: grokHome, sensitive: false },
          ...RUNNER_GROK_AUTH_VARIABLES.map((name) => ({ name, value: "", sensitive: false })),
        ],
        enabled: true,
        config: GrokDriver.defaultConfig(),
      }).pipe(Effect.provideService(GrokAccountReadOptions, { systemConfigDir, fetchImpl }));

      // A ready snapshot from an earlier probe, whose usage read is due again.
      const pending = yield* instance.snapshot.getSnapshot;
      const ready: ServerProvider = {
        ...pending,
        installed: true,
        version: "0.0.99",
        status: "ready",
        auth: { status: "authenticated", email: "someone@example.com" },
        checkedAt: new Date(NOW_MS - 6 * 60_000).toISOString(),
        rateLimits: {
          limitId: "grok-credits",
          windows: [{ id: "credits", usedPercent: 12, windowDurationMins: 10_080 }],
          observedAt: new Date(NOW_MS - 6 * 60_000).toISOString(),
        },
      };
      const adopted = yield* instance.snapshot.adoptPersistedSnapshot!({
        snapshot: ready,
        checkedAtMs: NOW_MS - 6 * 60_000,
      });
      expect(adopted).toBe(true);

      const refreshed = yield* instance.snapshot.revalidate;

      expect(spawns).toBe(0);
      expect(requests).toEqual([{ url: BILLING_URL, authorization: "Bearer session-token" }]);
      expect(refreshed.status).toBe("ready");
      expect(refreshed.auth).toEqual({ status: "authenticated", email: "someone@example.com" });
      expect(refreshed.rateLimits?.windows).toEqual([
        {
          id: "credits",
          usedPercent: 41,
          resetsAt: Math.floor(Date.parse(WEEKLY_PERIOD.end) / 1000),
          windowDurationMins: 10_080,
        },
      ]);
      expect(refreshed.rateLimits?.observedAt).toBe("2026-09-16T00:00:00.000Z");
      // The re-read stays current; the probe's models and version are kept.
      expect(refreshed.version).toBe("0.0.99");
      expect(yield* instance.snapshot.isFresh ?? Effect.succeed(false)).toBe(true);
    }).pipe(
      Effect.scoped,
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, countingSpawner),
      Effect.provide(testLayer),
    );
  });
});
