import { useEffect, useSyncExternalStore } from "react";

import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { clearServerState, setServerConfigSnapshot } from "@ryco/client-runtime/rpc";
import type { EnvironmentConnection } from "@ryco/client-runtime/connection";

import { useConnectionRegistry } from "../providers/ConnectionRegistryProvider";
import {
  readEnvironmentServerConfig,
  subscribeEnvironmentServerConfigs,
} from "./environmentServerConfigs";
import { useStore } from "./threadsRuntime";

/**
 * Publishes one environment's config into the global `serverConfigAtom`.
 *
 * Every mobile connection already observes its node's config stream itself
 * (a direct connection is kind "saved"; the hosted primary passes
 * `onConfigUpdated`) and writes it into the per-environment config store. The
 * global atom is fed from that store instead of a second `subscribeServerConfig`
 * on the same client, which cost a second full snapshot on every cold connect,
 * a second server-side config build, and every later delta twice.
 */
export function startActiveEnvironmentServerStateSync(environmentId: EnvironmentId): () => void {
  let published: ServerConfig | null = null;
  const publish = () => {
    const config = readEnvironmentServerConfig(environmentId);
    if (config === null || config === published) return;
    published = config;
    setServerConfigSnapshot(config);
  };
  publish();
  const unsubscribe = subscribeEnvironmentServerConfigs(publish);
  return () => {
    unsubscribe();
    clearServerState();
  };
}

// §3-20 (ratified single-active-env): the mobile analogue of the web
// ServerStateBootstrap. serverConfigAtom is a single global atom fed for one
// environment; mobile has no primary, so we sync the ACTIVE environment's server
// state while it has a connection. clearServerState runs on switch/teardown. No
// import-time side effect.
export function useServerStateSync(): void {
  const { driver } = useConnectionRegistry();
  const activeEnvironmentId = useStore((state) => state.activeEnvironmentId);

  const readConnection = (): EnvironmentConnection | null =>
    activeEnvironmentId ? driver.supervisor.read(activeEnvironmentId) : null;

  const connection = useSyncExternalStore(
    driver.supervisor.subscribe,
    readConnection,
    readConnection,
  );

  useEffect(() => {
    if (!connection) return;
    return startActiveEnvironmentServerStateSync(connection.environmentId);
  }, [connection]);
}

/** Mountable form (App root): drives the active-environment server-state sync. */
export function ServerStateBootstrap(): null {
  useServerStateSync();
  return null;
}
