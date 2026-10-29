import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@ryco/contracts";
import { Cache, Duration, Effect, Layer } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";
import { afterAll, beforeEach, vi } from "vitest";

const mocks = vi.hoisted(() => ({ query: vi.fn() }));
vi.mock("@anthropic-ai/claude-agent-sdk", async (original) => ({
  ...(await original<typeof import("@anthropic-ai/claude-agent-sdk")>()),
  query: mocks.query,
}));

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { NoOpProviderEventLoggers, ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AgentProcessPriorityOffLive } from "../agentProcessPriority.ts";
import { ClaudeDriver, readClaudeCapabilities } from "./ClaudeDriver.ts";

const testLayer = ServerConfig.layerTest(process.cwd(), { prefix: "claude-driver-test" }).pipe(
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

// A `claude` that only answers `--version`, under a HOME of its own so no real login is read.
const sandbox = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-claude-driver-"));
const binaryPath = NodePath.join(sandbox, "claude");
NodeFS.writeFileSync(binaryPath, '#!/bin/sh\necho "2.1.288 (Claude Code)"\n', { mode: 0o755 });
afterAll(() => NodeFS.rmSync(sandbox, { recursive: true, force: true }));

let account: Record<string, string> = {};
beforeEach(() => {
  mocks.query.mockReset();
  mocks.query.mockImplementation(() => ({
    initializationResult: async () => ({ account, commands: [] }),
  }));
});

const createInstance = ClaudeDriver.create({
  instanceId: ProviderInstanceId.make("claude"),
  displayName: undefined,
  accentColor: undefined,
  environment: [{ name: "HOME", value: sandbox, sensitive: false }],
  enabled: true,
  config: { ...ClaudeDriver.defaultConfig(), binaryPath },
});

describe("ClaudeDriver", () => {
  it.effect("re-probes after a signed-out answer, so a refresh sees a new login", () =>
    Effect.gen(function* () {
      const instance = yield* createInstance;
      account = { tokenSource: "none", apiProvider: "firstParty" };
      const signedOut = yield* instance.snapshot.refresh;
      expect(signedOut.auth.status).toBe("unauthenticated");

      // `claude auth login`, then Refresh provider status.
      account = { tokenSource: "claude.ai", apiProvider: "firstParty" };
      const signedIn = yield* instance.snapshot.refresh;
      expect(signedIn.auth.status).toBe("authenticated");
      expect(mocks.query).toHaveBeenCalledTimes(2);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );

  it.effect("keeps reusing an authenticated probe, CLIProxyAPI tokens included", () =>
    Effect.gen(function* () {
      const instance = yield* createInstance;
      account = { tokenSource: "ANTHROPIC_AUTH_TOKEN", apiProvider: "firstParty" };
      expect((yield* instance.snapshot.refresh).auth.status).toBe("authenticated");
      expect((yield* instance.snapshot.refresh).auth.status).toBe("authenticated");
      expect(mocks.query).toHaveBeenCalledTimes(1);
    }).pipe(Effect.scoped, Effect.provide(testLayer)),
  );
});

type Report = {
  readonly email?: string | undefined;
  readonly subscriptionType?: string | undefined;
  readonly tokenSource?: string | undefined;
};

/** A capabilities cache like the driver's, over probes that answer `reports` in turn. */
const probes = (reports: ReadonlyArray<Report | undefined>) =>
  Effect.gen(function* () {
    let calls = 0;
    const cache = yield* Cache.make({
      capacity: 1,
      timeToLive: Duration.minutes(5),
      lookup: () => Effect.sync(() => reports[Math.min(calls++, reports.length - 1)]),
    });
    return { read: readClaudeCapabilities(cache, "claude\0/home/a"), calls: () => calls };
  });

describe("readClaudeCapabilities", () => {
  it.effect("probes again after a result without an account, so a new login shows at once", () =>
    Effect.gen(function* () {
      const { read, calls } = yield* probes([{}, { subscriptionType: "max" }]);

      assert.deepEqual(yield* read, {});
      assert.deepEqual(yield* read, { subscriptionType: "max" });
      assert.equal(calls(), 2);
    }),
  );

  it.effect("keeps a result that names an account for the cache's lifetime", () =>
    Effect.gen(function* () {
      for (const report of [
        { email: "a@example.com" },
        { subscriptionType: "pro" },
        { tokenSource: "ANTHROPIC_API_KEY" },
      ]) {
        const { read, calls } = yield* probes([report, {}]);
        yield* read;
        assert.deepEqual(yield* read, report);
        assert.equal(calls(), 1);
      }
    }),
  );

  it.effect("probes again after a probe that failed", () =>
    Effect.gen(function* () {
      const { read, calls } = yield* probes([undefined, { email: "a@example.com" }]);

      assert.isUndefined(yield* read);
      assert.deepEqual(yield* read, { email: "a@example.com" });
      assert.equal(calls(), 2);
    }),
  );
});
