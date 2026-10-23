import type { KeybindingRule } from "@ryco/contracts";
import {
  createAppKeybindingsStore,
  keybindingsForProject,
  type ScriptShortcutScope,
} from "@ryco/client-runtime/state/settings";
import { useMemo, useSyncExternalStore } from "react";
import { appKeybindingsKV, subscribeAppKeybindingsChanges } from "./platform/appKeybindings";

const store = createAppKeybindingsStore(appKeybindingsKV);
let subscribers = 0;
let hasSubscribed = false;
let stopPlatformSubscription: (() => void) | undefined;
const subscribe = (listener: () => void) => {
  const firstSubscriber = subscribers++ === 0;
  if (firstSubscriber) {
    stopPlatformSubscription = subscribeAppKeybindingsChanges(() => {
      void store.reload().catch(() => undefined);
    });
  }
  const stop = store.subscribe(listener);
  if (firstSubscriber && hasSubscribed) {
    void store.reload().catch(() => undefined);
  }
  hasSubscribed = true;
  return () => {
    stop();
    if (--subscribers === 0) stopPlatformSubscription?.();
  };
};

/** Non-React consumers share the snapshot, with no executable rules until hydration succeeds. */
export const hydrateAppKeybindings = store.hydrate;
export const retryAppKeybindings = store.reload;
export const updateAppKeybindingsPreferences = store.update;
export function getAppKeybindings(scope: ScriptShortcutScope | null = null) {
  return keybindingsForProject(store.getSnapshot().bindings, scope);
}
export function useAppKeybindingsState() {
  return useSyncExternalStore(subscribe, store.getSnapshot, store.getSnapshot);
}
export function useAllAppKeybindings() {
  return useAppKeybindingsState().bindings;
}
export function useAppKeybindings(scope: ScriptShortcutScope | null = null) {
  const bindings = useAllAppKeybindings();
  const environmentId = scope?.environmentId;
  const projectId = scope?.projectId;
  return useMemo(
    () =>
      keybindingsForProject(
        bindings,
        environmentId && projectId ? { environmentId, projectId } : null,
      ),
    [bindings, environmentId, projectId],
  );
}
export function resetAppKeybindings(): Promise<void> {
  return store.reset();
}
export function updateAppKeybinding(
  command: KeybindingRule["command"],
  rule: KeybindingRule | null,
) {
  return store.update((current) => ({
    ...current,
    rules: [...current.rules.filter((entry) => entry.command !== command), ...(rule ? [rule] : [])],
  }));
}
