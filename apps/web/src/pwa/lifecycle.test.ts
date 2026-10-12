import { describe, expect, it, vi } from "vite-plus/test";

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
}

class FakeServiceWorkerContainer extends EventTarget {
  controller: HostedPwaServiceWorker | null = null;
  readonly registration = new FakeRegistration();
  register = vi.fn(async () => this.registration);
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
  };
  return { displayMode, reload, runtime: value, serviceWorker, windowTarget };
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
