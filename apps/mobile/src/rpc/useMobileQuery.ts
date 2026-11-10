// React binding over a mobile query cache (mobileQueryCache): retain a key while
// the screen is mounted, read its atom state, and expose an imperative refetch
// for pull-to-refresh, with web's connection-identity fencing folded in — the
// live connection is read off the supervisor. After a reconnect only the screen
// on view reads again at once (reconnectRefetchGate.ts).
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentConnection } from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";
import { NavigationContext } from "@react-navigation/native";
import { use, useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import { useConnectionRegistry } from "../providers/ConnectionRegistryProvider";
import type { MobileQuery, MobileQueryState } from "./mobileQueryCache";
import { createReconnectRefetchGate } from "./reconnectRefetchGate";

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
  // The screen's own navigation (absent outside a navigator: always on screen).
  // Read in effects and listeners only, so focus changes never re-render.
  const navigation = use(NavigationContext);
  const [gate] = useState(createReconnectRefetchGate<EnvironmentConnection>);

  // The watch is keyed on the cache key alone; `input` is read through a ref so
  // a fresh object per render never re-subscribes.
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => query.watch(inputRef.current), [query, cacheKey]);

  // After a reconnect the screen on view reads again at once, one further down
  // the stack once it comes back into focus (reconnectRefetchGate.ts).
  useEffect(() => {
    gate.onConnection(connection, navigation?.isFocused() ?? true, query, cacheKey);
  }, [gate, query, cacheKey, connection, navigation]);
  useEffect(() => {
    if (navigation === undefined) return undefined;
    return navigation.addListener("focus", () => {
      gate.onFocus(connection !== null, query, cacheKey);
    });
  }, [gate, query, cacheKey, connection, navigation]);

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
    savedAt: state.savedAt,
    refetch,
  };
}

/**
 * A screen's own live answer, mirrored on the device (`defineSavedMirror`):
 * every non-null `live` value is written as the node's answer, and until the
 * first one arrives the saved copy is returned (null when there is none).
 * The screen keeps its own reads and write rules; actions must still wait for
 * live data.
 */
export function useSavedMirror<TInput, TData>(
  mirror: MobileQuery<TInput, TData>,
  input: TInput,
  live: TData | null,
): { readonly data: TData | null; readonly savedAt: number | null } {
  const cacheKey = mirror.keyOf(input);
  const inputRef = useRef(input);
  inputRef.current = input;
  useEffect(() => mirror.watch(inputRef.current), [mirror, cacheKey]);
  useEffect(() => {
    if (live === null) return;
    mirror.writeData(cacheKey, () => live, { live: true });
  }, [mirror, cacheKey, live]);
  const state = useAtomValue(mirror.getAtom(cacheKey));
  if (live !== null) return { data: live, savedAt: null };
  return { data: state.data, savedAt: state.savedAt };
}
