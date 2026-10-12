import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createHostedPwaLifecycle,
  type HostedPwaRuntime,
  type HostedPwaServiceWorker,
  type HostedPwaServiceWorkerRegistration,
} from "./lifecycle";

class FakeServiceWorker extends EventTarget implements HostedPwaServiceWorker {
  state = "installed";
  postMessage = vi.fn();
}

class FakeRegistration extends EventTarget implements HostedPwaServiceWorkerRegistration {
  installing: HostedPwaServiceWorker | null = null;
  waiting: HostedPwaServiceWorker | null = null;
  update = vi.fn(async (): Promise<unknown> => undefined);

  /** A newer worker starts installing, as an update check that finds one does. */
  beginInstall(): FakeServiceWorker {
    const worker = new FakeServiceWorker();
    worker.state = "installing";
    this.installing = worker;
    this.dispatchEvent(new Event("updatefound"));
    return worker;
  }

  finishInstall(worker: FakeServiceWorker): void {
    this.installing = null;
    this.waiting = worker;
    worker.state = "installed";
    worker.dispatchEvent(new Event("statechange"));
  }
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: HostedPwaServiceWorker | null = null;
  readonly registration = new FakeRegistration();
  getRegistration = vi.fn(async () => this.registration);
  register = vi.fn(async () => this.registration);
}

class FakeStorage {
  readonly values = new Map<string, string>();
  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}

class FakeMediaQueryList extends EventTarget {
  media = "(display-mode: standalone)";
  onchange = null;
  matches = false;

  addListener(listener: (event: MediaQueryListEvent) => void): void {
    this.addEventListener("change", listener as EventListener);
  }

  removeListener(listener: (event: MediaQueryListEvent) => void): void {
    this.removeEventListener("change", listener as EventListener);
  }

  dispatch(matches: boolean): void {
    this.matches = matches;
    this.dispatchEvent(new Event("change"));
  }
}

function runtime(input?: {
  readonly userAgent?: string;
  readonly standalone?: boolean;
  readonly readyState?: DocumentReadyState;
}) {
  const windowTarget = new EventTarget();
  const serviceWorker = new FakeServiceWorkerContainer();
  const displayMode = new FakeMediaQueryList();
  displayMode.matches = input?.standalone ?? false;
  const reload = vi.fn();
  const sessionStorage = new FakeStorage();
  const value: HostedPwaRuntime = {
    baseUrl: "/",
    document: { readyState: input?.readyState ?? "complete" },
    navigator: {
      maxTouchPoints: input?.userAgent?.includes("iPad") ? 5 : 0,
      serviceWorker,
      standalone: input?.standalone ?? false,
      userAgent: input?.userAgent ?? "Mozilla/5.0 Chrome/140 Mobile",
    },
    window: {
      addEventListener: windowTarget.addEventListener.bind(windowTarget),
      removeEventListener: windowTarget.removeEventListener.bind(windowTarget),
      matchMedia: () => displayMode,
      reload,
    },
    sessionStorage,
  };
  return { displayMode, reload, runtime: value, serviceWorker, sessionStorage, windowTarget };
}

function installPrompt(outcome: "accepted" | "dismissed") {
  const event = new Event("beforeinstallprompt") as Event & {
    prompt: ReturnType<typeof vi.fn>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
  };
  event.prompt = vi.fn(async () => undefined);
  event.userChoice = Promise.resolve({ outcome });
  return event;
}

describe("hosted PWA lifecycle", () => {
  it("keeps the native install prompt in memory and clears it after use", async () => {
    const test = runtime();
    const lifecycle = createHostedPwaLifecycle(test.runtime);
    await lifecycle.start({ enabled: true });
    const event = installPrompt("dismissed");

    test.windowTarget.dispatchEvent(event);
    expect(lifecycle.getSnapshot().installState).toBe("native-available");

    await lifecycle.promptInstall();
    expect(event.prompt).toHaveBeenCalledOnce();
    expect(lifecycle.getSnapshot().installState).toBe("manual-available");

    test.windowTarget.dispatchEvent(new Event("appinstalled"));
    expect(lifecycle.getSnapshot().installState).toBe("installed");
  });

  it("selects iOS instructions and hides install help in standalone mode", async () => {
    const ios = runtime({ userAgent: "Mozilla/5.0 (iPhone) AppleWebKit Safari" });
    const lifecycle = createHostedPwaLifecycle(ios.runtime);
    await lifecycle.start({ enabled: true });
    expect(lifecycle.getSnapshot()).toMatchObject({
      installState: "manual-available",
      platform: "ios",
    });

    ios.displayMode.dispatch(true);
    expect(lifecycle.getSnapshot().installState).toBe("installed");
  });

  it("waits for an explicit update action before activating and reloads once", async () => {
    const test = runtime();
    const waiting = new FakeServiceWorker();
    test.serviceWorker.registration.waiting = waiting;
    test.serviceWorker.controller = new FakeServiceWorker();
    const lifecycle = createHostedPwaLifecycle(test.runtime);
    await lifecycle.start({ enabled: true });

    expect(lifecycle.getSnapshot().updateState).toBe("ready");
    expect(waiting.postMessage).not.toHaveBeenCalled();

    lifecycle.activateUpdate();
    expect(waiting.postMessage).toHaveBeenCalledWith({ type: "ryco:pwa:activate:v1" });
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(test.reload).toHaveBeenCalledOnce();
  });

  it("does not reload on initial control and reloads once on later controller replacement", async () => {
    const test = runtime();
    const lifecycle = createHostedPwaLifecycle(test.runtime);
    await lifecycle.start({ enabled: true });

    test.serviceWorker.controller = new FakeServiceWorker();
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(test.reload).not.toHaveBeenCalled();

    test.serviceWorker.controller = new FakeServiceWorker();
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(test.reload).toHaveBeenCalledOnce();
  });

  it("reloads a previously controlled client when another client activates an update", async () => {
    const test = runtime();
    test.serviceWorker.controller = new FakeServiceWorker();
    const lifecycle = createHostedPwaLifecycle(test.runtime);
    await lifecycle.start({ enabled: true });

    test.serviceWorker.controller = new FakeServiceWorker();
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
    expect(test.reload).toHaveBeenCalledOnce();
  });

  it("keeps registration failures bounded and ordinary hosted use available", async () => {
    const test = runtime();
    test.serviceWorker.register.mockRejectedValueOnce(new Error("sensitive registration detail"));
    const lifecycle = createHostedPwaLifecycle(test.runtime);

    await lifecycle.start({ enabled: true });
    expect(lifecycle.getSnapshot()).toMatchObject({
      registrationState: "unavailable",
      errorMessage: "Installation is temporarily unavailable.",
    });
    expect(JSON.stringify(lifecycle.getSnapshot())).not.toContain("sensitive registration detail");
  });

  it("registers only after the app has booted and the page has gone idle", async () => {
    const test = runtime();
    let appReady: () => void = () => undefined;
    let idle: (() => void) | null = null;
    const idleOptions: Array<{ readonly timeout: number }> = [];
    const lifecycle = createHostedPwaLifecycle({
      ...test.runtime,
      whenAppReady: () =>
        new Promise<void>((resolve) => {
          appReady = resolve;
        }),
      window: {
        ...test.runtime.window,
        requestIdleCallback: (callback, options) => {
          idle = callback;
          idleOptions.push(options);
          return 1;
        },
      },
    });
    const starting = lifecycle.start({ enabled: true });
    await Promise.resolve();
    expect(idle).toBeNull();
    expect(test.serviceWorker.register).not.toHaveBeenCalled();
    appReady();
    await vi.waitFor(() => expect(idle).not.toBeNull());
    expect(idleOptions).toEqual([{ timeout: 5_000 }]);
    expect(test.serviceWorker.register).not.toHaveBeenCalled();
    idle!();
    await starting;
    expect(test.serviceWorker.register).toHaveBeenCalledOnce();
    expect(lifecycle.getSnapshot().registrationState).toBe("ready");
  });

  it("does not register when stopped while waiting for boot", async () => {
    const test = runtime();
    let appReady: () => void = () => undefined;
    const lifecycle = createHostedPwaLifecycle({
      ...test.runtime,
      whenAppReady: () =>
        new Promise<void>((resolve) => {
          appReady = resolve;
        }),
    });
    const starting = lifecycle.start({ enabled: true });
    lifecycle.stop();
    appReady();
    await starting;
    expect(test.serviceWorker.register).not.toHaveBeenCalled();
  });

  it("does not touch service workers when PWA behavior is disabled", async () => {
    const test = runtime();
    const lifecycle = createHostedPwaLifecycle(test.runtime);

    await lifecycle.start({ enabled: false });
    expect(test.serviceWorker.register).not.toHaveBeenCalled();
    expect(lifecycle.getSnapshot().registrationState).toBe("disabled");
  });
});

const ACTIVATION = { type: "ryco:pwa:activate:v1" };

/** A page the previous build's worker controls; registration is still deferred to `load`. */
async function controlledPage() {
  const test = runtime({ readyState: "loading" });
  test.serviceWorker.controller = new FakeServiceWorker();
  const lifecycle = createHostedPwaLifecycle(test.runtime);
  await lifecycle.start({ enabled: true });
  const preloadError = () => test.windowTarget.dispatchEvent(new Event("vite:preloadError"));
  /** The activated worker takes control, as `skipWaiting` + `clients.claim` do. */
  const takeControl = () => {
    test.serviceWorker.controller = new FakeServiceWorker();
    test.serviceWorker.dispatchEvent(new Event("controllerchange"));
  };
  return { ...test, lifecycle, preloadError, takeControl };
}

describe("hosted PWA stale-build recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("asks for the update after a failed chunk load and activates it once installed", async () => {
    const page = await controlledPage();
    const registration = page.serviceWorker.registration;
    let installed: FakeServiceWorker | null = null;
    registration.update.mockImplementationOnce(async () => {
      installed = registration.beginInstall();
      queueMicrotask(() => registration.finishInstall(installed!));
    });

    page.preloadError();

    await vi.waitFor(() => expect(installed?.postMessage).toHaveBeenCalledWith(ACTIVATION));
    expect(page.serviceWorker.getRegistration).toHaveBeenCalledOnce();
    expect(registration.update).toHaveBeenCalledOnce();
    expect(page.lifecycle.getSnapshot().updateState).toBe("activating");
    expect(page.reload).not.toHaveBeenCalled();

    page.takeControl();
    page.takeControl();
    expect(page.reload).toHaveBeenCalledOnce();
  });

  it("activates a worker that already waits without another update check", async () => {
    const page = await controlledPage();
    const waiting = new FakeServiceWorker();
    page.serviceWorker.registration.waiting = waiting;

    page.preloadError();

    await vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith(ACTIVATION));
    expect(page.serviceWorker.registration.update).not.toHaveBeenCalled();
  });

  it("waits for a slow install, bounded, and then activates it", async () => {
    vi.useFakeTimers();
    const page = await controlledPage();
    const registration = page.serviceWorker.registration;
    const worker = registration.beginInstall();

    page.preloadError();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(worker.postMessage).not.toHaveBeenCalled();

    registration.finishInstall(worker);
    await vi.advanceTimersByTimeAsync(250);
    expect(worker.postMessage).toHaveBeenCalledWith(ACTIVATION);
  });

  it("gives up after 20 seconds when the install never finishes", async () => {
    vi.useFakeTimers();
    const page = await controlledPage();
    const registration = page.serviceWorker.registration;
    const worker = registration.beginInstall();

    page.preloadError();
    await vi.advanceTimersByTimeAsync(20_000);
    registration.finishInstall(worker);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(worker.postMessage).not.toHaveBeenCalled();
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("does nothing, and so cannot loop, when no newer worker exists", async () => {
    const page = await controlledPage();

    page.preloadError();
    page.preloadError();

    await vi.waitFor(() => expect(page.serviceWorker.registration.update).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.lifecycle.getSnapshot().updateState).toBe("idle");
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("tolerates a failed update check", async () => {
    const page = await controlledPage();
    page.serviceWorker.registration.update.mockRejectedValueOnce(new Error("offline"));

    page.preloadError();

    await vi.waitFor(() => expect(page.serviceWorker.registration.update).toHaveBeenCalledOnce());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(page.reload).not.toHaveBeenCalled();
  });

  it("leaves a page no worker controls to the router's own reload", async () => {
    const test = runtime();
    const lifecycle = createHostedPwaLifecycle(test.runtime);
    await lifecycle.start({ enabled: true });

    test.windowTarget.dispatchEvent(new Event("vite:preloadError"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(test.serviceWorker.getRegistration).not.toHaveBeenCalled();
    expect(test.serviceWorker.registration.update).not.toHaveBeenCalled();
    expect(test.reload).not.toHaveBeenCalled();
  });

  it("activates automatically at most twice a minute and leaves the update control", async () => {
    const page = await controlledPage();
    page.sessionStorage.setItem(
      "ryco:pwa:stale-build-recovery:v1",
      JSON.stringify({ since: Date.now() - 10_000, count: 2 }),
    );
    const waiting = new FakeServiceWorker();
    page.serviceWorker.registration.waiting = waiting;

    page.preloadError();

    await vi.waitFor(() => expect(page.lifecycle.getSnapshot().updateState).toBe("ready"));
    expect(waiting.postMessage).not.toHaveBeenCalled();

    page.lifecycle.reloadApp();
    expect(waiting.postMessage).toHaveBeenCalledWith(ACTIVATION);
    expect(page.reload).not.toHaveBeenCalled();
    page.takeControl();
    expect(page.reload).toHaveBeenCalledOnce();
  });

  it("counts automatic activations in this tab, and starts a new window after a minute", async () => {
    const page = await controlledPage();
    const key = "ryco:pwa:stale-build-recovery:v1";
    page.sessionStorage.setItem(key, JSON.stringify({ since: Date.now() - 10_000, count: 1 }));
    const waiting = new FakeServiceWorker();
    page.serviceWorker.registration.waiting = waiting;

    page.preloadError();

    await vi.waitFor(() => expect(waiting.postMessage).toHaveBeenCalledWith(ACTIVATION));
    expect(JSON.parse(page.sessionStorage.getItem(key)!)).toMatchObject({ count: 2 });

    const later = await controlledPage();
    later.sessionStorage.setItem(key, JSON.stringify({ since: Date.now() - 61_000, count: 2 }));
    const next = new FakeServiceWorker();
    later.serviceWorker.registration.waiting = next;
    later.preloadError();
    await vi.waitFor(() => expect(next.postMessage).toHaveBeenCalledWith(ACTIVATION));
    expect(JSON.parse(later.sessionStorage.getItem(key)!)).toMatchObject({ count: 1 });
  });

  it("reloads once when an activation does not take control in time", async () => {
    vi.useFakeTimers();
    const page = await controlledPage();
    const waiting = new FakeServiceWorker();
    page.serviceWorker.registration.waiting = waiting;

    page.preloadError();
    await vi.advanceTimersByTimeAsync(0);
    expect(waiting.postMessage).toHaveBeenCalledWith(ACTIVATION);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(page.reload).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(page.reload).toHaveBeenCalledOnce();

    page.takeControl();
    expect(page.reload).toHaveBeenCalledOnce();
  });

  it("does not add a fallback reload once control changed", async () => {
    vi.useFakeTimers();
    const page = await controlledPage();
    page.serviceWorker.registration.waiting = new FakeServiceWorker();

    page.preloadError();
    await vi.advanceTimersByTimeAsync(0);
    page.takeControl();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(page.reload).toHaveBeenCalledOnce();
  });

  it("ignores failed chunk loads while PWA behavior is disabled", async () => {
    const test = runtime();
    test.serviceWorker.controller = new FakeServiceWorker();
    test.serviceWorker.registration.waiting = new FakeServiceWorker();
    const lifecycle = createHostedPwaLifecycle(test.runtime);
    await lifecycle.start({ enabled: false });

    test.windowTarget.dispatchEvent(new Event("vite:preloadError"));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(test.serviceWorker.getRegistration).not.toHaveBeenCalled();
    lifecycle.reloadApp();
    expect(test.reload).toHaveBeenCalledOnce();
  });

  it("stops listening for failed chunk loads once stopped", async () => {
    const page = await controlledPage();
    page.lifecycle.stop();

    page.preloadError();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(page.serviceWorker.getRegistration).not.toHaveBeenCalled();
  });
});

describe("hosted PWA reload action", () => {
  it("reloads when no update is waiting", async () => {
    const test = runtime();
    const lifecycle = createHostedPwaLifecycle(test.runtime);
    await lifecycle.start({ enabled: true });

    lifecycle.reloadApp();
    expect(test.reload).toHaveBeenCalledOnce();
  });

  it("activates a waiting update instead of reloading into the cached build", async () => {
    const test = runtime();
    const waiting = new FakeServiceWorker();
    test.serviceWorker.registration.waiting = waiting;
    test.serviceWorker.controller = new FakeServiceWorker();
    const lifecycle = createHostedPwaLifecycle(test.runtime);
    await lifecycle.start({ enabled: true });

    lifecycle.reloadApp();
    lifecycle.reloadApp();
    expect(waiting.postMessage).toHaveBeenCalledOnce();
    expect(lifecycle.getSnapshot().updateState).toBe("activating");
    expect(test.reload).not.toHaveBeenCalled();
  });
});
