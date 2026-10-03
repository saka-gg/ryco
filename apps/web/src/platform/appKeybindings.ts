import type { KVService } from "@ryco/client-runtime/platform";
import { APP_KEYBINDINGS_STORAGE_KEY } from "@ryco/client-runtime/state/settings";
import { webKV } from "./kv";

function desktopPersistence() {
  if (typeof window === "undefined" || !window.desktopBridge) return null;
  const persistence = window.desktopBridge.appKeybindings;
  if (!persistence) throw new Error("Restart Ryco Desktop to enable app keybindings persistence.");
  return persistence;
}

/** Desktop uses one installation document, even when renderer origins/nodes change. */
export const appKeybindingsKV: KVService = {
  getItem: async (key) => {
    const desktop = desktopPersistence();
    return desktop ? desktop.read() : webKV.getItem(key);
  },
  setItem: async (key, value) => {
    const desktop = desktopPersistence();
    if (desktop) await desktop.write(value);
    else await webKV.setItem(key, value);
  },
  removeItem: async () => {
    throw new Error("Use Restore defaults to reset app keybindings.");
  },
};
export function subscribeAppKeybindingsChanges(listener: () => void): () => void {
  if (typeof window === "undefined") return () => undefined;
  const desktop = window.desktopBridge?.appKeybindings;
  if (desktop) return desktop.onChanged(listener);
  const onStorage = (event: StorageEvent) => {
    if (event.key === APP_KEYBINDINGS_STORAGE_KEY || event.key === null) listener();
  };
  window.addEventListener("storage", onStorage);
  return () => window.removeEventListener("storage", onStorage);
}
