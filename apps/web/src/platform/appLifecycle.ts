import type { AppLifecycleService } from "@ryco/client-runtime/platform";

export const webAppLifecycle: AppLifecycleService = {
  isForeground: () => typeof document === "undefined" || document.visibilityState !== "hidden",
  isOnline: () => typeof navigator === "undefined" || navigator.onLine !== false,
  subscribe: (listener) => {
    if (typeof document === "undefined" || typeof window === "undefined") {
      return () => undefined;
    }
    const onVisibility = () =>
      listener(document.visibilityState === "hidden" ? "background" : "foreground");
    const onOffline = () => listener("offline");
    const onOnline = () => listener("online");
    const onPageShow = () => listener("resume");
    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("offline", onOffline);
    window.addEventListener("online", onOnline);
    window.addEventListener("pageshow", onPageShow);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("offline", onOffline);
      window.removeEventListener("online", onOnline);
      window.removeEventListener("pageshow", onPageShow);
    };
  },
};

export interface VisibilityAwarePoller {
  readonly refresh: () => Promise<void>;
  readonly stop: () => void;
}

/**
 * A poller that runs while the app is in the foreground and runs again when it returns (foreground,
 * resume, online). It lives beside the web lifecycle, its consumer, so it loads with boot.
 */
export function createVisibilityAwarePoller(input: {
  readonly lifecycle: AppLifecycleService;
  readonly run: () => Promise<unknown>;
  readonly resolveDelayMs: () => number | false;
  readonly runImmediately?: boolean;
  readonly jitterRatio?: number;
  readonly random?: () => number;
  readonly setTimeout?: typeof globalThis.setTimeout;
  readonly clearTimeout?: typeof globalThis.clearTimeout;
}): VisibilityAwarePoller {
  const setTimer = input.setTimeout ?? globalThis.setTimeout;
  const clearTimer = input.clearTimeout ?? globalThis.clearTimeout;
  const random = input.random ?? Math.random;
  const jitterRatio = Math.max(0, Math.min(0.5, input.jitterRatio ?? 0));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const clearScheduled = () => {
    if (timer !== null) {
      clearTimer(timer);
      timer = null;
    }
  };
  const schedule = () => {
    clearScheduled();
    if (stopped || !input.lifecycle.isForeground()) return;
    const baseDelay = input.resolveDelayMs();
    if (baseDelay === false || baseDelay <= 0) return;
    const jitter = baseDelay * jitterRatio * (random() * 2 - 1);
    const delay = Math.max(1, Math.round(baseDelay + jitter));
    timer = setTimer(() => {
      timer = null;
      void refresh();
    }, delay);
  };
  const refresh = (): Promise<void> => {
    if (stopped) return Promise.resolve();
    clearScheduled();
    if (inFlight) return inFlight;
    const promise = Promise.resolve()
      .then(input.run)
      .then(
        () => undefined,
        () => undefined,
      )
      .finally(() => {
        if (inFlight === promise) inFlight = null;
        schedule();
      });
    inFlight = promise;
    return promise;
  };
  const unsubscribe = input.lifecycle.subscribe((event) => {
    if (event === "background") {
      clearScheduled();
      return;
    }
    if (
      (event === "foreground" || event === "resume" || event === "online") &&
      input.lifecycle.isForeground()
    ) {
      void refresh();
    }
  });

  if (input.runImmediately ?? true) void refresh();
  else schedule();

  return {
    refresh,
    stop: () => {
      if (stopped) return;
      stopped = true;
      clearScheduled();
      unsubscribe();
    },
  };
}
