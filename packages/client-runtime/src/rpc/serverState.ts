import type {
  EditorId,
  ServerConfig,
  ServerConfigStreamEvent,
  ServerConfigUpdatedPayload,
  ServerLifecycleWelcomePayload,
  ServerProvider,
  ServerProviderUpdatedPayload,
} from "@ryco/contracts";
import { DEFAULT_SERVER_SETTINGS, type ServerSettings } from "@ryco/contracts/settings";
import { DEFAULT_RESOLVED_KEYBINDINGS } from "@ryco/shared/keybindings";
import * as Atom from "effect/reactivity/Atom";

import type { WsRpcClient } from "./wsRpcClient.ts";
import { appAtomRegistry, resetAppAtomRegistryForTests } from "./atomRegistry.ts";
import { projectServerConfigEvent } from "./serverConfigProjection.ts";

/** What changed the config; a provider delta reports as `providerStatuses`. */
export type ServerConfigUpdateSource = Exclude<
  ServerConfigStreamEvent["type"],
  "providerStatusesDelta"
>;

export interface ServerConfigUpdatedNotification {
  readonly id: number;
  readonly payload: ServerConfigUpdatedPayload;
  readonly source: ServerConfigUpdateSource;
}

type ServerStateClient = Pick<WsRpcClient["server"], "subscribeLifecycle">;

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

/** The update source a stream event reports as; a provider delta is a provider status change. */
export function toServerConfigUpdateSource(
  type: ServerConfigStreamEvent["type"],
): ServerConfigUpdateSource {
  return type === "providerStatusesDelta" ? "providerStatuses" : type;
}

/** Shows `config` as the global server config and announces it as the result of `source`. */
export function publishServerConfig(config: ServerConfig, source: ServerConfigUpdateSource): void {
  resolveServerConfig(config);
  if (source === "snapshot" || source === "providerStatuses") {
    emitProvidersUpdated({ providers: config.providers });
  }
  emitServerConfigUpdated(toServerConfigUpdatedPayload(config), source);
}

export function setServerConfigSnapshot(config: ServerConfig): void {
  publishServerConfig(config, "snapshot");
}

export function applyServerConfigEvent(event: ServerConfigStreamEvent): void {
  const nextConfig = projectServerConfigEvent(getServerConfig(), event);
  if (!nextConfig) {
    return;
  }
  publishServerConfig(nextConfig, toServerConfigUpdateSource(event.type));
}

/**
 * Local writes to the shown config (this and `applySettingsUpdated`) stand until
 * the node's own update to the same part arrives (a settings event for settings,
 * a provider status event for providers) or a snapshot replaces the config; the
 * active-environment projection keeps them through updates to anything else.
 */
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

interface ServerStateSyncHold {
  count: number;
  readonly stop: () => void;
}

/** What the primary server-state sync reads: the connection's lifecycle stream. */
export interface ServerStateConnection {
  readonly client: { readonly server: ServerStateClient };
}

/** One lifecycle subscription per connection, shared by every holder. */
let serverStateSyncHolds = new WeakMap<ServerStateConnection, ServerStateSyncHold>();

/**
 * Keeps the primary connection's `welcome` live. Welcome comes from the primary
 * lifecycle stream only; it is not per-environment state.
 *
 * It writes no config. Config flows from each connection's own config observer
 * (`onConfigUpdated`, one config stream per connection, which already drops
 * events the connection does not accept: an increment without a current
 * snapshot, a stale hosted generation) into the per-environment store in
 * `environmentServerConfigs.ts`, and the global config atoms are derived from
 * the active environment's entry. The config subscription's first item is
 * always a full snapshot, so no separate `getConfig` read runs beside it.
 *
 * Reference-counted per connection: a second holder (the boot path that starts
 * the sync with the early primary connection, then the shell's own) shares
 * the first one's subscription instead of opening a duplicate stream, and the
 * last returned stop ends it.
 */
export function startServerStateSync(connection: ServerStateConnection): () => void {
  let hold = serverStateSyncHolds.get(connection);
  if (!hold) {
    hold = {
      count: 0,
      stop: connection.client.server.subscribeLifecycle((event) => {
        if (event.type === "welcome") {
          emitWelcome(event.payload);
        }
      }),
    };
    serverStateSyncHolds.set(connection, hold);
  }
  const current = hold;
  current.count += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    current.count -= 1;
    if (current.count > 0) return;
    if (serverStateSyncHolds.get(connection) === current) serverStateSyncHolds.delete(connection);
    current.stop();
  };
}

export function resetServerStateForTests() {
  resetAppAtomRegistryForTests();
  serverStateSyncHolds = new WeakMap();
  nextServerConfigUpdatedNotificationId = 1;
}

/** Resets the config-derived atoms; the welcome payload is left as it is. */
export function clearServerConfigState(): void {
  appAtomRegistry.set(serverConfigAtom, null);
  appAtomRegistry.set(serverConfigUpdatedAtom, null);
  appAtomRegistry.set(providersUpdatedAtom, null);
  nextServerConfigUpdatedNotificationId = 1;
}

/** Resets the primary connection's welcome payload; the config atoms are left as they are. */
export function clearWelcomeState(): void {
  appAtomRegistry.set(welcomeAtom, null);
}

export function clearServerState(): void {
  clearWelcomeState();
  clearServerConfigState();
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
