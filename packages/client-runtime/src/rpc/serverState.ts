import {
  DEFAULT_SERVER_SETTINGS,
  type EditorId,
  type ServerConfig,
  type ServerConfigStreamEvent,
  type ServerConfigUpdatedPayload,
  type ServerLifecycleWelcomePayload,
  type ServerProvider,
  type ServerProviderUpdatedPayload,
  type ServerSettings,
} from "@ryco/contracts";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/shared/keybindings";
import { Atom } from "effect/unstable/reactivity";

import type { WsRpcClient } from "./wsRpcClient.ts";
import { appAtomRegistry, resetAppAtomRegistryForTests } from "./atomRegistry.ts";
import { projectServerConfigEvent } from "./serverConfigProjection.ts";

export type ServerConfigUpdateSource = ServerConfigStreamEvent["type"];

export interface ServerConfigUpdatedNotification {
  readonly id: number;
  readonly payload: ServerConfigUpdatedPayload;
  readonly source: ServerConfigUpdateSource;
}

type ServerStateClient = Pick<
  WsRpcClient["server"],
  "getConfig" | "subscribeConfig" | "subscribeLifecycle"
>;

function makeStateAtom<A>(label: string, initialValue: A) {
  return Atom.make(initialValue).pipe(Atom.keepAlive, Atom.withLabel(label));
}

function toServerConfigUpdatedPayload(config: ServerConfig): ServerConfigUpdatedPayload {
  return {
    issues: config.issues,
    providers: config.providers,
    settings: config.settings,
  };
}

export const EMPTY_AVAILABLE_EDITORS: ReadonlyArray<EditorId> = [];
export const EMPTY_SERVER_PROVIDERS: ReadonlyArray<ServerProvider> = [];

export const selectAvailableEditors = (config: ServerConfig | null): ReadonlyArray<EditorId> =>
  config?.availableEditors ?? EMPTY_AVAILABLE_EDITORS;
export const selectKeybindings = (config: ServerConfig | null) =>
  config?.keybindings ?? DEFAULT_RESOLVED_KEYBINDINGS;
export const selectKeybindingsConfigPath = (config: ServerConfig | null) =>
  config?.keybindingsConfigPath ?? null;
export const selectObservability = (config: ServerConfig | null) => config?.observability ?? null;
export const selectProviders = (config: ServerConfig | null) =>
  config?.providers ?? EMPTY_SERVER_PROVIDERS;
export const selectSettings = (config: ServerConfig | null): ServerSettings =>
  config?.settings ?? DEFAULT_SERVER_SETTINGS;

export const welcomeAtom = makeStateAtom<ServerLifecycleWelcomePayload | null>(
  "server-welcome",
  null,
);
export const serverConfigAtom = makeStateAtom<ServerConfig | null>("server-config", null);
export const serverConfigUpdatedAtom = makeStateAtom<ServerConfigUpdatedNotification | null>(
  "server-config-updated",
  null,
);
export const providersUpdatedAtom = makeStateAtom<ServerProviderUpdatedPayload | null>(
  "server-providers-updated",
  null,
);

export function getServerConfig(): ServerConfig | null {
  return appAtomRegistry.get(serverConfigAtom);
}

export function getLegacyServerKeybindings(): ServerConfig["keybindings"] {
  return selectKeybindings(getServerConfig());
}

export function getServerConfigUpdatedNotification(): ServerConfigUpdatedNotification | null {
  return appAtomRegistry.get(serverConfigUpdatedAtom);
}

export function setServerConfigSnapshot(config: ServerConfig): void {
  resolveServerConfig(config);
  emitProvidersUpdated({ providers: config.providers });
  emitServerConfigUpdated(toServerConfigUpdatedPayload(config), "snapshot");
}

export function applyServerConfigEvent(event: ServerConfigStreamEvent): void {
  const nextConfig = projectServerConfigEvent(getServerConfig(), event);
  if (!nextConfig) {
    return;
  }
  resolveServerConfig(nextConfig);
  if (event.type === "snapshot" || event.type === "providerStatuses") {
    emitProvidersUpdated({ providers: nextConfig.providers });
  }
  emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), event.type);
}

export function applyProvidersUpdated(payload: ServerProviderUpdatedPayload): void {
  const latestServerConfig = getServerConfig();
  emitProvidersUpdated(payload);

  if (!latestServerConfig) {
    return;
  }

  const nextConfig = {
    ...latestServerConfig,
    providers: payload.providers,
  } satisfies ServerConfig;
  resolveServerConfig(nextConfig);
  emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), "providerStatuses");
}

export function applySettingsUpdated(settings: ServerSettings): void {
  const latestServerConfig = getServerConfig();
  if (!latestServerConfig) {
    return;
  }

  const nextConfig = {
    ...latestServerConfig,
    settings,
  } satisfies ServerConfig;
  resolveServerConfig(nextConfig);
  emitServerConfigUpdated(toServerConfigUpdatedPayload(nextConfig), "settingsUpdated");
}

export function emitWelcome(payload: ServerLifecycleWelcomePayload): void {
  appAtomRegistry.set(welcomeAtom, payload);
}

export function onWelcome(listener: (payload: ServerLifecycleWelcomePayload) => void): () => void {
  return subscribeLatest(welcomeAtom, listener);
}

export function onServerConfigUpdated(
  listener: (payload: ServerConfigUpdatedPayload, source: ServerConfigUpdateSource) => void,
): () => void {
  return subscribeLatest(serverConfigUpdatedAtom, (notification) => {
    listener(notification.payload, notification.source);
  });
}

export function onProvidersUpdated(
  listener: (payload: ServerProviderUpdatedPayload) => void,
): () => void {
  return subscribeLatest(providersUpdatedAtom, listener);
}

export function startServerStateSync(client: ServerStateClient): () => void {
  let disposed = false;
  const cleanups = [
    client.subscribeLifecycle((event) => {
      if (event.type === "welcome") {
        emitWelcome(event.payload);
      }
    }),
    client.subscribeConfig((event) => {
      applyServerConfigEvent(event);
    }),
  ];

  if (getServerConfig() === null) {
    void client
      .getConfig()
      .then((config) => {
        if (disposed || getServerConfig() !== null) {
          return;
        }
        setServerConfigSnapshot(config);
      })
      .catch(() => undefined);
  }

  return () => {
    disposed = true;
    for (const cleanup of cleanups) {
      cleanup();
    }
  };
}

export function resetServerStateForTests() {
  resetAppAtomRegistryForTests();
  nextServerConfigUpdatedNotificationId = 1;
}

export function clearServerState(): void {
  appAtomRegistry.set(welcomeAtom, null);
  appAtomRegistry.set(serverConfigAtom, null);
  appAtomRegistry.set(serverConfigUpdatedAtom, null);
  appAtomRegistry.set(providersUpdatedAtom, null);
  nextServerConfigUpdatedNotificationId = 1;
}

let nextServerConfigUpdatedNotificationId = 1;

function resolveServerConfig(config: ServerConfig): void {
  appAtomRegistry.set(serverConfigAtom, config);
}

function emitProvidersUpdated(payload: ServerProviderUpdatedPayload): void {
  appAtomRegistry.set(providersUpdatedAtom, payload);
}

function emitServerConfigUpdated(
  payload: ServerConfigUpdatedPayload,
  source: ServerConfigUpdateSource,
): void {
  appAtomRegistry.set(serverConfigUpdatedAtom, {
    id: nextServerConfigUpdatedNotificationId++,
    payload,
    source,
  });
}

function subscribeLatest<A>(
  atom: Atom.Atom<A | null>,
  listener: (value: NonNullable<A>) => void,
): () => void {
  return appAtomRegistry.subscribe(
    atom,
    (value) => {
      if (value === null) {
        return;
      }
      listener(value as NonNullable<A>);
    },
    { immediate: true },
  );
}
