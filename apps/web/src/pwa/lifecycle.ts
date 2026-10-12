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
}

export interface HostedPwaServiceWorkerContainer extends EventTarget {
  readonly controller: HostedPwaServiceWorker | null;
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
    reloadIssued = true;
    runtime.window.reload();
  };

  const observeRegistration = (nextRegistration: HostedPwaServiceWorkerRegistration) => {
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
      reloadRequested = true;
      publish({ updateState: "activating" });
      // eslint-disable-next-line unicorn/require-post-message-target-origin -- ServiceWorker.postMessage has no targetOrigin parameter.
      waiting.postMessage({ type: ACTIVATION_MESSAGE });
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
      runtime.window.removeEventListener("beforeinstallprompt", onBeforeInstallPrompt);
      runtime.window.removeEventListener("appinstalled", onAppInstalled);
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

function createBrowserRuntime(): HostedPwaRuntime {
  const browserNavigator = navigator as Navigator & { readonly standalone?: boolean };
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
