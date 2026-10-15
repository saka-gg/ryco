import { useSyncExternalStore } from "react";

import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";

type Listener = () => void;

let configs: ReadonlyMap<EnvironmentId, ServerConfig> = new Map();
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

export function subscribeEnvironmentServerConfigs(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function writeEnvironmentServerConfig(
  environmentId: EnvironmentId,
  config: ServerConfig,
): void {
  const next = new Map(configs);
  next.set(environmentId, config);
  configs = next;
  emit();
}

export function patchEnvironmentServerSettings(
  environmentId: EnvironmentId,
  patch: ServerSettingsPatch,
): void {
  const current = configs.get(environmentId);
  if (!current) return;
  writeEnvironmentServerConfig(environmentId, {
    ...current,
    settings: {
      ...current.settings,
      ...Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)),
    } as ServerConfig["settings"],
  });
}

export function readEnvironmentServerConfig(environmentId: EnvironmentId): ServerConfig | null {
  return configs.get(environmentId) ?? null;
}

export function getEnvironmentServerConfigsSnapshot(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return configs;
}

export function useEnvironmentServerConfigs(): ReadonlyMap<EnvironmentId, ServerConfig> {
  return useSyncExternalStore(
    subscribeEnvironmentServerConfigs,
    getEnvironmentServerConfigsSnapshot,
    getEnvironmentServerConfigsSnapshot,
  );
}

export function resetEnvironmentServerConfigsForTests(): void {
  configs = new Map();
  listeners.clear();
}
