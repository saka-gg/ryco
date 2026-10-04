import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { beforeEach } from "vite-plus/test";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";

import { OpenCodeSettings } from "@ryco/contracts";
import { ServerConfig } from "../../config.ts";
import {
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { OPENCODE_NON_JSON_HEALTH_MESSAGE } from "../openCodeVersion.ts";
import { checkOpenCodeProviderStatus } from "./OpenCodeProvider.ts";
import type { OpenCodeInventory } from "../opencodeRuntime.ts";

const DEFAULT_VERSION_STDOUT = "opencode 1.14.19\n";
const DEFAULT_HEALTH_DATA = { healthy: true, version: "1.18.18" };

/**
 * The legacy `OpenCodeProviderLive` Layer + `OpenCodeProvider` service tag
 * are deleted. The snapshot-producing logic they wrapped now lives in the
 * standalone `checkOpenCodeProviderStatus(settings, cwd)` Effect, which
 * drivers call directly when building their per-instance snapshot
 * `ServerProviderShape`. Tests mirror that shape: build a settings payload,
 * invoke the check, assert on the returned snapshot.
 */

const runtimeMock = {
  state: {
    runVersionError: null as Error | null,
    versionStdout: DEFAULT_VERSION_STDOUT,
    inventoryError: null as Error | null,
    closeCalls: 0,
    connectCalls: 0,
    healthData: DEFAULT_HEALTH_DATA as unknown,
    inventory: {
      providerList: { connected: [] as string[], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
    } as unknown,
  },
  reset() {
    this.state.runVersionError = null;
    this.state.versionStdout = DEFAULT_VERSION_STDOUT;
    this.state.inventoryError = null;
    this.state.closeCalls = 0;
    this.state.connectCalls = 0;
    this.state.healthData = DEFAULT_HEALTH_DATA;
    this.state.inventory = {
      providerList: { connected: [], all: [] as unknown[], default: {} },
      agents: [] as unknown[],
    };
  },
};

const OpenCodeRuntimeTestDouble: OpenCodeRuntimeShape = {
  startOpenCodeServerProcess: () =>
    Effect.succeed({
      url: "http://127.0.0.1:4301",
      exitCode: Effect.never,
    }),
  connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
    Effect.gen(function* () {
      runtimeMock.state.connectCalls += 1;
      if (!serverUrl) {
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            runtimeMock.state.closeCalls += 1;
          }),
        );
      }
      return {
        url: serverUrl ?? "http://127.0.0.1:4301",
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: null,
        external: Boolean(serverUrl),
      };
    }),
  runOpenCodeCommand: () =>
    runtimeMock.state.runVersionError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "runOpenCodeCommand",
            detail: runtimeMock.state.runVersionError.message,
            cause: runtimeMock.state.runVersionError,
          }),
        )
      : Effect.succeed({ stdout: runtimeMock.state.versionStdout, stderr: "", code: 0 }),
  createOpenCodeSdkClient: () =>
    Effect.succeed({
      global: {
        health: async () => ({ data: runtimeMock.state.healthData }),
      },
    } as unknown as OpencodeClient),
  loadOpenCodeInventory: () =>
    runtimeMock.state.inventoryError
      ? Effect.fail(
          new OpenCodeRuntimeError({
            operation: "loadOpenCodeInventory",
            detail: runtimeMock.state.inventoryError.message,
            cause: runtimeMock.state.inventoryError,
          }),
        )
      : Effect.succeed(runtimeMock.state.inventory as OpenCodeInventory),
};

beforeEach(() => {
  runtimeMock.reset();
});

const testLayer = Layer.succeed(OpenCodeRuntime, OpenCodeRuntimeTestDouble).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
  Layer.provideMerge(NodeServices.layer),
);

const makeOpenCodeSettings = (overrides?: Partial<OpenCodeSettings>): OpenCodeSettings =>
  Schema.decodeSync(OpenCodeSettings)({
    enabled: true,
    binaryPath: "opencode",
    serverUrl: "",
    serverPassword: "",
    customModels: [],
    ...overrides,
  });

it.layer(testLayer)("checkOpenCodeProviderStatus", (it) => {
  it.effect("shows a codex-style missing binary message", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("spawn opencode ENOENT");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, false);
      assert.equal(snapshot.message, "OpenCode CLI (`opencode`) is not installed or not on PATH.");
    }),
  );

  it.effect("explains a 2.x binary without connecting to it", () =>
    Effect.gen(function* () {
      runtimeMock.state.versionStdout = "opencode v2.0.18\n";
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.version, "2.0.18");
      assert.ok(snapshot.message?.includes("not supported yet"), snapshot.message);
      assert.equal(runtimeMock.state.connectCalls, 0);
    }),
  );

  it.effect("hides generic Effect.tryPromise text for local CLI probe failures", () =>
    Effect.gen(function* () {
      runtimeMock.state.runVersionError = new Error("An error occurred in Effect.tryPromise");
      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(snapshot.message, "Failed to execute OpenCode CLI health check.");
    }),
  );

  it.effect("emits OpenCode variant defaults so trait picker can resolve a visible selection", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                "gpt-5.4": {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  limit: { context: 128000, output: 4096 },
                  variants: {
                    none: {},
                    low: {},
                    medium: {},
                    high: {},
                    xhigh: {},
                    preview: { disabled: true },
                  },
                },
              },
            },
          ],
          default: {},
        },
        agents: [
          { name: "build", hidden: false, mode: "primary" },
          { name: "build", hidden: false, mode: "primary" },
          { name: "plan", hidden: false, mode: "primary" },
          { name: "internal", hidden: true, mode: "primary" },
        ],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());
      const model = snapshot.models.find((entry) => entry.slug === "openai/gpt-5.4");

      assert.ok(model);
      assert.equal(model.maxContextTokens, 128000);
      const variantDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "variant" && descriptor.type === "select",
      );
      assert.ok(variantDescriptor && variantDescriptor.type === "select");
      assert.equal(
        variantDescriptor.options.find((option) => option.isDefault === true)?.id,
        "medium",
      );
      assert.equal(
        variantDescriptor.options.some((option) => option.id === "preview"),
        false,
      );
      const agentDescriptor = model.capabilities?.optionDescriptors?.find(
        (descriptor) => descriptor.id === "agent" && descriptor.type === "select",
      );
      assert.ok(agentDescriptor && agentDescriptor.type === "select");
      assert.equal(
        agentDescriptor.options.find((option) => option.isDefault === true)?.id,
        "build",
      );
      assert.deepEqual(
        agentDescriptor.options.map((option) => option.id),
        ["build", "plan"],
      );
    }),
  );

  it.effect("deduplicates repeated model catalog entries by provider and model id", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventory = {
        providerList: {
          connected: ["openai"],
          all: [
            {
              id: "openai",
              name: "OpenAI",
              models: {
                primary: { id: "gpt-5", name: "GPT-5" },
              },
            },
            {
              id: "openai",
              name: "OpenAI duplicate",
              models: {
                duplicate: { id: "gpt-5", name: "GPT-5 duplicate" },
              },
            },
          ],
          default: {},
        },
        agents: [],
      };

      const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.deepEqual(
        snapshot.models.filter((entry) => entry.slug === "openai/gpt-5").map((entry) => entry.name),
        ["GPT-5"],
      );
    }),
  );

  it.effect("closes the local OpenCode server scope after provider refresh", () =>
    Effect.gen(function* () {
      yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

      assert.equal(runtimeMock.state.closeCalls, 1);
    }),
  );

  it.effect("forwards Go usage limits from the usage probe onto the snapshot", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        process.env,
        () =>
          Effect.succeed({
            limitId: "opencode-go",
            limitName: "OpenCode Go",
            planType: "go",
            primary: { usedPercent: 4, windowDurationMins: 300 },
            secondary: { usedPercent: 11, windowDurationMins: 7 * 24 * 60 },
            tertiary: { usedPercent: 11, windowDurationMins: 30 * 24 * 60 },
          }),
      );

      assert.deepEqual(snapshot.rateLimits, {
        limitId: "opencode-go",
        limitName: "OpenCode Go",
        planType: "go",
        primary: { usedPercent: 4, windowDurationMins: 300 },
        secondary: { usedPercent: 11, windowDurationMins: 7 * 24 * 60 },
        tertiary: { usedPercent: 11, windowDurationMins: 30 * 24 * 60 },
      });
    }),
  );

  it.effect("omits rateLimits when the usage probe finds none", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings(),
        process.cwd(),
        process.env,
        () => Effect.succeed(undefined),
      );

      assert.equal(snapshot.rateLimits, undefined);
    }),
  );

  it.effect(
    "derives a shortName by stripping the redundant subProvider prefix from the model name",
    () =>
      Effect.gen(function* () {
        runtimeMock.state.inventory = {
          providerList: {
            connected: ["deepseek", "openai"],
            all: [
              {
                id: "deepseek",
                name: "DeepSeek",
                models: {
                  "v4-pro": { id: "v4-pro", name: "DeepSeek V4 Pro" },
                },
              },
              {
                id: "openai",
                name: "OpenAI",
                models: {
                  "gpt-5": { id: "gpt-5", name: "GPT-5" },
                },
              },
            ],
            default: {},
          },
          agents: [{ name: "build", hidden: false, mode: "primary" }],
        };

        const snapshot = yield* checkOpenCodeProviderStatus(makeOpenCodeSettings(), process.cwd());

        const deepseek = snapshot.models.find((entry) => entry.slug === "deepseek/v4-pro");
        assert.ok(deepseek);
        assert.equal(deepseek.name, "DeepSeek V4 Pro");
        assert.equal(deepseek.shortName, "V4 Pro");
        assert.equal(deepseek.maxContextTokens, undefined);

        const openai = snapshot.models.find((entry) => entry.slug === "openai/gpt-5");
        assert.ok(openai);
        assert.equal(openai.name, "GPT-5");
        assert.equal(openai.shortName, undefined);
      }),
  );
});

it.layer(testLayer)("checkOpenCodeProviderStatus with configured server URL", (it) => {
  it.effect("surfaces a friendly auth error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error("401 Unauthorized");
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(
        snapshot.message,
        "OpenCode server rejected authentication. Check the server URL and password.",
      );
    }),
  );

  it.effect("explains a 2.x configured server verbatim", () =>
    Effect.gen(function* () {
      runtimeMock.state.healthData = { healthy: true, version: "2.0.18" };
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
        process.cwd(),
      );

      assert.equal(snapshot.status, "error");
      assert.ok(snapshot.message?.startsWith("The OpenCode server reports v2.0.18."));
    }),
  );

  it.effect("names an HTML health response from a configured server", () =>
    Effect.gen(function* () {
      runtimeMock.state.healthData = "<!doctype html>";
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({ serverUrl: "http://127.0.0.1:9999" }),
        process.cwd(),
      );

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.message, OPENCODE_NON_JSON_HEALTH_MESSAGE);
    }),
  );

  it.effect("surfaces a friendly connection error for configured servers", () =>
    Effect.gen(function* () {
      runtimeMock.state.inventoryError = new Error(
        "fetch failed: connect ECONNREFUSED 127.0.0.1:9999",
      );
      const snapshot = yield* checkOpenCodeProviderStatus(
        makeOpenCodeSettings({
          serverUrl: "http://127.0.0.1:9999",
          serverPassword: "secret-password",
        }),
        process.cwd(),
      );

      assert.equal(snapshot.status, "error");
      assert.equal(snapshot.installed, true);
      assert.equal(
        snapshot.message,
        "Couldn't reach the configured OpenCode server at http://127.0.0.1:9999. Check that the server is running and the URL is correct.",
      );
    }),
  );
});
