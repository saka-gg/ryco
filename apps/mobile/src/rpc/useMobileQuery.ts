// React binding over a mobile query cache (mobileQueryCache): retain a key while
// the screen is mounted, read its atom state, and expose an imperative refetch
// for pull-to-refresh, with web's connection-identity fencing folded in — the
// live connection is read off the supervisor.
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

import { useConnectionRegistry } from "../providers/ConnectionRegistryProvider";
import type { MobileQuery, MobileQueryState } from "./mobileQueryCache";

export interface MobileQueryResult<T> extends MobileQueryState<T> {
  readonly refetch: () => Promise<{ readonly data: T | null }>;
}

/**
 * The live connection for an environment, as an identity. A reconnect registers
 * a NEW connection object, which is the signal that whatever the previous client
 * still owed us is dead and the node may have moved on underneath us.
 */
function useEnvironmentConnection(
  environmentId: EnvironmentId | null,
): EnvironmentConnection | null {
  const { driver } = useConnectionRegistry();
  const readConnection = useCallback(
    () => (environmentId === null ? null : driver.supervisor.read(environmentId)),
    [driver, environmentId],
  );
  return useSyncExternalStore(driver.supervisor.subscribe, readConnection, readConnection);
}

export function useMobileQuery<TInput, TData>(
  query: MobileQuery<TInput, TData>,
  input: TInput,
  environmentId: EnvironmentId | null,
): MobileQueryResult<TData> {
  const cacheKey = query.keyOf(input);
  const connection = useEnvironmentConnection(environmentId);

  // The effect is keyed on the cache key and the connection identity; `input` is
  // read through a ref so a fresh object per render never re-subscribes.
  const inputRef = useRef(input);
  inputRef.current = input;
  const lastConnectionRef = useRef<EnvironmentConnection | null>(null);

  useEffect(() => {
    const isReconnect =
      lastConnectionRef.current !== null && lastConnectionRef.current !== connection;
    lastConnectionRef.current = connection;
    const release = query.watch(inputRef.current);
    // staleTime alone would keep answering with what the dead client returned,
    // so a reconnect forces one refetch — UNCONDITIONALLY. An in-flight fetch is
    // not a reason to skip it: that fetch may have been issued by the replaced
    // client, and only the refresh's fetchToken bump fences its late result out.
    if (isReconnect && connection !== null) {
      query.refresh(cacheKey);
    }
    return release;
  }, [query, cacheKey, connection]);

  const state = useAtomValue(query.getAtom(cacheKey));

  const refetch = useCallback(async () => {
    const next = await query.refreshAsync(cacheKey);
    return { data: next.data };
  }, [query, cacheKey]);

  return {
    data: state.data,
    isLoading: state.isLoading,
    isFetching: state.isFetching,
    error: state.error,
    refetch,
  };
}
