import { createBatchLaunchStore, type BatchLaunchLock } from "@ryco/client-runtime/state/composer";
import { webKV } from "./platform/kv";

// Persist only destination identities/statuses, never prompt/attachment data or
// authenticated responses. Write-ahead durability is required even in hosted mode.
export const webBatchLaunchLock: BatchLaunchLock = {
  exclusive: async (name, operation) => {
    if (!globalThis.navigator?.locks)
      throw new Error("Cross-tab launch coordination is unavailable.");
    return navigator.locks.request(name, { mode: "exclusive" }, operation);
  },
};
export const batchLaunchStore = createBatchLaunchStore(webKV, webBatchLaunchLock);

// Notifications refresh presentation only. Claims and writes remain atomic under Web Locks.
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === "ryco:batch-launches:v1") void batchLaunchStore.refresh();
  });
