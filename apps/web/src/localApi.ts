import type { ContextMenuItem, LocalApi } from "@ryco/contracts";

import { resetGitStatusStateForTests } from "./lib/gitStatusState";
import { resetSourceControlDiscoveryStateForTests } from "./lib/sourceControlDiscoveryState";
import { resetRequestLatencyStateForTests } from "./rpc/requestLatencyState";
import { resetServerStateForTests } from "./rpc/serverState";
import { resetWsConnectionStateForTests } from "./rpc/wsConnectionState";
import {
  resetSavedEnvironmentRegistryStoreForTests,
  resetSavedEnvironmentRuntimeStoreForTests,
} from "./environments/runtime";
import {
  getPrimaryEnvironmentConnection,
  readEnvironmentConnection,
  resetEnvironmentServiceForTests,
} from "./environments/runtime";
import { getPrimaryKnownEnvironment } from "./environments/primary";
import { type WsRpcClient } from "@ryco/client-runtime/rpc";
import { isHostedHubMode } from "./env";
import { showContextMenuFallback } from "./contextMenuFallback";
import { isContextMenuSheetHostMounted, presentContextMenuSheet } from "./contextMenuSheetState";
import { getPresentationTier } from "./lib/presentationTier";
import {
  readBrowserClientSettings,
  readBrowserSavedEnvironmentRegistry,
  readBrowserSavedEnvironmentSecret,
  removeBrowserSavedEnvironmentSecret,
  writeBrowserClientSettings,
  writeBrowserSavedEnvironmentRegistry,
  writeBrowserSavedEnvironmentSecret,
} from "./clientPersistenceStorage";
import { __resetClientSettingsPersistenceForTests } from "./hooks/clientSettingsStore";

let cachedApi: LocalApi | undefined;

function unavailableLocalBackendError(): Error {
  return new Error("Local backend API is unavailable before a backend is paired.");
}

type RpcClientResolver = () => WsRpcClient | undefined;

function withRpcClient<T>(
  readRpcClient: RpcClientResolver,
  operation: (rpcClient: WsRpcClient) => Promise<T>,
): Promise<T> {
  const rpcClient = readRpcClient();
  return rpcClient ? operation(rpcClient) : Promise.reject(unavailableLocalBackendError());
}

function createBrowserLocalApi(
  rpcClientOrResolver?: WsRpcClient | RpcClientResolver,
  options?: { readonly includeMcp?: boolean },
): LocalApi {
  const readRpcClient: RpcClientResolver =
    typeof rpcClientOrResolver === "function" ? rpcClientOrResolver : () => rpcClientOrResolver;

  return {
    dialogs: {
      pickFolder: async (options) => {
        if (!window.desktopBridge) return null;
        return window.desktopBridge.pickFolder(options);
      },
      confirm: async (message) => {
        if (window.desktopBridge) {
          return window.desktopBridge.confirm(message);
        }
        return window.confirm(message);
      },
    },
    shell: {
      openInEditor: (cwd, editor) =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.shell.openInEditor({ cwd, editor })),
      openExternal: async (url) => {
        if (window.desktopBridge) {
          const opened = await window.desktopBridge.openExternal(url);
          if (!opened) {
            throw new Error("Unable to open link.");
          }
          return;
        }

        window.open(url, "_blank", "noopener,noreferrer");
      },
      getPathForFile: async (file) => {
        const resolvedPath = window.desktopBridge?.getPathForFile?.(file);
        return resolvedPath || null;
      },
    },
    contextMenu: {
      show: async <T extends string>(
        items: readonly ContextMenuItem<T>[],
        position?: { x: number; y: number },
      ): Promise<T | null> => {
        if (window.desktopBridge) {
          return window.desktopBridge.showContextMenu(items, position) as Promise<T | null>;
        }
        // The phone tier presents context actions as a bottom action sheet
        // (touch-sized rows, focus trap); desktop keeps the DOM fallback.
        if (getPresentationTier() === "phone" && isContextMenuSheetHostMounted()) {
          return presentContextMenuSheet(items);
        }
        return showContextMenuFallback(items, position);
      },
    },
    persistence: {
      getClientSettings: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getClientSettings();
        }
        return readBrowserClientSettings();
      },
      setClientSettings: async (settings) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setClientSettings(settings);
        }
        writeBrowserClientSettings(settings);
      },
      getSavedEnvironmentRegistry: async () => {
        if (window.desktopBridge) {
          return window.desktopBridge.getSavedEnvironmentRegistry();
        }
        return readBrowserSavedEnvironmentRegistry();
      },
      setSavedEnvironmentRegistry: async (records) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setSavedEnvironmentRegistry(records);
        }
        writeBrowserSavedEnvironmentRegistry(records);
      },
      getSavedEnvironmentSecret: async (environmentId) => {
        if (window.desktopBridge) {
          return window.desktopBridge.getSavedEnvironmentSecret(environmentId);
        }
        return readBrowserSavedEnvironmentSecret(environmentId);
      },
      setSavedEnvironmentSecret: async (environmentId, secret) => {
        if (window.desktopBridge) {
          return window.desktopBridge.setSavedEnvironmentSecret(environmentId, secret);
        }
        return writeBrowserSavedEnvironmentSecret(environmentId, secret);
      },
      removeSavedEnvironmentSecret: async (environmentId) => {
        if (window.desktopBridge) {
          return window.desktopBridge.removeSavedEnvironmentSecret(environmentId);
        }
        removeBrowserSavedEnvironmentSecret(environmentId);
      },
    },
    server: {
      getConfig: () => withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.getConfig()),
      getAdvertisedEndpoints: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.getAdvertisedEndpoints()),
      getDiagnosticsMetrics: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.getDiagnosticsMetrics()),
      getStatistics: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.getStatistics()),
      getUsageSummary: (input) =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.getUsageSummary(input)),
      refreshProviders: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.refreshProviders()),
      searchAcpRegistry: (input) =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.searchAcpRegistry(input)),
      installAcpRegistry: (input) =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.installAcpRegistry(input)),
      getAcpRegistryAuthMethods: (input) =>
        withRpcClient(readRpcClient, (rpcClient) =>
          rpcClient.server.getAcpRegistryAuthMethods(input),
        ),
      authenticateAcpRegistry: (input) =>
        withRpcClient(readRpcClient, (rpcClient) =>
          rpcClient.server.authenticateAcpRegistry(input),
        ),
      updateProvider: (input) =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.updateProvider(input)),
      upsertKeybinding: (input) =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.upsertKeybinding(input)),
      getSettings: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.getSettings()),
      updateSettings: (patch) =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.updateSettings(patch)),
      getResourceTelemetryHistory: (input) =>
        withRpcClient(readRpcClient, (rpcClient) =>
          rpcClient.server.getResourceTelemetryHistory(input),
        ),
      retryResourceTelemetry: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.retryResourceTelemetry()),
      signalDiagnosticProcess: (input) =>
        withRpcClient(readRpcClient, (rpcClient) =>
          rpcClient.server.signalDiagnosticProcess(input),
        ),
      getDiagnosticsSnapshot: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.getDiagnosticsSnapshot()),
      discoverSourceControl: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.discoverSourceControl()),
      listOpinionatedPlugins: () =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.server.listOpinionatedPlugins()),
      checkOpinionatedPlugins: (input) =>
        withRpcClient(readRpcClient, (rpcClient) =>
          rpcClient.server.checkOpinionatedPlugins(input),
        ),
      installOpinionatedPlugin: (input) =>
        withRpcClient(readRpcClient, (rpcClient) =>
          rpcClient.server.installOpinionatedPlugin(input),
        ),
    },
    keybindings: {
      replaceCustom: (input) =>
        withRpcClient(readRpcClient, (rpcClient) => rpcClient.keybindings.replaceCustom(input)),
    },
    ...((options?.includeMcp ?? rpcClientOrResolver !== undefined)
      ? {
          mcp: {
            listWorkspaces: () =>
              withRpcClient(readRpcClient, (rpcClient) => rpcClient.mcp.listWorkspaces()),
            listServers: (input) =>
              withRpcClient(readRpcClient, (rpcClient) => rpcClient.mcp.listServers(input)),
            upsertServer: (input) =>
              withRpcClient(readRpcClient, (rpcClient) => rpcClient.mcp.upsertServer(input)),
            setServerEnabled: (input) =>
              withRpcClient(readRpcClient, (rpcClient) => rpcClient.mcp.setServerEnabled(input)),
            removeServer: (input) =>
              withRpcClient(readRpcClient, (rpcClient) => rpcClient.mcp.removeServer(input)),
            reloadServers: (input) =>
              withRpcClient(readRpcClient, (rpcClient) => rpcClient.mcp.reloadServers(input)),
            startOauthLogin: (input) =>
              withRpcClient(readRpcClient, (rpcClient) => rpcClient.mcp.startOauthLogin(input)),
          },
        }
      : {}),
  };
}

function mergeLocalApiFallbacks(fallback: LocalApi, api: Partial<LocalApi>): LocalApi {
  const mcp = api.mcp ?? fallback.mcp;

  return {
    ...fallback,
    ...api,
    dialogs: {
      ...fallback.dialogs,
      ...api.dialogs,
    },
    shell: {
      ...fallback.shell,
      ...api.shell,
    },
    contextMenu: {
      ...fallback.contextMenu,
      ...api.contextMenu,
    },
    persistence: {
      ...fallback.persistence,
      ...api.persistence,
    },
    server: {
      ...fallback.server,
      ...api.server,
    },
    ...(mcp ? { mcp } : {}),
  };
}

export function createLocalApi(rpcClient: WsRpcClient): LocalApi {
  return createBrowserLocalApi(rpcClient);
}

export function readLocalApi(): LocalApi | undefined {
  if (typeof window === "undefined") return undefined;
  if (cachedApi) return cachedApi;

  if (window.nativeApi) {
    cachedApi = mergeLocalApiFallbacks(createBrowserLocalApi(), window.nativeApi);
    return cachedApi;
  }

  const hasPrimaryEnvironment = getPrimaryKnownEnvironment() !== null;
  cachedApi = createBrowserLocalApi(
    () => {
      const primaryEnvironment = getPrimaryKnownEnvironment();
      if (!primaryEnvironment) return undefined;
      const currentClient = primaryEnvironment.environmentId
        ? readEnvironmentConnection(primaryEnvironment.environmentId)?.client
        : undefined;
      if (currentClient || isHostedHubMode()) return currentClient;
      return getPrimaryEnvironmentConnection().client;
    },
    { includeMcp: hasPrimaryEnvironment },
  );
  return cachedApi;
}

export function ensureLocalApi(): LocalApi {
  const api = readLocalApi();
  if (!api) {
    throw new Error("Local API not found");
  }
  return api;
}

export async function __resetLocalApiForTests() {
  cachedApi = undefined;
  __resetClientSettingsPersistenceForTests();
  await resetEnvironmentServiceForTests();
  resetGitStatusStateForTests();
  resetSourceControlDiscoveryStateForTests();
  resetRequestLatencyStateForTests();
  resetSavedEnvironmentRegistryStoreForTests();
  resetSavedEnvironmentRuntimeStoreForTests();
  resetServerStateForTests();
  resetWsConnectionStateForTests();
}
