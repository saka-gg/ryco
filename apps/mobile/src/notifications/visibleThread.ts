import type { ScopedThreadRef } from "@ryco/contracts";

let visibleThread: ScopedThreadRef | null = null;

/**
 * Marks the thread whose screen has focus, which its alerts stay quiet for
 * while the app is in front. The returned function unmarks it, unless another
 * thread's screen took focus since.
 */
export function markThreadVisible(ref: ScopedThreadRef): () => void {
  visibleThread = ref;
  return () => {
    if (visibleThread === ref) visibleThread = null;
  };
}

export function readVisibleThread(): ScopedThreadRef | null {
  return visibleThread;
}
