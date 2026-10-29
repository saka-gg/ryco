import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@ryco/contracts";
import { Effect, Layer } from "effect";
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
import { ClaudeDriver } from "./ClaudeDriver.ts";

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
