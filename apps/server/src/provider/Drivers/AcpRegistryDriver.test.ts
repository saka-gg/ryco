// @effect-diagnostics nodeBuiltinImport:off
import { basename } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import { AcpRegistrySettings, ProviderInstanceId } from "@ryco/contracts";
import { ServerConfig } from "../../config.ts";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AgentProcessPriorityOffLive } from "../agentProcessPriority.ts";
import {
  AcpRegistryDriver,
  projectAcpRegistryCommands,
  projectAcpRegistrySession,
} from "./AcpRegistryDriver.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "ryco-registry-driver-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
  Layer.provideMerge(AgentProcessPriorityOffLive),
);
const decodeConfig = Schema.decodeUnknownSync(AcpRegistrySettings);
const makeDriver = (
  enabled = true,
  config: unknown = { agentId: "not-installed", version: "1.0.0" },
) =>
  AcpRegistryDriver.create({
    instanceId: ProviderInstanceId.make("registry-test"),
    displayName: undefined,
    environment: [],
    enabled,
    config: decodeConfig(config),
  });

it.layer(layer)("ACP registry driver", (it) => {
  it.effect(
    "uninstalled provider initializes with selectable default and no claimed capabilities",
    () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const snapshot = yield* driver.snapshot.getSnapshot;
        assert.isFalse(snapshot.installed);
        assert.deepStrictEqual(
          snapshot.models.map((model) => model.slug),
          ["default"],
        );
        assert.isTrue(Object.values(snapshot.acpCapabilities!).every((value) => value === false));
        assert.deepStrictEqual(yield* driver.adapter.listSessions(), []);
      }),
  );
  it.effect("rejects side questions without starting an ACP session", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver();
      const error = yield* driver.textGeneration
        .answerSideQuestion({
          cwd: process.cwd(),
          context: "Completed context",
          question: "Explain this change",
          history: [],
          modelSelection: {
            instanceId: ProviderInstanceId.make("registry-test"),
            model: "default",
          },
        })
        .pipe(Effect.flip);
      assert.equal(error._tag, "TextGenerationError");
      assert.equal(error.operation, "answerSideQuestion");
      assert.include(error.detail, "tool-free side question mode");
      assert.deepStrictEqual(yield* driver.adapter.listSessions(), []);
    }),
  );
  it.effect("disabled provider reports disabled without starting any agent", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver(false);
      assert.equal((yield* driver.snapshot.refresh).status, "disabled");
      assert.deepStrictEqual(yield* driver.adapter.listSessions(), []);
    }),
  );
  it.effect("keeps the install warning for a registry agent that is not installed", () =>
    Effect.gen(function* () {
      const snapshot = yield* (yield* makeDriver()).snapshot.getSnapshot;
      assert.equal(snapshot.status, "warning");
      assert.equal(snapshot.version, "1.0.0");
      assert.equal(snapshot.message, "Install the pinned registry version to use this provider.");
    }),
  );
  it.effect("warns with the local command's own detail when it is missing", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver(true, {
        source: "local",
        command: "/nonexistent/ryco-acp-agent",
        args: ["--acp"],
      });
      const snapshot = yield* driver.snapshot.getSnapshot;
      assert.equal(snapshot.status, "warning");
      assert.isFalse(snapshot.installed);
      assert.equal(snapshot.message, "`/nonexistent/ryco-acp-agent` was not found on this node.");
      assert.equal(snapshot.displayName, "ryco-acp-agent");
      assert.deepStrictEqual(yield* driver.adapter.listSessions(), []);
    }),
  );
  it.effect("reports a local command that resolves as ready without starting it", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver(true, { source: "local", command: process.execPath });
      const snapshot = yield* driver.snapshot.refresh;
      assert.equal(snapshot.status, "ready");
      assert.isTrue(snapshot.installed);
      assert.isNull(snapshot.version);
      // The executable's basename: `node` for the runtime running this test.
      assert.equal(snapshot.displayName, basename(process.execPath).replace(/\.exe$/iu, ""));
      assert.equal(
        snapshot.message,
        "Command found. Capabilities are discovered when a session starts.",
      );
      assert.deepStrictEqual(yield* driver.adapter.listSessions(), []);
    }),
  );
  it.effect("reports a disabled local command as disabled", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver(false, { source: "local", command: process.execPath });
      assert.equal((yield* driver.snapshot.refresh).status, "disabled");
    }),
  );
  it.effect("takes a local agent's version from its handshake, never a registry pin", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver(true, { source: "local", command: process.execPath });
      const initial = yield* driver.snapshot.getSnapshot;
      const started = (version: string | undefined) => ({
        sessionId: "s",
        initializeResult: {
          protocolVersion: 1,
          ...(version === undefined ? {} : { agentInfo: { name: "agent", version } }),
        },
        sessionSetupResult: { sessionId: "s" },
        modelConfigId: undefined,
      });
      assert.equal(
        projectAcpRegistrySession(initial, started(" 2.1.0 "), "local").version,
        "2.1.0",
      );
      assert.isNull(projectAcpRegistrySession(initial, started(undefined), "local").version);
      assert.isNull(projectAcpRegistrySession(initial, started("x".repeat(65)), "local").version);
      assert.isNull(projectAcpRegistrySession(initial, started("   "), "local").version);
      const registry = yield* (yield* makeDriver()).snapshot.getSnapshot;
      assert.equal(projectAcpRegistrySession(registry, started("9.9.9")).version, "1.0.0");
    }),
  );
  it.effect(
    "projects advertised models, transport capabilities and preserves observed command/usage flags",
    () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const initial = yield* driver.snapshot.getSnapshot;
        const projected = projectAcpRegistrySession(
          {
            ...initial,
            acpCapabilities: { ...initial.acpCapabilities!, commands: true, usage: true },
          },
          {
            sessionId: "s",
            initializeResult: {
              protocolVersion: 1,
              agentCapabilities: {
                loadSession: true,
                sessionCapabilities: { resume: {} },
                promptCapabilities: { image: true, audio: true },
              },
            },
            sessionSetupResult: {
              sessionId: "s",
              models: {
                currentModelId: "native",
                availableModels: [{ modelId: "native", name: "Native" }],
              },
            },
            modelConfigId: undefined,
          },
        );
        assert.deepStrictEqual(
          projected.models.map((model) => model.slug),
          ["native"],
        );
        assert.deepStrictEqual(projected.acpCapabilities, {
          loadSession: true,
          resumeSession: true,
          models: true,
          commands: true,
          usage: true,
          terminal: false,
          promptImages: true,
          promptAudio: false,
        });
        assert.equal(projected.auth.status, "authenticated");
      }),
  );
  it.effect(
    "projects modern grouped model configuration without claiming unsupported capabilities",
    () =>
      Effect.gen(function* () {
        const driver = yield* makeDriver();
        const initial = yield* driver.snapshot.getSnapshot;
        const projected = projectAcpRegistrySession(initial, {
          sessionId: "s",
          initializeResult: { protocolVersion: 1 },
          modelConfigId: "model",
          sessionSetupResult: {
            sessionId: "s",
            configOptions: [
              {
                id: "model",
                name: "Model",
                category: "model",
                type: "select",
                currentValue: "a",
                options: [
                  { group: "vendor", name: "Vendor", options: [{ value: "a", name: "Model A" }] },
                ],
              },
            ],
          },
        });
        assert.deepStrictEqual(
          projected.models.map((model) => model.slug),
          ["a"],
        );
        assert.isTrue(projected.acpCapabilities!.models);
        assert.isFalse(projected.acpCapabilities!.loadSession);
        assert.isFalse(projected.acpCapabilities!.commands);
        assert.isFalse(projected.acpCapabilities!.usage);
      }),
  );
  it.effect("publishes advertised commands trimmed, without blank descriptions or hints", () =>
    Effect.gen(function* () {
      const driver = yield* makeDriver();
      const initial = yield* driver.snapshot.getSnapshot;
      const projected = projectAcpRegistryCommands(initial, [
        { name: " /review ", description: " Review a PR ", input: { hint: " <pr> " } },
        { name: "plan", description: "   ", input: { hint: " " } },
        { name: "  ", description: "nameless" },
      ]);
      assert.deepStrictEqual(projected.slashCommands, [
        { name: "review", description: "Review a PR", input: { hint: "<pr>" } },
        { name: "plan" },
      ]);
      assert.isTrue(projected.acpCapabilities!.commands);
      assert.isFalse(projected.acpCapabilities!.usage);
    }),
  );
});
