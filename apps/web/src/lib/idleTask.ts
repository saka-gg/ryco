type IdleCallbackHandle = number;

interface IdleCallbackHost {
  readonly requestIdleCallback?: (
    callback: () => void,
    options?: { readonly timeout: number },
  ) => IdleCallbackHandle;
  readonly cancelIdleCallback?: (handle: IdleCallbackHandle) => void;
}

const IDLE_TASK_FALLBACK_DELAY_MS = 100;

export function scheduleIdleTask(callback: () => void, timeoutMs = 1_000): () => void {
  const host = globalThis as typeof globalThis & IdleCallbackHost;
  let active = true;
  const run = () => {
    if (!active) return;
    active = false;
    callback();
  };

  if (typeof host.requestIdleCallback === "function") {
    const handle = host.requestIdleCallback(run, { timeout: timeoutMs });
    return () => {
      if (!active) return;
      active = false;
      host.cancelIdleCallback?.(handle);
    };
  }

  const handle = globalThis.setTimeout(run, IDLE_TASK_FALLBACK_DELAY_MS);
  return () => {
    if (!active) return;
    active = false;
    globalThis.clearTimeout(handle);
  };
}
