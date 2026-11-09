import {
  applyAuthAccessEvent,
  EMPTY_AUTH_ACCESS_LIST,
  type AuthAccessList,
} from "@ryco/client-runtime/machineAccess/authAccess";
import { createRemoteMachineAccessApi } from "@ryco/client-runtime/machineAccess/remoteMachineAccess";
import type { AdvertisedEndpoint, EnvironmentId } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";

import { readRpcClient, subscribeEnvironmentApis } from "../../connection/environmentApi";
import { getMobileHttpClient } from "../../connection/runtimeConfig";
import { secondClock } from "../../lib/secondClock";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import {
  createDirectAccessOperations,
  type DirectAccessOperations,
} from "./machineAccessOperations";

export type AuthAccessStatus = "idle" | "loading" | "ready" | "failed";

export interface AuthAccessState {
  readonly list: AuthAccessList;
  readonly status: AuthAccessStatus;
}

const IDLE: AuthAccessState = { list: EMPTY_AUTH_ACCESS_LIST, status: "idle" };
const LOADING: AuthAccessState = { list: EMPTY_AUTH_ACCESS_LIST, status: "loading" };

type RpcClient = NonNullable<ReturnType<typeof readRpcClient>>;

/** The environment's live RPC client, re-read whenever a connection registers or goes away. */
function useRpcClient(environmentId: EnvironmentId | null): RpcClient | null {
  const read = useCallback(
    () => (environmentId === null ? null : readRpcClient(environmentId)),
    [environmentId],
  );
  return useSyncExternalStore(subscribeEnvironmentApis, read, read);
}

/**
 * State read from one client. Each value remembers the client it came from, so
 * a reconnect (a new client) reads as loading during render instead of an
 * effect resetting it, and a late answer for an old client is never shown.
 */
interface FromClient<T> {
  readonly source: RpcClient | null;
  readonly value: T;
}

/**
 * The node's pairing links and client sessions, live. Subscribed only while
 * `environmentId` is set, which the screen does only for a direct owner
 * pairing: the node refuses the stream to anyone else.
 */
export function useAuthAccessList(environmentId: EnvironmentId | null): AuthAccessState {
  const client = useRpcClient(environmentId);
  const [state, setState] = useState<FromClient<AuthAccessState>>({ source: null, value: IDLE });

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    const update = (next: (current: AuthAccessState) => AuthAccessState) =>
      setState((current) => ({
        source: client,
        value: next(current.source === client ? current.value : LOADING),
      }));
    const unsubscribe = client.server.subscribeAuthAccess(
      (event) => {
        if (cancelled) return;
        update((current) => ({ list: applyAuthAccessEvent(current.list, event), status: "ready" }));
      },
      {
        onResubscribe: () => {
          if (!cancelled) update((current) => ({ ...current, status: "loading" }));
        },
        onError: () => {
          if (!cancelled) update((current) => ({ ...current, status: "failed" }));
        },
      },
    );
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [client]);

  if (client === null) return IDLE;
  return state.source === client ? state.value : LOADING;
}

export interface AdvertisedEndpointsState {
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly status: "idle" | "loading" | "ready" | "failed";
}

const NO_ENDPOINTS: AdvertisedEndpointsState = { endpoints: [], status: "idle" };
const LOADING_ENDPOINTS: AdvertisedEndpointsState = { endpoints: [], status: "loading" };

/** The addresses the node advertises, read once per connection. */
export function useAdvertisedEndpoints(
  environmentId: EnvironmentId | null,
): AdvertisedEndpointsState {
  const client = useRpcClient(environmentId);
  const [state, setState] = useState<FromClient<AdvertisedEndpointsState>>({
    source: null,
    value: NO_ENDPOINTS,
  });

  useEffect(() => {
    if (client === null) return;
    let cancelled = false;
    client.server
      .getAdvertisedEndpoints()
      .then((endpoints) => {
        if (!cancelled) setState({ source: client, value: { endpoints, status: "ready" } });
      })
      .catch(() => {
        if (!cancelled) setState({ source: client, value: { endpoints: [], status: "failed" } });
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  if (client === null) return NO_ENDPOINTS;
  return state.source === client ? state.value : LOADING_ENDPOINTS;
}

/** The owner's pairing calls for one direct pairing, bound to this app's stores. */
export function useDirectAccessOperations(environmentId: EnvironmentId): DirectAccessOperations {
  const registry = useConnectionRegistry();
  return useMemo(
    () =>
      createDirectAccessOperations(environmentId, {
        api: createRemoteMachineAccessApi(getMobileHttpClient()),
        readHttpBaseUrl: (id) => registry.catalog.get(id)?.httpBaseUrl ?? null,
        readBearerToken: (id) => registry.catalog.readBearerToken(id),
      }),
    [environmentId, registry],
  );
}

/**
 * Now, from the app's once-a-second clock, rounded down to `granularityMs`: a
 * list whose labels read in minutes re-renders only when the rounded value
 * changes, while a code's countdown passes 1000.
 */
export function useNowMs(granularityMs: number = 1000): number {
  const read = useCallback(
    () => Math.floor(secondClock.read() / granularityMs) * granularityMs,
    [granularityMs],
  );
  return useSyncExternalStore(secondClock.subscribe, read, read);
}
