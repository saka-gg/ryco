import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { ProviderInstanceId } from "@ryco/contracts";
import { ServerConfig } from "../../config.ts";
import { ProviderEventLoggers, NoOpProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { AcpRegistryDriver, projectAcpRegistrySession } from "./AcpRegistryDriver.ts";

const layer = ServerConfig.layerTest(process.cwd(), { prefix: "ryco-registry-driver-test-" }).pipe(
  Layer.provideMerge(NodeServices.layer),
  Layer.provideMerge(Layer.succeed(ProviderEventLoggers, NoOpProviderEventLoggers)),
);
const makeDriver = (enabled = true) =>
  AcpRegistryDriver.create({
    instanceId: ProviderInstanceId.make("registry-test"),
    displayName: undefined,
    environment: [],
    enabled,
    config: { agentId: "not-installed", version: "1.0.0" },
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
});
