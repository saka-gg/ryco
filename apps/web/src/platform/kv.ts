import type { KVService } from "@ryco/client-runtime/platform";

import { appLocalStorage } from "../hooks/useLocalStorage";
import { resolveStorage, type StateStorage } from "../lib/storage";

function browserStorage(): StateStorage {
  return resolveStorage(typeof window === "undefined" ? null : window.localStorage);
}

export function createWebKV(storage: StateStorage = browserStorage()): KVService {
  return {
    getItem: async (key) => await storage.getItem(key),
    setItem: async (key, value) => {
      await storage.setItem(key, value);
    },
    removeItem: async (key) => {
      await storage.removeItem(key);
    },
  };
}

/**
 * The browser's localStorage in every build, hosted Hub included. Only for values that hold no
 * node-owned data (no node ids, paths or content); `hostedStorageBoundary.test.ts` lists its users.
 */
export const webKV = createWebKV();

/**
 * localStorage in direct and Desktop builds, this window's memory in hosted Hub builds
 * (`appLocalStorage`). For values whose keys or contents carry node ids, paths or content.
 */
export const appKV = createWebKV(appLocalStorage);
