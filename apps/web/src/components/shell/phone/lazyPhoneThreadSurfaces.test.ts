import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  tier: "desktop" as "phone" | "desktop",
  surfaceLoads: 0,
  // Resolves (or rejects) the phone surfaces chunk; replaced per test.
  gate: Promise.resolve() as Promise<void>,
  openGate: () => {},
  failGate: (_error: unknown) => {},
}));

vi.mock("../../../lib/presentationTier", () => ({
  getPresentationTier: () => state.tier,
}));

// Registered per test (after `vi.resetModules`), so every test loads the chunk afresh.
function mockPhoneThreadSurfacesChunk(): void {
  vi.doMock("./phoneThreadSurfaces", async () => {
    state.surfaceLoads += 1;
    await state.gate;
    const surface = () => null;
    return {
      MessageActionsSheet: surface,
      PhoneModelSheet: surface,
      PhoneSessionPolicyControl: surface,
      PhoneThreadAppBar: surface,
      PhoneThreadDock: surface,
      PhoneOverviewSheet: surface,
      PhoneWorkSurfaceSheet: surface,
    };
  });
}

const notifyChatSurfaceLoadFailure = vi.hoisted(() => vi.fn());
vi.mock("../../chat/chatViewLazySurfaces", () => ({ notifyChatSurfaceLoadFailure }));

const VIEW = { ChatThreadRoute: () => null };

async function loadModule() {
  return import("./lazyPhoneThreadSurfaces");
}

/** Whether `promise` has settled once pending microtasks drain. */
async function hasSettled(promise: Promise<unknown>): Promise<boolean> {
  let settled = false;
  void promise.then(
    () => {
      settled = true;
    },
    () => {
      settled = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  return settled;
}

describe("loadChatRouteView", () => {
  beforeEach(() => {
    vi.resetModules();
    state.surfaceLoads = 0;
    state.gate = new Promise<void>((resolve, reject) => {
      state.openGate = resolve;
      state.failGate = reject;
    });
    // A test that never loads the chunk leaves its gate unobserved.
    state.gate.catch(() => undefined);
    mockPhoneThreadSurfacesChunk();
  });

  it("loads only the route view on the desktop tier", async () => {
    state.tier = "desktop";
    const { LazyPhoneThreadAppBar, loadChatRouteView } = await loadModule();

    await expect(loadChatRouteView(async () => VIEW)).resolves.toBe(VIEW);

    expect(state.surfaceLoads).toBe(0);
    expect(LazyPhoneThreadAppBar.isLoaded()).toBe(false);
  });

  it("holds the phone-tier route until every phone thread surface renders synchronously", async () => {
    state.tier = "phone";
    const surfaces = await loadModule();
    const loadView = vi.fn(async () => VIEW);

    const route = surfaces.loadChatRouteView(loadView);
    // Both loads start together, not one after the other.
    expect(loadView).toHaveBeenCalledOnce();
    expect(await hasSettled(route)).toBe(false);
    expect(state.surfaceLoads).toBe(1);

    state.openGate();
    await expect(route).resolves.toBe(VIEW);
    for (const surface of [
      surfaces.LazyPhoneThreadAppBar,
      surfaces.LazyPhoneThreadDock,
      surfaces.LazyPhoneSessionPolicyControl,
      surfaces.LazyPhoneModelSheet,
      surfaces.LazyMessageActionsSheet,
      surfaces.LazyPhoneWorkSurfaceSheet,
      surfaces.LazyPhoneOverviewSheet,
    ]) {
      expect(surface.isLoaded()).toBe(true);
    }
    // One shared chunk for every surface.
    expect(state.surfaceLoads).toBe(1);
  });

  it("still commits the phone-tier route when the surfaces fail to load", async () => {
    state.tier = "phone";
    const { LazyPhoneThreadAppBar, loadChatRouteView } = await loadModule();

    const route = loadChatRouteView(async () => VIEW);
    state.failGate(new Error("chunk failed"));

    await expect(route).resolves.toBe(VIEW);
    // The mounting surface retries and reports the failure.
    expect(LazyPhoneThreadAppBar.isLoaded()).toBe(false);
    expect(LazyPhoneThreadAppBar.loadFailure()).not.toBeNull();
  });
});

describe("reportPhoneThreadSurfaceLoadFailure", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    notifyChatSurfaceLoadFailure.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows one toast per failed load whose Retry retries every surface, then forgets it", async () => {
    const { reportPhoneThreadSurfaceLoadFailure } = await import("./usePhoneThreadSurfaceReady");
    const error = new Error("chunk failed");
    const retryAppBar = vi.fn();
    const retryDock = vi.fn();

    reportPhoneThreadSurfaceLoadFailure(error, retryAppBar);
    reportPhoneThreadSurfaceLoadFailure(error, retryDock);
    expect(notifyChatSurfaceLoadFailure).toHaveBeenCalledOnce();

    const [, , retry] = notifyChatSurfaceLoadFailure.mock.calls[0]!;
    (retry as () => void)();
    expect(retryAppBar).toHaveBeenCalledOnce();
    expect(retryDock).toHaveBeenCalledOnce();

    // A dismissed toast leaves nothing behind: a later report is a new failure.
    vi.runAllTimers();
    reportPhoneThreadSurfaceLoadFailure(error, vi.fn());
    expect(notifyChatSurfaceLoadFailure).toHaveBeenCalledTimes(2);
  });
});
