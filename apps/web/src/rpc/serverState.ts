import { useAtomSubscribe, useAtomValue } from "@effect/atom-react";
import type { Atom } from "effect/unstable/reactivity";
import {
  selectAvailableEditors,
  selectKeybindingsConfigPath,
  selectObservability,
  selectProviders,
  selectSettings,
  serverConfigAtom,
  serverConfigUpdatedAtom,
  welcomeAtom,
  type ServerConfigUpdatedNotification,
} from "@ryco/client-runtime/rpc";
import type {
  EditorId,
  ServerConfig,
  ServerLifecycleWelcomePayload,
  ServerProvider,
  ServerSettings,
} from "@ryco/contracts";
import { useCallback, useRef } from "react";

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

export function useServerSettings(): ServerSettings {
  return selectSettings(useServerConfig());
}

export function useServerProviders(): ReadonlyArray<ServerProvider> {
  return selectProviders(useServerConfig());
}

export function useServerAvailableEditors(): ReadonlyArray<EditorId> {
  return selectAvailableEditors(useServerConfig());
}

export function useServerKeybindingsConfigPath(): string | null {
  return selectKeybindingsConfigPath(useServerConfig());
}

export function useServerObservability(): ServerConfig["observability"] | null {
  return selectObservability(useServerConfig());
}

export function useServerWelcomeSubscription(
  listener: (payload: ServerLifecycleWelcomePayload) => void,
): void {
  useLatestAtomSubscription(welcomeAtom, listener);
}

export function useServerConfigUpdatedSubscription(
  listener: (notification: ServerConfigUpdatedNotification) => void,
): void {
  useLatestAtomSubscription(serverConfigUpdatedAtom, listener);
}
