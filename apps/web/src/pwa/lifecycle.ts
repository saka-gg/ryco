import { makeStartupMarkName } from "../perf/startupInstrumentation";

export type HostedPwaInstallState =
  | "hidden"
  | "installed"
  | "manual-available"
  | "native-available";
export type HostedPwaRegistrationState = "disabled" | "ready" | "registering" | "unavailable";
export type HostedPwaUpdateState = "activating" | "idle" | "ready";

export interface HostedPwaSnapshot {
  readonly errorMessage: string | null;
  readonly installState: HostedPwaInstallState;
  readonly platform: "ios" | "other";
  readonly registrationState: HostedPwaRegistrationState;
  readonly updateState: HostedPwaUpdateState;
}

export interface HostedPwaServiceWorker extends EventTarget {
  readonly state: string;
  postMessage(message: unknown): void;
}

export interface HostedPwaServiceWorkerRegistration extends EventTarget {
  readonly installing: HostedPwaServiceWorker | null;
  readonly waiting: HostedPwaServiceWorker | null;
  update(): Promise<unknown>;
}

export interface HostedPwaServiceWorkerContainer extends EventTarget {
  readonly controller: HostedPwaServiceWorker | null;
  /** The registration controlling this page, if any. */
  getRegistration(): Promise<HostedPwaServiceWorkerRegistration | undefined>;
  register(
    scriptUrl: string,
    options: { readonly scope: string },
  ): Promise<HostedPwaServiceWorkerRegistration>;
}

interface HostedPwaWindow {
  addEventListener(type: string, listener: EventListener, options?: AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListener): void;
  matchMedia(query: string): MediaQueryList;
  reload(): void;
  /** Where available, registration waits for an idle period (bounded by `timeout`). */
  requestIdleCallback?(callback: () => void, options: { readonly timeout: number }): unknown;
}

export interface HostedPwaRuntime {
  /**
   * Settles once the app's own boot has (the hosted access check and root
   * route), so installing the worker — which downloads the precache — does
   * not compete with the session, directory and route chunks a first visit is
   * still loading. Absent: registration follows `load` directly.
   */
  readonly whenAppReady?: () => Promise<void>;
  readonly baseUrl: string;
  readonly document: { readonly readyState: DocumentReadyState };
  readonly navigator: {
    readonly maxTouchPoints: number;
    readonly serviceWorker?: HostedPwaServiceWorkerContainer;
    readonly standalone?: boolean;
    readonly userAgent: string;
  };
  readonly window: HostedPwaWindow;
  /**
   * Tab-scoped storage for the stale-build recovery guard (`sessionStorage`).
   * Absent or throwing: recovery is still bounded to one reload per page.
   */
  readonly sessionStorage?: Pick<Storage, "getItem" | "setItem">;
}

interface InstallPromptEvent extends Event {
  prompt(): Promise<void>;
  readonly userChoice: Promise<{ readonly outcome: "accepted" | "dismissed" }>;
}

const ACTIVATION_MESSAGE = "ryco:pwa:activate:v1";
/** The longest an idle period may hold registration back. */
const REGISTRATION_IDLE_TIMEOUT_MS = 5_000;
/** The longest the app's boot may hold registration back. */
const HOSTED_PWA_READINESS_TIMEOUT_MS = 15_000;
const REGISTRATION_ERROR = "Installation is temporarily unavailable.";
/**
 * Dispatched by Vite's built preload helper when a dynamic import, or a chunk
 * or stylesheet it preloads, fails. Every code-split load goes through it:
 * `lazyRouteComponent`, `React.lazy`, `preloadableLazy` and plain `import()`.
 */
const PRELOAD_ERROR_EVENT = "vite:preloadError";
/** The longest a stale build waits for its update to finish installing. */
const STALE_BUILD_UPDATE_TIMEOUT_MS = 20_000;
const STALE_BUILD_UPDATE_POLL_MS = 250;
/**
 * Automatic recovery takes at most this many actions per tab in this window
 * (activating a waiting update, or the one follow-up reload described in
 * `recoverFromStaleBuild`), so an origin that alternates between two builds (a
 * rolling deploy) or a build that is itself missing a chunk cannot keep
 * reloading the tab; the update control still offers a newer build.
 */
const STALE_BUILD_RECOVERY_WINDOW_MS = 60_000;
const STALE_BUILD_RECOVERY_LIMIT = 2;
/**
 * After asking a waiting worker to activate, reload anyway if control has not
 * changed by then. Chromium can stall a `skipWaiting()` activation when the
 * old worker is restarted for a fetch meanwhile (the reloading page's own
 * requests); a reposted message does not resume it, but releasing this client
 * does, and a navigation during activation waits for the new worker.
 */
const ACTIVATION_RELOAD_FALLBACK_MS = 5_000;
const STALE_BUILD_RECOVERY_KEY = "ryco:pwa:stale-build-recovery:v1";
const initialSnapshot: HostedPwaSnapshot = {
  errorMessage: null,
  installState: "hidden",
  platform: "other",
  registrationState: "disabled",
  updateState: "idle",
};

function normalizeBaseUrl(baseUrl: string): string {
  if (baseUrl === "" || baseUrl === "./") return "./";
  return baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
}

function isIosBrowser(runtime: HostedPwaRuntime): boolean {
  const userAgent = runtime.navigator.userAgent;
  return (
    /iPad|iPhone|iPod/.test(userAgent) ||
    (/Macintosh/.test(userAgent) && runtime.navigator.maxTouchPoints > 1)
  );
}

function isInstallPromptEvent(event: Event): event is InstallPromptEvent {
  const candidate = event as Partial<InstallPromptEvent>;
  return typeof candidate.prompt === "function" && candidate.userChoice instanceof Promise;
}

export function createHostedPwaLifecycle(runtime: HostedPwaRuntime) {
  let snapshot = initialSnapshot;
  let started = false;
  let installPrompt: InstallPromptEvent | null = null;
  let registration: HostedPwaServiceWorkerRegistration | null = null;
  let controllerObserved = Boolean(runtime.navigator.serviceWorker?.controller);
  let reloadIssued = false;
  let reloadRequested = false;
  let recoveringStaleBuild = false;
  const listeners = new Set<() => void>();
  const displayMode = runtime.window.matchMedia("(display-mode: standalone)");

  const publish = (patch: Partial<HostedPwaSnapshot>) => {
    const next = { ...snapshot, ...patch };
    if (
      Object.entries(next).every(
        ([key, value]) => snapshot[key as keyof HostedPwaSnapshot] === value,
      )
    ) {
      return;
    }
    snapshot = next;
    listeners.forEach((listener) => listener());
  };

  const installed = () => displayMode.matches || runtime.navigator.standalone === true;
  const fallbackInstallState = (): HostedPwaInstallState =>
    installed() ? "installed" : "manual-available";

  const onBeforeInstallPrompt: EventListener = (event) => {
    if (!isInstallPromptEvent(event) || installed()) return;
    event.preventDefault();
    installPrompt = event;
    publish({ installState: "native-available" });
  };
  const onAppInstalled: EventListener = () => {
    installPrompt = null;
    publish({ installState: "installed" });
  };
  const onDisplayModeChange = () => {
    if (installed()) {
      installPrompt = null;
      publish({ installState: "installed" });
    } else {
      publish({ installState: installPrompt ? "native-available" : "manual-available" });
    }
  };
  const onControllerChange: EventListener = () => {
    const wasControlled = controllerObserved;
    controllerObserved = Boolean(runtime.navigator.serviceWorker?.controller);
    if (reloadIssued || (!reloadRequested && !wasControlled)) return;
    reloadRequested = false;
    reload();
  };

  let activationFallback: ReturnType<typeof setTimeout> | undefined;
  const reload = () => {
    clearTimeout(activationFallback);
    if (reloadIssued) return;
    reloadIssued = true;
    runtime.window.reload();
  };

  const observeRegistration = (nextRegistration: HostedPwaServiceWorkerRegistration) => {
    // Recovery can observe the controlling registration before `register()`
    // resolves the same object.
    if (registration === nextRegistration) return;
    registration = nextRegistration;
    if (nextRegistration.waiting) publish({ updateState: "ready" });
    nextRegistration.addEventListener("updatefound", () => {
      const installing = nextRegistration.installing;
      if (!installing) return;
      installing.addEventListener("statechange", () => {
        if (installing.state === "installed" && runtime.navigator.serviceWorker?.controller) {
          publish({ updateState: "ready" });
        }
      });
    });
  };

  const register = async () => {
    const serviceWorker = runtime.navigator.serviceWorker;
    if (!serviceWorker) {
      publish({ registrationState: "unavailable", errorMessage: REGISTRATION_ERROR });
      return;
    }
    publish({ registrationState: "registering", errorMessage: null });
    try {
      const baseUrl = normalizeBaseUrl(runtime.baseUrl);
      observeRegistration(
        await serviceWorker.register(`${baseUrl}service-worker.js`, { scope: baseUrl }),
      );
      publish({ registrationState: "ready", errorMessage: null });
    } catch {
      publish({ registrationState: "unavailable", errorMessage: REGISTRATION_ERROR });
    }
  };

  const activate = (waiting: HostedPwaServiceWorker) => {
    reloadRequested = true;
    publish({ updateState: "activating" });
    // eslint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker.postMessage has no targetOrigin parameter.
    waiting.postMessage({ type: ACTIVATION_MESSAGE });
    clearTimeout(activationFallback);
    activationFallback = setTimeout(() => {
      if (started && reloadRequested) reload();
    }, ACTIVATION_RELOAD_FALLBACK_MS);
  };

  /** Automatic recoveries this tab started in the current window (`sessionStorage`). */
  const readRecoveryGuard = (now: number): { readonly since: number; readonly count: number } => {
    try {
      const raw = runtime.sessionStorage?.getItem(STALE_BUILD_RECOVERY_KEY);
      const value = raw ? (JSON.parse(raw) as { since?: unknown; count?: unknown }) : null;
      if (
        typeof value?.since === "number" &&
        typeof value.count === "number" &&
        now - value.since >= 0 &&
        now - value.since < STALE_BUILD_RECOVERY_WINDOW_MS
      ) {
        return { since: value.since, count: value.count };
      }
    } catch {
      // Unreadable: a fresh window.
    }
    return { since: now, count: 0 };
  };
  const writeRecoveryGuard = (guard: { readonly since: number; readonly count: number }) => {
    try {
      runtime.sessionStorage?.setItem(STALE_BUILD_RECOVERY_KEY, JSON.stringify(guard));
    } catch {
      // Storage unavailable: `reloadIssued` still bounds this page to one reload.
    }
  };

  /**
   * A chunk this build needs is gone from the origin: a deploy or a rollback
   * replaced the build while the page ran. Without a service worker the
   * router's own reload (or "Reload app") fetches the new build. A controlled
   * page would be answered from the worker's cached boot document instead, and
   * the new worker installs only to wait behind this page, so ask for the
   * update, wait a bounded time for it to install, and activate it: the
   * existing controller-change reload then boots the new build. No newer
   * worker means no reload, so a build that is genuinely broken cannot loop.
   */
  const recoverFromStaleBuild = async () => {
    const serviceWorker = runtime.navigator.serviceWorker;
    if (recoveringStaleBuild || reloadIssued || !serviceWorker?.controller) return;
    recoveringStaleBuild = true;
    try {
      const controlling = registration ?? (await serviceWorker.getRegistration().catch(() => null));
      if (!started || !controlling) return;
      observeRegistration(controlling);
      const deadline = Date.now() + STALE_BUILD_UPDATE_TIMEOUT_MS;
      if (!controlling.waiting) {
        // A navigation's own update check may already be installing it; the
        // update joins that job. A failed or hung check still waits for it.
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          controlling.update().catch(() => undefined),
          new Promise((resolve) => {
            timer = setTimeout(resolve, STALE_BUILD_UPDATE_TIMEOUT_MS);
          }),
        ]);
        clearTimeout(timer);
      }
      while (!controlling.waiting && controlling.installing && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, STALE_BUILD_UPDATE_POLL_MS));
      }
      const waiting = controlling.waiting;
      if (!started || snapshot.updateState === "activating") return;
      const guard = readRecoveryGuard(Date.now());
      if (!waiting) {
        // Nothing newer, yet this tab activated an update moments ago: this
        // page booted the previous worker's cached document while that
        // activation completed (the reload that releases a stalled activation
        // is still answered by the old worker), and the new worker claimed it
        // before this lifecycle started. One more reload loads the new build.
        // Without an earlier activation this is the current build failing, and
        // reloading would not help.
        if (guard.count === 0 || guard.count >= STALE_BUILD_RECOVERY_LIMIT) return;
        writeRecoveryGuard({ since: guard.since, count: guard.count + 1 });
        reload();
        return;
      }
      // The update control offers it either way; only the automatic
      // activation is guarded.
      publish({ updateState: "ready" });
      if (guard.count >= STALE_BUILD_RECOVERY_LIMIT) return;
      writeRecoveryGuard({ since: guard.since, count: guard.count + 1 });
      activate(waiting);
    } finally {
      recoveringStaleBuild = false;
    }
  };
  // Never `preventDefault()`: the failed import must still reject, so its
  // caller shows its error (or the router reloads) as it would otherwise.
  const onPreloadError: EventListener = () => {
    void recoverFromStaleBuild();
  };

  const registerWhenSettled = async () => {
    await runtime.whenAppReady?.().catch(() => undefined);
    const idle = runtime.window.requestIdleCallback?.bind(runtime.window);
    if (idle) {
      await new Promise<void>((resolve) => {
        idle(() => resolve(), { timeout: REGISTRATION_IDLE_TIMEOUT_MS });
      });
    }
    if (!started) return;
    await register();
  };

  return {
    activateUpdate(): void {
      const waiting = registration?.waiting;
      if (!waiting || snapshot.updateState !== "ready") return;
      activate(waiting);
    },
    /**
     * "Reload app": switches to a waiting update when one is ready, since a
     * plain reload of a controlled page boots the cached build again; reloads
     * otherwise. An update already activating reloads through its controller
     * change.
     */
    reloadApp(): void {
      if (snapshot.updateState === "activating") return;
      if (snapshot.updateState === "ready" && registration?.waiting) {
        activate(registration.waiting);
        return;
      }
      reload();
    },
    dismissInstall(): void {
      installPrompt = null;
      publish({ installState: installed() ? "installed" : "hidden" });
    },
    getSnapshot(): HostedPwaSnapshot {
      return snapshot;
    },
    async promptInstall(): Promise<void> {
      const prompt = installPrompt;
      if (!prompt) return;
      installPrompt = null;
      publish({ installState: "hidden" });
      await prompt.prompt();
      const choice = await prompt.userChoice;
      if (choice.outcome === "dismissed" && !installed()) {
        publish({ installState: "manual-available" });
      }
    },
    async start(input: { readonly enabled: boolean }): Promise<void> {
      if (started) return;
      started = true;
      if (!input.enabled) return;

      controllerObserved = Boolean(runtime.navigator.serviceWorker?.controller);
      reloadIssued = false;
      publish({
        installState: fallbackInstallState(),
        platform: isIosBrowser(runtime) ? "ios" : "other",
      });
      runtime.window.addEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      runtime.window.addEventListener("appinstalled", onAppInstalled);
      runtime.window.addEventListener(PRELOAD_ERROR_EVENT, onPreloadError);
      displayMode.addEventListener("change", onDisplayModeChange);
      runtime.navigator.serviceWorker?.addEventListener("controllerchange", onControllerChange);

      if (runtime.document.readyState === "complete") {
        await registerWhenSettled();
      } else {
        runtime.window.addEventListener("load", () => void registerWhenSettled(), { once: true });
      }
    },
    stop(): void {
      if (!started) return;
      started = false;
      installPrompt = null;
      registration = null;
      controllerObserved = false;
      reloadIssued = false;
      reloadRequested = false;
      recoveringStaleBuild = false;
      clearTimeout(activationFallback);
      runtime.window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      runtime.window.removeEventListener("appinstalled", onAppInstalled);
      runtime.window.removeEventListener(PRELOAD_ERROR_EVENT, onPreloadError);
      displayMode.removeEventListener("change", onDisplayModeChange);
      runtime.navigator.serviceWorker?.removeEventListener("controllerchange", onControllerChange);
      snapshot = initialSnapshot;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener: () => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

export type HostedPwaLifecycle = ReturnType<typeof createHostedPwaLifecycle>;

/**
 * Resolves on the boot gate's `root-before-load-ready` startup mark (already
 * recorded or still to come), or after {@link HOSTED_PWA_READINESS_TIMEOUT_MS}.
 */
function whenBrowserAppReady(): Promise<void> {
  const markName = makeStartupMarkName("root-before-load-ready");
  return new Promise<void>((resolve) => {
    let observer: PerformanceObserver | null = null;
    const done = () => {
      observer?.disconnect();
      observer = null;
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, HOSTED_PWA_READINESS_TIMEOUT_MS);
    try {
      if (performance.getEntriesByName(markName, "mark").length > 0) {
        done();
        return;
      }
      observer = new PerformanceObserver((list) => {
        if (list.getEntriesByName(markName, "mark").length > 0) done();
      });
      observer.observe({ type: "mark", buffered: true });
    } catch {
      // No observable marks: the bounded timer still releases registration.
    }
  });
}

function browserSessionStorage(): Storage | null {
  try {
    return window.sessionStorage;
  } catch {
    return null;
  }
}

function createBrowserRuntime(): HostedPwaRuntime {
  const browserNavigator = navigator as Navigator & { readonly standalone?: boolean };
  const storage = browserSessionStorage();
  return {
    whenAppReady: whenBrowserAppReady,
    baseUrl: import.meta.env.BASE_URL,
    document,
    navigator: {
      maxTouchPoints: browserNavigator.maxTouchPoints,
      userAgent: browserNavigator.userAgent,
      ...(browserNavigator.serviceWorker
        ? {
            serviceWorker:
              browserNavigator.serviceWorker as unknown as HostedPwaServiceWorkerContainer,
          }
        : {}),
      ...(typeof browserNavigator.standalone === "boolean"
        ? { standalone: browserNavigator.standalone }
        : {}),
    },
    ...(storage ? { sessionStorage: storage } : {}),
    window: {
      addEventListener: window.addEventListener.bind(window),
      removeEventListener: window.removeEventListener.bind(window),
      matchMedia: window.matchMedia.bind(window),
      reload: () => window.location.reload(),
      ...(typeof window.requestIdleCallback === "function"
        ? {
            requestIdleCallback: (callback: () => void, options: { readonly timeout: number }) =>
              window.requestIdleCallback(callback, options),
          }
        : {}),
    },
  };
}

export const hostedPwaLifecycle =
  typeof window === "undefined" ? null : createHostedPwaLifecycle(createBrowserRuntime());
