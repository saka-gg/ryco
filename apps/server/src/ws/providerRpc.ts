import * as NodePath from "node:path";
import { AcpRegistryOperationError, AcpRegistrySettings } from "@ryco/contracts";
import { makeAcpRegistryCatalog } from "../provider/acp/AcpRegistryCatalog.ts";
import {
  getAcpRegistryAuthMethods,
  authenticateAcpRegistry,
} from "../provider/acp/AcpRegistrySupport.ts";
import { mergeProviderInstanceEnvironment } from "../provider/ProviderInstanceEnvironment.ts";
import {
  readResourceTelemetryHistory,
  retryResourceTelemetry,
} from "../diagnostics/ResourceTelemetry.ts";
import { Duration, Effect, Ref, Stream, Schema } from "effect";
import { type AuthAccessStreamEvent, TextGenerationError, WS_METHODS } from "@ryco/contracts";

import { signalDiagnosticProcess } from "../diagnostics/ProcessDiagnostics.ts";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation.ts";
import {
  checkOpinionatedPlugins,
  installOpinionatedPlugin,
  listOpinionatedPlugins,
} from "../opinionatedPlugins.ts";
import { redactServerSettingsForClient } from "../serverSettings.ts";
import type { BootstrapCredentialChange } from "../auth/Services/BootstrapCredentialService.ts";
import type { SessionCredentialChange } from "../auth/Services/SessionCredentialService.ts";
import {
  defineWsHandlers,
  PROVIDER_STATUS_DEBOUNCE_MS,
  toAuthAccessStreamEvent,
  toOpinionatedPluginRpcError,
  type WsRpcContext,
} from "./context.ts";

export const makeProviderHandlers = (ctx: WsRpcContext) => {
  const {
    ownerEffect,
    directOwnerStreamEffect,
    providerRegistry,
    providerMaintenanceRunner,
    keybindings,
    serverSettings,
    sourceControlDiscovery,
    config,
    mcpRegistry,
    textGeneration,
    atlassian,
    workItems,
    lifecycleEvents,
    loadServerConfig,
    loadDiagnosticsMetrics,
    loadDiagnosticsSnapshot,
    loadAuthAccessSnapshot,
    loadAdvertisedEndpoints,
    bootstrapCredentials,
    sessions,
    currentSessionId,
  } = ctx;

  const registry = makeAcpRegistryCatalog({
    installationRoot: NodePath.join(config.stateDir, "acp-registry"),
  });
  const registryError = (cause: unknown) =>
    new AcpRegistryOperationError({
      // Do not expose environment variables, filesystem paths, or agent auth payloads.
      message:
        cause instanceof Error && !("code" in cause) && cause.message.startsWith("Registry ")
          ? cause.message
          : "ACP Registry operation failed. Check the selected version, installation, and provider authentication.",
    });
  const registryInstance = (instanceId: import("@ryco/contracts").ProviderInstanceId) =>
    Effect.gen(function* () {
      const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(registryError));
      const instance = settings.providerInstances[instanceId];
      if (!instance || instance.driver !== "acpRegistry" || !instance.enabled) {
        return yield* Effect.fail(
          new AcpRegistryOperationError({
            message: "Select an enabled ACP Registry provider instance.",
          }),
        );
      }
      const settingsConfig = yield* Schema.decodeUnknownEffect(AcpRegistrySettings)(
        instance.config ?? {},
      ).pipe(Effect.mapError(registryError));
      return {
        config: settingsConfig,
        environment: mergeProviderInstanceEnvironment(instance.environment),
      };
    });

  return defineWsHandlers({
    [WS_METHODS.serverSearchAcpRegistry]: (input) =>
      ownerEffect(
        WS_METHODS.serverSearchAcpRegistry,
        Effect.tryPromise({ try: () => registry.search(input.query), catch: registryError }).pipe(
          Effect.map((agents) => ({ agents })),
        ),
      ),
    [WS_METHODS.serverInstallAcpRegistry]: (input) =>
      ownerEffect(
        WS_METHODS.serverInstallAcpRegistry,
        Effect.tryPromise({ try: () => registry.install(input), catch: registryError }),
      ),
    [WS_METHODS.serverGetAcpRegistryAuthMethods]: (input) =>
      ownerEffect(
        WS_METHODS.serverGetAcpRegistryAuthMethods,
        Effect.gen(function* () {
          const instance = yield* registryInstance(input.instanceId);
          const methods = yield* getAcpRegistryAuthMethods(
            instance.config,
            instance.environment,
          ).pipe(Effect.mapError(registryError));
          return methods;
        }),
      ),
    [WS_METHODS.serverAuthenticateAcpRegistry]: (input) =>
      ownerEffect(
        WS_METHODS.serverAuthenticateAcpRegistry,
        Effect.gen(function* () {
          const instance = yield* registryInstance(input.instanceId);
          yield* authenticateAcpRegistry(
            instance.config,
            input.methodId,
            instance.environment,
          ).pipe(Effect.mapError(registryError));
          yield* providerRegistry.refreshInstance(input.instanceId);
          return { authenticated: true };
        }),
      ),
    [WS_METHODS.serverGetConfig]: (_input) =>
      observeRpcEffect(WS_METHODS.serverGetConfig, loadServerConfig, {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverGetAdvertisedEndpoints]: (_input) =>
      observeRpcEffect(WS_METHODS.serverGetAdvertisedEndpoints, loadAdvertisedEndpoints, {
        "rpc.aggregate": "server",
      }),
    [WS_METHODS.serverGetDiagnosticsMetrics]: (_input) =>
      observeRpcEffect(
        WS_METHODS.serverGetDiagnosticsMetrics,
        ownerEffect(WS_METHODS.serverGetDiagnosticsMetrics, loadDiagnosticsMetrics),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverGetDiagnosticsSnapshot]: (_input) =>
      observeRpcEffect(
        WS_METHODS.serverGetDiagnosticsSnapshot,
        ownerEffect(WS_METHODS.serverGetDiagnosticsSnapshot, loadDiagnosticsSnapshot),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverGetResourceTelemetryHistory]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverGetResourceTelemetryHistory,
        ownerEffect(
          WS_METHODS.serverGetResourceTelemetryHistory,
          Effect.promise(() => readResourceTelemetryHistory(input)),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverRetryResourceTelemetry]: () =>
      observeRpcEffect(
        WS_METHODS.serverRetryResourceTelemetry,
        ownerEffect(
          WS_METHODS.serverRetryResourceTelemetry,
          Effect.promise(() => retryResourceTelemetry()),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverSignalDiagnosticProcess]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverSignalDiagnosticProcess,
        ownerEffect(
          WS_METHODS.serverSignalDiagnosticProcess,
          Effect.promise(() => signalDiagnosticProcess(input)),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverRefreshProviders]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverRefreshProviders,
        ownerEffect(
          WS_METHODS.serverRefreshProviders,
          (input.instanceId !== undefined
            ? providerRegistry.refreshInstance(input.instanceId)
            : providerRegistry.refresh()
          ).pipe(Effect.map((providers) => ({ providers }))),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverUpdateProvider]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverUpdateProvider,
        ownerEffect(
          WS_METHODS.serverUpdateProvider,
          providerMaintenanceRunner.updateProvider(input),
        ),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverUpsertKeybinding]: (rule) =>
      observeRpcEffect(
        WS_METHODS.serverUpsertKeybinding,
        ownerEffect(
          WS_METHODS.serverUpsertKeybinding,
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.upsertKeybindingRule(rule);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.keybindingsReplaceCustom]: ({ rules }) =>
      observeRpcEffect(
        WS_METHODS.keybindingsReplaceCustom,
        ownerEffect(
          WS_METHODS.keybindingsReplaceCustom,
          Effect.gen(function* () {
            const keybindingsConfig = yield* keybindings.replaceCustomKeybindings(rules);
            return { keybindings: keybindingsConfig, issues: [] };
          }),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverGetSettings]: (_input) =>
      observeRpcEffect(
        WS_METHODS.serverGetSettings,
        serverSettings.getSettings.pipe(Effect.map(redactServerSettingsForClient)),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverUpdateSettings]: ({ patch }) =>
      observeRpcEffect(
        WS_METHODS.serverUpdateSettings,
        ownerEffect(
          WS_METHODS.serverUpdateSettings,
          serverSettings.updateSettings(patch).pipe(Effect.map(redactServerSettingsForClient)),
        ),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverDiscoverSourceControl]: (_input) =>
      observeRpcEffect(
        WS_METHODS.serverDiscoverSourceControl,
        ownerEffect(WS_METHODS.serverDiscoverSourceControl, sourceControlDiscovery.refresh),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverListOpinionatedPlugins]: (_input) =>
      observeRpcEffect(
        WS_METHODS.serverListOpinionatedPlugins,
        ownerEffect(
          WS_METHODS.serverListOpinionatedPlugins,
          Effect.sync(() => listOpinionatedPlugins()),
        ),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverCheckOpinionatedPlugins]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverCheckOpinionatedPlugins,
        ownerEffect(
          WS_METHODS.serverCheckOpinionatedPlugins,
          Effect.gen(function* () {
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.mapError(toOpinionatedPluginRpcError),
            );
            const providers = yield* providerRegistry.getProviders;
            return yield* Effect.tryPromise({
              try: () =>
                checkOpinionatedPlugins({
                  settings,
                  providers,
                  ...(input.pluginId ? { pluginId: input.pluginId } : {}),
                }),
              catch: toOpinionatedPluginRpcError,
            });
          }),
        ),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.serverInstallOpinionatedPlugin]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverInstallOpinionatedPlugin,
        ownerEffect(
          WS_METHODS.serverInstallOpinionatedPlugin,
          Effect.gen(function* () {
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.mapError(toOpinionatedPluginRpcError),
            );
            const providers = yield* providerRegistry.getProviders;
            const result = yield* Effect.tryPromise({
              try: () =>
                installOpinionatedPlugin({
                  request: input,
                  settings,
                  providers,
                  cwd: config.cwd,
                }),
              catch: toOpinionatedPluginRpcError,
            });
            yield* providerRegistry.refresh().pipe(Effect.ignore);
            return result;
          }),
        ),
        {
          "rpc.aggregate": "server",
        },
      ),
    [WS_METHODS.mcpListWorkspaces]: (_input) =>
      observeRpcEffect(
        WS_METHODS.mcpListWorkspaces,
        ownerEffect(WS_METHODS.mcpListWorkspaces, mcpRegistry.listWorkspaces),
        { "rpc.aggregate": "mcp" },
      ),
    [WS_METHODS.mcpListServers]: (input) =>
      observeRpcEffect(
        WS_METHODS.mcpListServers,
        ownerEffect(WS_METHODS.mcpListServers, mcpRegistry.listServers(input)),
        { "rpc.aggregate": "mcp" },
      ),
    [WS_METHODS.mcpUpsertServer]: (input) =>
      observeRpcEffect(
        WS_METHODS.mcpUpsertServer,
        ownerEffect(WS_METHODS.mcpUpsertServer, mcpRegistry.upsertServer(input)),
        { "rpc.aggregate": "mcp" },
      ),
    [WS_METHODS.mcpSetServerEnabled]: (input) =>
      observeRpcEffect(
        WS_METHODS.mcpSetServerEnabled,
        ownerEffect(WS_METHODS.mcpSetServerEnabled, mcpRegistry.setServerEnabled(input)),
        { "rpc.aggregate": "mcp" },
      ),
    [WS_METHODS.mcpRemoveServer]: (input) =>
      observeRpcEffect(
        WS_METHODS.mcpRemoveServer,
        ownerEffect(WS_METHODS.mcpRemoveServer, mcpRegistry.removeServer(input)),
        { "rpc.aggregate": "mcp" },
      ),
    [WS_METHODS.mcpReloadServers]: (input) =>
      observeRpcEffect(
        WS_METHODS.mcpReloadServers,
        ownerEffect(WS_METHODS.mcpReloadServers, mcpRegistry.reloadServers(input)),
        { "rpc.aggregate": "mcp" },
      ),
    [WS_METHODS.mcpStartOauthLogin]: (input) =>
      observeRpcEffect(
        WS_METHODS.mcpStartOauthLogin,
        ownerEffect(WS_METHODS.mcpStartOauthLogin, mcpRegistry.startOauthLogin(input)),
        { "rpc.aggregate": "mcp" },
      ),
    [WS_METHODS.textGenerationGenerateIssueContent]: (input) =>
      observeRpcEffect(
        WS_METHODS.textGenerationGenerateIssueContent,
        ownerEffect(
          WS_METHODS.textGenerationGenerateIssueContent,
          Effect.gen(function* () {
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation: "generateIssueContent",
                    detail: "Failed to load server settings for text generation model.",
                    cause,
                  }),
              ),
            );
            return yield* textGeneration.generateIssueContent(
              input.mode === "polish"
                ? {
                    cwd: input.cwd,
                    mode: "polish",
                    rough: input.rough ?? input.body ?? "",
                    ...(input.currentTitle !== undefined
                      ? { currentTitle: input.currentTitle }
                      : {}),
                    ...(input.customInstructions !== undefined
                      ? { customInstructions: input.customInstructions }
                      : {}),
                    modelSelection: settings.textGenerationModelSelection,
                  }
                : {
                    cwd: input.cwd,
                    mode: "title",
                    body: input.body ?? input.rough ?? "",
                    modelSelection: settings.textGenerationModelSelection,
                  },
            );
          }),
        ),
        {
          "rpc.aggregate": "text-generation",
        },
      ),
    [WS_METHODS.textGenerationGenerateBranchName]: (input) =>
      observeRpcEffect(
        WS_METHODS.textGenerationGenerateBranchName,
        ownerEffect(
          WS_METHODS.textGenerationGenerateBranchName,
          Effect.gen(function* () {
            const settings = yield* serverSettings.getSettings.pipe(
              Effect.mapError(
                (cause) =>
                  new TextGenerationError({
                    operation: "generateBranchName",
                    detail: "Failed to load server settings for text generation model.",
                    cause,
                  }),
              ),
            );
            const { branch } = yield* textGeneration.generateBranchName({
              cwd: input.cwd,
              message: input.message,
              modelSelection: settings.textGenerationModelSelection,
            });
            return { branch };
          }),
        ),
        {
          "rpc.aggregate": "text-generation",
        },
      ),
    [WS_METHODS.atlassianListConnections]: (_input) =>
      observeRpcEffect(
        WS_METHODS.atlassianListConnections,
        ownerEffect(WS_METHODS.atlassianListConnections, atlassian.listConnections),
        { "rpc.aggregate": "atlassian" },
      ),
    [WS_METHODS.atlassianStartOAuth]: (input) =>
      observeRpcEffect(
        WS_METHODS.atlassianStartOAuth,
        ownerEffect(WS_METHODS.atlassianStartOAuth, atlassian.startOAuth(input)),
        { "rpc.aggregate": "atlassian" },
      ),
    [WS_METHODS.atlassianDisconnect]: (input) =>
      observeRpcEffect(
        WS_METHODS.atlassianDisconnect,
        ownerEffect(
          WS_METHODS.atlassianDisconnect,
          atlassian.disconnect(input).pipe(Effect.as({})),
        ),
        {
          "rpc.aggregate": "atlassian",
        },
      ),
    [WS_METHODS.atlassianRefresh]: (input) =>
      observeRpcEffect(
        WS_METHODS.atlassianRefresh,
        ownerEffect(WS_METHODS.atlassianRefresh, atlassian.refresh(input)),
        { "rpc.aggregate": "atlassian" },
      ),
    [WS_METHODS.atlassianListResources]: (input) =>
      observeRpcEffect(
        WS_METHODS.atlassianListResources,
        ownerEffect(WS_METHODS.atlassianListResources, atlassian.listResources(input)),
        { "rpc.aggregate": "atlassian" },
      ),
    [WS_METHODS.atlassianGetProjectLink]: (input) =>
      observeRpcEffect(
        WS_METHODS.atlassianGetProjectLink,
        ownerEffect(WS_METHODS.atlassianGetProjectLink, atlassian.getProjectLink(input)),
        { "rpc.aggregate": "atlassian" },
      ),
    [WS_METHODS.atlassianSaveProjectLink]: (input) =>
      observeRpcEffect(
        WS_METHODS.atlassianSaveProjectLink,
        ownerEffect(WS_METHODS.atlassianSaveProjectLink, atlassian.saveProjectLink(input)),
        { "rpc.aggregate": "atlassian" },
      ),
    [WS_METHODS.atlassianSaveManualBitbucketToken]: (input) =>
      observeRpcEffect(
        WS_METHODS.atlassianSaveManualBitbucketToken,
        ownerEffect(
          WS_METHODS.atlassianSaveManualBitbucketToken,
          atlassian.saveManualBitbucketToken(input),
        ),
        {
          "rpc.aggregate": "atlassian",
        },
      ),
    [WS_METHODS.atlassianSaveManualJiraToken]: (input) =>
      observeRpcEffect(
        WS_METHODS.atlassianSaveManualJiraToken,
        ownerEffect(WS_METHODS.atlassianSaveManualJiraToken, atlassian.saveManualJiraToken(input)),
        {
          "rpc.aggregate": "atlassian",
        },
      ),
    [WS_METHODS.workItemsListProjects]: (input) =>
      observeRpcEffect(WS_METHODS.workItemsListProjects, workItems.listProjects(input), {
        "rpc.aggregate": "work-items",
      }),
    [WS_METHODS.workItemsList]: (input) =>
      observeRpcEffect(WS_METHODS.workItemsList, workItems.list(input), {
        "rpc.aggregate": "work-items",
      }),
    [WS_METHODS.workItemsSearch]: (input) =>
      observeRpcEffect(WS_METHODS.workItemsSearch, workItems.search(input), {
        "rpc.aggregate": "work-items",
      }),
    [WS_METHODS.workItemsGet]: (input) =>
      observeRpcEffect(WS_METHODS.workItemsGet, workItems.get(input), {
        "rpc.aggregate": "work-items",
      }),
    [WS_METHODS.workItemsAddComment]: (input) =>
      observeRpcEffect(
        WS_METHODS.workItemsAddComment,
        ownerEffect(WS_METHODS.workItemsAddComment, workItems.addComment(input)),
        { "rpc.aggregate": "work-items" },
      ),
    [WS_METHODS.workItemsEditComment]: (input) =>
      observeRpcEffect(
        WS_METHODS.workItemsEditComment,
        ownerEffect(WS_METHODS.workItemsEditComment, workItems.editComment(input)),
        { "rpc.aggregate": "work-items" },
      ),
    [WS_METHODS.workItemsUpdate]: (input) =>
      observeRpcEffect(
        WS_METHODS.workItemsUpdate,
        ownerEffect(WS_METHODS.workItemsUpdate, workItems.update(input)),
        { "rpc.aggregate": "work-items" },
      ),
    [WS_METHODS.workItemsListTransitions]: (input) =>
      observeRpcEffect(WS_METHODS.workItemsListTransitions, workItems.listTransitions(input), {
        "rpc.aggregate": "work-items",
      }),
    [WS_METHODS.workItemsTransition]: (input) =>
      observeRpcEffect(
        WS_METHODS.workItemsTransition,
        ownerEffect(WS_METHODS.workItemsTransition, workItems.transition(input)),
        { "rpc.aggregate": "work-items" },
      ),
    [WS_METHODS.subscribeServerConfig]: (_input) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeServerConfig,
        Effect.gen(function* () {
          const keybindingsUpdates = keybindings.streamChanges.pipe(
            Stream.map((event) => ({
              version: 1 as const,
              type: "keybindingsUpdated" as const,
              payload: {
                keybindings: event.keybindings,
                issues: event.issues,
              },
            })),
          );
          const providerStatuses = providerRegistry.streamChanges.pipe(
            Stream.map((providers) => ({
              version: 1 as const,
              type: "providerStatuses" as const,
              payload: { providers },
            })),
            Stream.debounce(Duration.millis(PROVIDER_STATUS_DEBOUNCE_MS)),
          );
          const settingsUpdates = serverSettings.streamChanges.pipe(
            Stream.map((settings) => redactServerSettingsForClient(settings)),
            Stream.map((settings) => ({
              version: 1 as const,
              type: "settingsUpdated" as const,
              payload: { settings },
            })),
          );

          yield* providerRegistry.revalidateStale.pipe(
            Effect.ignoreCause({ log: true }),
            Effect.forkScoped,
          );

          const liveUpdates = Stream.merge(
            keybindingsUpdates,
            Stream.merge(providerStatuses, settingsUpdates),
          );

          return Stream.concat(
            Stream.make({
              version: 1 as const,
              type: "snapshot" as const,
              config: yield* loadServerConfig,
            }),
            liveUpdates,
          );
        }),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.subscribeServerLifecycle]: (_input) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeServerLifecycle,
        Effect.gen(function* () {
          const snapshot = yield* lifecycleEvents.snapshot;
          const snapshotEvents = Array.from(snapshot.events).toSorted(
            (left, right) => left.sequence - right.sequence,
          );
          const liveEvents = lifecycleEvents.stream.pipe(
            Stream.filter((event) => event.sequence > snapshot.sequence),
          );
          return Stream.concat(Stream.fromIterable(snapshotEvents), liveEvents);
        }),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.subscribeAuthAccess]: (_input) =>
      observeRpcStreamEffect(
        WS_METHODS.subscribeAuthAccess,
        directOwnerStreamEffect(
          WS_METHODS.subscribeAuthAccess,
          Effect.gen(function* () {
            const initialSnapshot = yield* loadAuthAccessSnapshot();
            const revisionRef = yield* Ref.make(1);
            const accessChanges: Stream.Stream<
              BootstrapCredentialChange | SessionCredentialChange
            > = Stream.merge(bootstrapCredentials.streamChanges, sessions.streamChanges);

            const liveEvents: Stream.Stream<AuthAccessStreamEvent> = accessChanges.pipe(
              Stream.mapEffect((change) =>
                Ref.updateAndGet(revisionRef, (revision) => revision + 1).pipe(
                  Effect.map((revision) =>
                    toAuthAccessStreamEvent(change, revision, currentSessionId),
                  ),
                ),
              ),
            );

            return Stream.concat(
              Stream.make({
                version: 1 as const,
                revision: 1,
                type: "snapshot" as const,
                payload: initialSnapshot,
              }),
              liveEvents,
            );
          }),
        ),
        { "rpc.aggregate": "auth" },
      ),
  });
};
