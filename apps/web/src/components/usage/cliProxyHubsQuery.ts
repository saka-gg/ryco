import { useAtomValue } from "@effect/atom-react";
import {
  createKeyedQueryRegistry,
  defineKeyedQueryByKey,
  type KeyedQueryControllerBase,
} from "@ryco/client-runtime/rpc";
import { CLI_PROXY_HUB_READ_REUSE_MS, readCliProxyHubsOutcome } from "@ryco/client-runtime/usage";
import type { CliProxyReadHubsResult, EnvironmentId } from "@ryco/contracts";
import { useEffect } from "react";

import { readEnvironmentApi } from "~/environmentApi";

type CliProxyHubs = CliProxyReadHubsResult["hubs"];

/** What the usage popup shows of a node's hubs. */
export interface CliProxyHubsState {
  /** Null while none arrived, and after a failed read: it shows no hubs an earlier read found. */
  readonly data: CliProxyHubs | null;
  readonly isFetching: boolean;
  readonly error: Error | null;
  /**
   * When the Limits page seeded `data` (0: a read of this cache found it). Kept in the state, so
   * clearing the cache (account teardown) drops a seed no popup has read yet as well.
   */
  readonly seededAt: number;
}

const NO_HUBS_STATE: CliProxyHubsState = Object.freeze({
  data: null,
  isFetching: false,
  error: null,
  seededAt: 0,
});

function hubsState(data: unknown, seededAt = 0): CliProxyHubsState {
  return { data: data as CliProxyHubs, isFetching: false, error: null, seededAt };
}

// Its own small state rather than `rpc/keyedQueryState`: the popup is on the chat route, whose
// bundle budget has no room for another shared chunk.
const cliProxyHubsRegistry = createKeyedQueryRegistry<CliProxyHubsState>({
  labelPrefix: "cli-proxy-hubs",
  accountScoped: true,
  initialState: NO_HUBS_STATE,
  buildFetchingState: (current) => ({ ...current, isFetching: true, error: null }),
  buildSuccessState: (data) => hubsState(data),
  buildErrorState: (_current, error) => ({ data: null, isFetching: false, error, seededAt: 0 }),
  isErrorState: (state) => state.error !== null,
});

/** A seed counts as a read: a popup opened within the reuse window does not ask again. */
function shouldReadOnWatch(controller: KeyedQueryControllerBase): boolean {
  const { data, seededAt } = cliProxyHubsRegistry.getQueryState(controller.compositeKey);
  if (!controller.hasData && data !== null && seededAt > 0) {
    controller.hasData = true;
    controller.lastFetchedAt = seededAt;
  }
  return !controller.hasData || Date.now() - controller.lastFetchedAt >= controller.staleTime;
}

/**
 * A node's CLIProxyAPI hubs for surfaces that read them only while open (the composer's usage
 * popup), by the shared hub-read policy (`usage/cliProxyHubReads`): a read is reused for 30s so
 * reopening does not ask the node again, a failed read is retried on the next open, and nothing
 * polls. The node caches its hub and quota reads further. A session the node refuses hub reads
 * (not its owner) reads as having no hubs.
 */
export const cliProxyHubsQuery = defineKeyedQueryByKey<
  EnvironmentId | null,
  CliProxyHubs,
  CliProxyHubsState,
  Record<string, never>,
  EnvironmentId
>(
  cliProxyHubsRegistry,
  {
    label: "hubs",
    staleTime: CLI_PROXY_HUB_READ_REUSE_MS,
    isEnabled: (environmentId): environmentId is EnvironmentId => environmentId !== null,
    buildKey: (environmentId) => environmentId,
    resolveEnvironmentId: (environmentId) => environmentId,
    createControllerFields: () => ({}),
    run: async (environmentId) => {
      const readHubs = readEnvironmentApi(environmentId)?.server?.readCliProxyHubs;
      if (!readHubs) throw new Error("This node is not connected.");
      const read = await readCliProxyHubsOutcome(() => readHubs({}));
      if (read.status !== "ok") throw new Error(read.message);
      return read.hubs;
    },
  },
  shouldReadOnWatch,
);

/** The node's hubs while the caller is mounted; null reads nothing. */
export function useCliProxyHubs(environmentId: EnvironmentId | null): CliProxyHubsState {
  useEffect(() => cliProxyHubsQuery.watch(environmentId), [environmentId]);
  return useAtomValue(cliProxyHubsQuery.getAtom(cliProxyHubsQuery.keyOf(environmentId)));
}

/** A node's hubs as the Limits page just read them, shared with the popup. */
export function seedCliProxyHubs(environmentId: EnvironmentId, hubs: CliProxyHubs): void {
  const compositeKey = cliProxyHubsQuery.keyOf(environmentId);
  if (compositeKey === null) return;
  const now = Date.now();
  const controller = cliProxyHubsRegistry.controllers.get(compositeKey);
  if (controller) {
    controller.hasData = true;
    controller.lastFetchedAt = now;
  }
  cliProxyHubsRegistry.setQueryState(compositeKey, hubsState(hubs, now));
}

/** The next open reads again, as if the reuse window had passed. */
export function expireCliProxyHubsForTests(environmentId: EnvironmentId): void {
  const compositeKey = cliProxyHubsQuery.keyOf(environmentId);
  if (compositeKey === null) return;
  const controller = cliProxyHubsRegistry.controllers.get(compositeKey);
  if (controller) controller.lastFetchedAt = 0;
  const state = cliProxyHubsRegistry.getQueryState(compositeKey);
  if (state.seededAt > 0)
    cliProxyHubsRegistry.setQueryState(compositeKey, { ...state, seededAt: 1 });
}

export function resetCliProxyHubsForTests(): void {
  cliProxyHubsRegistry.resetForTests();
}
