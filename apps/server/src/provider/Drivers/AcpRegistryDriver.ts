import {
  AcpRegistrySettings,
  ProviderDriverKind,
  TextGenerationError,
  type ServerProvider,
  type ServerProviderModel,
} from "@ryco/contracts";
import { Effect, FileSystem, Path, PubSub, Ref, Schema, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { ServerConfig } from "../../config.ts";
import { ProviderDriverError } from "../Errors.ts";
import { makeAcpAdapter } from "../Layers/AcpAdapter.ts";
import { ProviderEventLoggers } from "../Layers/ProviderEventLoggers.ts";
import { defaultProviderContinuationIdentity, type ProviderDriver } from "../ProviderDriver.ts";
import { mergeProviderInstanceEnvironment } from "../ProviderInstanceEnvironment.ts";
import { makeManualOnlyProviderMaintenanceCapabilities } from "../providerMaintenance.ts";
import {
  makeRegistryAcpRuntime,
  resolveAcpRegistryInstallation,
} from "../acp/AcpRegistrySupport.ts";
import type { TextGenerationShape } from "../../textGeneration/TextGeneration.ts";

const DRIVER = ProviderDriverKind.make("acpRegistry");
const EMPTY_ACP_CAPABILITIES = {
  loadSession: false,
  resumeSession: false,
  models: false,
  commands: false,
  usage: false,
  terminal: false,
  promptImages: false,
  promptAudio: false,
};
const DEFAULT_ACP_MODELS: ServerProviderModel[] = [
  {
    slug: "default",
    name: "Agent default",
    isCustom: false,
    capabilities: { optionDescriptors: [] },
  },
];
export function projectAcpRegistrySession(
  value: ServerProvider,
  result: import("../acp/AcpSessionRuntime.ts").AcpSessionRuntimeStartResult,
): ServerProvider {
  const capabilities = result.initializeResult.agentCapabilities;
  const models: ServerProviderModel[] = (result.sessionSetupResult.models?.availableModels ?? [])
    .filter((model) => model.modelId.trim())
    .map((model) => ({
      slug: model.modelId,
      name: model.name || model.modelId,
      isCustom: false,
      capabilities: { optionDescriptors: [] },
    }));
  const modelOption = result.sessionSetupResult.configOptions?.find(
    (option) => option.category === "model" && option.type === "select",
  );
  if (models.length === 0 && modelOption?.type === "select") {
    for (const option of modelOption.options.flatMap((entry) =>
      "value" in entry ? [entry] : entry.options,
    )) {
      if (option.value.trim())
        models.push({
          slug: option.value,
          name: option.name || option.value,
          isCustom: false,
          capabilities: { optionDescriptors: [] },
        });
    }
  }
  return {
    ...value,
    auth: { status: "authenticated" },
    status: "ready",
    message: "ACP session ready.",
    models: models.length > 0 ? models : DEFAULT_ACP_MODELS,
    acpCapabilities: {
      ...EMPTY_ACP_CAPABILITIES,
      ...value.acpCapabilities,
      loadSession: capabilities?.loadSession === true,
      resumeSession: capabilities?.sessionCapabilities?.resume != null,
      models: models.length > 0 || result.modelConfigId !== undefined,
      promptImages: capabilities?.promptCapabilities?.image === true,
      // Audio attachments currently use filesystem paths rather than ACP audio blocks.
      promptAudio: false,
    },
  };
}

export type AcpRegistryDriverEnv =
  | FileSystem.FileSystem
  | Path.Path
  | ServerConfig
  | ChildProcessSpawner.ChildProcessSpawner
  | ProviderEventLoggers;

export const AcpRegistryDriver: ProviderDriver<AcpRegistrySettings, AcpRegistryDriverEnv> = {
  driverKind: DRIVER,
  metadata: { displayName: "ACP Registry", supportsMultipleInstances: true },
  configSchema: AcpRegistrySettings,
  defaultConfig: () => Schema.decodeSync(AcpRegistrySettings)({}),
  create: (input) =>
    Effect.gen(function* () {
      const environment = mergeProviderInstanceEnvironment(input.environment);
      const server = yield* ServerConfig;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const loggers = yield* ProviderEventLoggers;
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: DRIVER,
        instanceId: input.instanceId,
      });
      const changes = yield* PubSub.sliding<ServerProvider>(1);
      yield* Effect.addFinalizer(() => PubSub.shutdown(changes));
      const initial: ServerProvider = {
        instanceId: input.instanceId,
        driver: DRIVER,
        displayName: input.displayName ?? (input.config.agentId || "ACP Registry"),
        ...(input.accentColor ? { accentColor: input.accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        enabled: input.enabled,
        installed: false,
        version: input.config.version || null,
        status: input.enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt: new Date().toISOString(),
        models: [
          {
            slug: "default",
            name: "Agent default",
            isCustom: false,
            capabilities: { optionDescriptors: [] },
          },
        ],
        slashCommands: [],
        skills: [],
        showInteractionModeToggle: false,
        supportsAskMode: false,
        supportsTurnSteering: false,
        message: "Install the pinned registry version to use this provider.",
        acpCapabilities: {
          loadSession: false,
          resumeSession: false,
          models: false,
          commands: false,
          usage: false,
          terminal: false,
          promptImages: false,
          promptAudio: false,
        },
      };
      const state = yield* Ref.make(initial);
      const publish = (f: (snapshot: ServerProvider) => ServerProvider) =>
        Ref.updateAndGet(state, f).pipe(
          Effect.tap((value) => PubSub.publish(changes, value)),
          Effect.asVoid,
        );
      const resolveInstalled = resolveAcpRegistryInstallation(input.config).pipe(
        Effect.provideService(ServerConfig, server),
        Effect.provideService(Path.Path, path),
      );
      const refresh = resolveInstalled.pipe(
        Effect.flatMap(() =>
          publish((value) => ({
            ...value,
            installed: true,
            status: input.enabled ? "ready" : "disabled",
            message: input.enabled
              ? "Installed and verified. Capabilities are discovered when a session starts."
              : "Provider is disabled.",
            checkedAt: new Date().toISOString(),
          })),
        ),
        Effect.catch(() =>
          publish((value) => ({
            ...value,
            installed: false,
            status: input.enabled ? "warning" : "disabled",
            message: "Install the pinned registry version to use this provider.",
            checkedAt: new Date().toISOString(),
          })),
        ),
        Effect.andThen(Ref.get(state)),
      );
      yield* refresh;
      let sessionModelSwitch: "in-session" | "unsupported" = "unsupported";
      const adapter = yield* makeAcpAdapter({
        getSessionModelSwitch: () => sessionModelSwitch,
        respectPromptCapabilities: true,
        provider: DRIVER,
        instanceId: input.instanceId,
        environment,
        normalizeModel: (model) => (model === "default" ? "" : model.trim()),
        ...(loggers.native ? { nativeEventLogger: loggers.native } : {}),
        makeRuntime: (options) =>
          Effect.gen(function* () {
            // Verify the local manifest and executable before every spawn; no install/network fallback.
            const installed = yield* resolveInstalled;
            return yield* makeRegistryAcpRuntime({
              settings: input.config,
              installed,
              environment,
              options,
            }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
          }),
        onStarted: (result) => {
          sessionModelSwitch =
            result.sessionSetupResult.models || result.modelConfigId ? "in-session" : "unsupported";
          return publish((value) => projectAcpRegistrySession(value, result));
        },
        onCommands: (commands) =>
          publish((value) => ({
            ...value,
            slashCommands: commands
              .filter((command) => command.name.trim())
              .map((command) => ({
                name: command.name,
                ...(command.description ? { description: command.description } : {}),
                ...(command.input?.hint ? { input: { hint: command.input.hint } } : {}),
              })),
            acpCapabilities: {
              ...initial.acpCapabilities!,
              ...value.acpCapabilities,
              commands: true,
            },
          })),
        onUsage: () =>
          publish((value) => ({
            ...value,
            acpCapabilities: { ...initial.acpCapabilities!, ...value.acpCapabilities, usage: true },
          })),
      });
      const unsupported = (operation: keyof TextGenerationShape) =>
        Effect.fail(
          new TextGenerationError({
            operation,
            detail: "This ACP provider does not support background text generation.",
          }),
        );
      const textGeneration: TextGenerationShape = {
        answerSideQuestion: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "answerSideQuestion",
              detail:
                "ACP Registry agents do not provide an enforceable tool-free side question mode. Select Codex, Claude, or GitHub Copilot for side chat.",
            }),
          ),
        generateCommitMessage: () => unsupported("generateCommitMessage"),
        generatePrContent: () => unsupported("generatePrContent"),
        generateBranchName: () => unsupported("generateBranchName"),
        generateThreadTitle: () => unsupported("generateThreadTitle"),
        generateIssueContent: () => unsupported("generateIssueContent"),
        rankInboxThreads: () => unsupported("rankInboxThreads"),
      };
      return {
        instanceId: input.instanceId,
        driverKind: DRIVER,
        continuationIdentity,
        displayName: input.displayName,
        accentColor: input.accentColor,
        enabled: input.enabled,
        adapter,
        textGeneration,
        snapshot: {
          maintenanceCapabilities: makeManualOnlyProviderMaintenanceCapabilities({
            provider: DRIVER,
            packageName: null,
          }),
          getSnapshot: Ref.get(state),
          refresh,
          revalidate: refresh,
          streamChanges: Stream.fromPubSub(changes),
        },
      };
    }).pipe(
      Effect.mapError(
        (cause) =>
          new ProviderDriverError({
            driver: DRIVER,
            instanceId: input.instanceId,
            detail: "Failed to create ACP registry provider.",
            cause,
          }),
      ),
    ),
};
