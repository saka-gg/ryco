import { RegistryContext, useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import type { Atom } from "effect/reactivity";
import {
  selectAvailableEditors,
  selectObservability,
  selectProviders,
  serverConfigAtom,
  welcomeAtom,
} from "@ryco/client-runtime/rpc";
import type {
  EditorId,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  ServerProvider,
} from "@ryco/contracts";
import { useCallback, useContext, useRef } from "react";

import { useSyncExternalStoreSelector } from "../hooks/useSyncExternalStoreSelector";
import { useSettingsTarget } from "../settingsTarget";

export * from "@ryco/client-runtime/rpc";

function useLatestAtomSubscription<A>(
  atom: Atom.Atom<A | null>,
  listener: (value: NonNullable<A>) => void,
): void {
  const listenerRef = useRef(listener);
  listenerRef.current = listener;

  const stableListener = useCallback((value: A | null) => {
    if (value === null) {
      return;
    }
    listenerRef.current(value as NonNullable<A>);
  }, []);

  useAtomSubscribe(atom, stableListener, { immediate: true });
}

export function useServerConfig(): ServerConfig | null {
  const primaryConfig = useAtomValue(serverConfigAtom);
  const target = useSettingsTarget();
  return target ? target.serverConfig : primaryConfig;
}

/**
 * Narrow subscription to the server config (the open settings surface's node
 * when one is targeted): re-renders only when `selector`'s result changes
 * under `isEqual` (Object.is by default). Prefer it over `useServerConfig`,
 * which re-renders on every config push, including each provider-status probe
 * during boot.
 */
export function useServerConfigSelector<T>(
  selector: (config: ServerConfig | null) => T,
  isEqual?: (left: T, right: T) => boolean,
): T {
  const target = useSettingsTarget();
  return useConfigSelector(
    target === null ? null : target.serverConfig,
    target !== null,
    selector,
    isEqual,
  );
}

/**
 * {@link useServerConfigSelector} for the primary node's config, ignoring any
 * settings target: for surfaces that show the primary node's own data.
 */
export function usePrimaryServerConfigSelector<T>(
  selector: (config: ServerConfig | null) => T,
  isEqual?: (left: T, right: T) => boolean,
): T {
  return useConfigSelector(null, false, selector, isEqual);
}

function useConfigSelector<T>(
  targetServerConfig: ServerConfig | null,
  hasTarget: boolean,
  selector: (config: ServerConfig | null) => T,
  isEqual: ((left: T, right: T) => boolean) | undefined,
): T {
  const registry = useContext(RegistryContext);
  const subscribe = useCallback(
    (listener: () => void) =>
      hasTarget ? () => undefined : registry.subscribe(serverConfigAtom, () => listener()),
    [hasTarget, registry],
  );
  const getSnapshot = useCallback(
    () => (hasTarget ? targetServerConfig : registry.get(serverConfigAtom)),
    [hasTarget, registry, targetServerConfig],
  );
  return useSyncExternalStoreSelector(subscribe, getSnapshot, selector, isEqual);
}

export function useServerProviders(): ReadonlyArray<ServerProvider> {
  return useServerConfigSelector(selectProviders);
}

export function useServerAvailableEditors(): ReadonlyArray<EditorId> {
  return useServerConfigSelector(selectAvailableEditors);
}

export function useServerObservability(): ServerConfig["observability"] | null {
  return useServerConfigSelector(selectObservability);
}

export function useServerWelcomeSubscription(
  listener: (payload: ServerLifecycleWelcomePayload) => void,
): void {
  useLatestAtomSubscription(welcomeAtom, listener);
}
