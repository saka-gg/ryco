import type { SettingsSharingStorage } from "@ryco/client-runtime/state/settings/settingsSharingClock";
import Storage from "expo-sqlite/kv-store";

/** The synchronous half of expo-sqlite's kv-store, which shared settings need. */
export interface SyncKeyValueStore {
  readonly getItemSync: (key: string) => string | null;
  readonly setItemSync: (key: string, value: string) => void;
}

/**
 * Shared device settings' client id, clock and newest-value cache on the phone
 * (`createScopedSettingsSharingPersistence`), in the same SQLite-backed store as `mobileKV`.
 * Synchronous on purpose: an edit is stamped the moment it is made, and the clock persists its
 * last stamp before the write goes out. Writes happen only when the clock moves past a stamp or
 * the cache learns a newer value, so they stay rare. Not a secret store.
 */
export function createMobileSettingsSharingStorage(
  store: SyncKeyValueStore = Storage,
): SettingsSharingStorage {
  return {
    getItem: (key) => store.getItemSync(key),
    setItem: (key, value) => store.setItemSync(key, value),
  };
}
