import { useLazyComponentReady, type PreloadableModule } from "../../../lib/preloadableLazy";
import { notifyChatSurfaceLoadFailure } from "../../chat/chatViewLazySurfaces";

// Surfaces whose shared load failed together, with the retry of each, so one
// failure shows one toast and its Retry brings every surface back.
const failedLoads = new Map<unknown, Array<() => void>>();

/** Exported for tests; surfaces report through `usePhoneThreadSurfaceReady`. */
export function reportPhoneThreadSurfaceLoadFailure(error: unknown, retry: () => void): void {
  const retries = failedLoads.get(error);
  if (retries) {
    retries.push(retry);
    return;
  }
  const pending = [retry];
  failedLoads.set(error, pending);
  // Every surface that waited on the failed load reports it in the microtasks
  // of one task; anything later belongs to a fresh attempt. The toast keeps
  // its own list, so dropping the entry only ends the grouping.
  setTimeout(() => {
    failedLoads.delete(error);
  }, 0);
  notifyChatSurfaceLoadFailure("phone controls", error, () => {
    for (const retryLoad of pending) retryLoad();
  });
}

/** Whether a phone thread surface can mount, loading the surfaces while `wanted`. */
export function usePhoneThreadSurfaceReady(component: PreloadableModule, wanted: boolean): boolean {
  return useLazyComponentReady(component, wanted, {
    onLoadError: reportPhoneThreadSurfaceLoadFailure,
  });
}
