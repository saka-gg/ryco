import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { isNavigationPress as readRowPress, noteThreadPressIntent } from "./threadNavigationIntent";
import {
  createNodePreconnect,
  createThreadNavigationIntents,
  isNavigationPress,
  mayPrefetchThreadWindow,
  NODE_PRECONNECT_COOLDOWN_MS,
  NODE_PRECONNECT_INTERVAL_MS,
  type NavigationPressEvent,
  THREAD_NAVIGATION_HOVER_DELAY_MS,
  THREAD_NAVIGATION_INTENT_RETAIN_MS,
} from "./threadNavigationIntent.logic";

// The app wiring of the row intents. The logic module imports none of these.
const wiring = vi.hoisted(() => ({
  tier: "phone" as "phone" | "desktop",
  retainHostedIntentScope: vi.fn((_environmentId: string) => () => undefined),
  markNodeSwitchIntent: vi.fn(),
  retainThreadDetailSubscription: vi.fn(
    (_environmentId: string, _threadId: string, _options?: unknown) => () => undefined,
  ),
  sessions: new Map<string, unknown>(),
}));
vi.mock("../../env", () => ({ isHostedHubMode: () => true }));
vi.mock("../../lib/presentationTier", () => ({ getPresentationTier: () => wiring.tier }));
vi.mock("../../hostedHub/hostedConnectionScopes", () => ({
  retainHostedIntentScope: wiring.retainHostedIntentScope,
}));
vi.mock("../../perf/nodeSwitchInstrumentation", () => ({
  markNodeSwitchIntent: wiring.markNodeSwitchIntent,
}));
vi.mock("../../hostedHub/hostedConnectionCoordinator", () => ({
  canPreconnectHostedEnvironment: () => true,
}));
// The hosted state seam answers readiness with the real adoption rule over
// this test's session records.
vi.mock("../../hostedHub/state", async () => {
  const { canAdoptHostedEnvironmentSession } =
    await import("@ryco/client-runtime/authorization/hostedEnvironmentSessions");
  return {
    isHostedEnvironmentSessionAdoptable: (environmentId: string) => {
      const record = wiring.sessions.get(environmentId);
      return (
        record !== undefined &&
        canAdoptHostedEnvironmentSession(
          record as Parameters<typeof canAdoptHostedEnvironmentSession>[0],
        )
      );
    },
  };
});
vi.mock("../../environments/runtime/service", () => ({
  retainThreadDetailSubscription: wiring.retainThreadDetailSubscription,
}));
vi.mock("../../lib/routeChunkPreload", () => ({ preloadRouteChunk: async () => undefined }));
vi.mock("../../store", () => ({
  useStore: { getState: () => ({ environmentStateById: {} }) },
}));

const environmentId = EnvironmentId.make("environment");
const ref = (threadId: string): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});

function setup(
  options: {
    readonly maxRetains?: number;
    readonly loaded?: ReadonlySet<string>;
    readonly canRetain?: (threadRef: ScopedThreadRef) => boolean;
  } = {},
) {
  const releases = new Map<string, ReturnType<typeof vi.fn>>();
  const retain = vi.fn((threadRef: ScopedThreadRef) => {
    const release = vi.fn();
    releases.set(threadRef.threadId, release);
    return release;
  });
  const preloadThreadRoute = vi.fn();
  const intents = createThreadNavigationIntents({
    retain,
    isDetailLoaded: (threadRef) => options.loaded?.has(threadRef.threadId) ?? false,
    preloadThreadRoute,
    keyOf: (threadRef) => `${threadRef.environmentId}:${threadRef.threadId}`,
    ...(options.maxRetains === undefined ? {} : { maxRetains: options.maxRetains }),
    ...(options.canRetain ? { canRetain: options.canRetain } : {}),
  });
  return { intents, retain, releases, preloadThreadRoute };
}

describe("thread navigation intents", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("warms the route on hover but retains only after the dwell", () => {
    const { intents, retain, preloadThreadRoute } = setup();
    intents.hover(ref("a"));
    expect(preloadThreadRoute).toHaveBeenCalledOnce();
    expect(retain).not.toHaveBeenCalled();
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS);
    expect(retain).toHaveBeenCalledExactlyOnceWith(ref("a"));
  });

  it("does not subscribe to rows a sweeping pointer only crosses", () => {
    const { intents, retain } = setup();
    for (const id of ["a", "b", "c", "d"]) {
      intents.hover(ref(id));
      vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS / 4);
      intents.leave(ref(id));
    }
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS * 4);
    expect(retain).not.toHaveBeenCalled();
  });

  it("retains at once on press and releases immediately after the window", () => {
    const { intents, retain, releases } = setup();
    intents.press(ref("a"));
    expect(retain).toHaveBeenCalledExactlyOnceWith(ref("a"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_INTENT_RETAIN_MS - 1);
    expect(releases.get("a")).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    // A press that navigated is held by the route's own retains by now; one
    // that only started a scroll or drag must not idle as a live stream.
    expect(releases.get("a")).toHaveBeenCalledExactlyOnceWith({ immediately: true });
  });

  it("disposes a hovered-only thread immediately when its window ends", () => {
    const { intents, releases } = setup();
    intents.hover(ref("a"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS + THREAD_NAVIGATION_INTENT_RETAIN_MS);
    expect(releases.get("a")).toHaveBeenCalledExactlyOnceWith({ immediately: true });
  });

  it("never retains a thread whose detail is already loaded", () => {
    // Its subscription may sit in the idle cache; an immediate release would drop it.
    const { intents, retain, preloadThreadRoute } = setup({ loaded: new Set(["a"]) });
    intents.hover(ref("a"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS);
    intents.press(ref("a"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_INTENT_RETAIN_MS);
    expect(retain).not.toHaveBeenCalled();
    // The route chunk is still warmed.
    expect(preloadThreadRoute).toHaveBeenCalledTimes(2);
  });

  it("renews one retain per thread instead of stacking retains", () => {
    const loaded = new Set<string>();
    const { intents, retain, releases } = setup({ loaded });
    intents.hover(ref("a"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS);
    // The intent's own retain loads the detail meanwhile: it is renewed, not dropped.
    loaded.add("a");
    vi.advanceTimersByTime(THREAD_NAVIGATION_INTENT_RETAIN_MS / 2);
    intents.press(ref("a"));
    intents.press(ref("a"));
    expect(retain).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(THREAD_NAVIGATION_INTENT_RETAIN_MS - 1);
    expect(releases.get("a")).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(releases.get("a")).toHaveBeenCalledExactlyOnceWith({ immediately: true });
  });

  it("bounds concurrent intent retains, releasing the oldest first", () => {
    const { intents, releases } = setup({ maxRetains: 2 });
    intents.press(ref("a"));
    intents.press(ref("b"));
    intents.press(ref("c"));
    expect(releases.get("a")).toHaveBeenCalledOnce();
    expect(releases.get("b")).not.toHaveBeenCalled();
    expect(releases.get("c")).not.toHaveBeenCalled();
    vi.advanceTimersByTime(THREAD_NAVIGATION_INTENT_RETAIN_MS);
    // The evicted retain's timer is gone: it is not released twice.
    expect(releases.get("a")).toHaveBeenCalledOnce();
    expect(releases.get("b")).toHaveBeenCalledOnce();
    expect(releases.get("c")).toHaveBeenCalledOnce();
  });

  it("a press cancels a pending hover on another row", () => {
    const { intents, retain } = setup();
    intents.hover(ref("a"));
    intents.press(ref("b"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS * 2);
    expect(retain.mock.calls.map(([threadRef]) => threadRef.threadId)).toEqual(["b"]);
  });

  it("retains on hover and on press only where the intent may", () => {
    const { intents, retain, preloadThreadRoute } = setup({ canRetain: () => false });
    intents.hover(ref("a"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS * 2);
    expect(preloadThreadRoute).toHaveBeenCalledOnce();
    expect(retain).not.toHaveBeenCalled();
    intents.press(ref("a"));
    expect(retain).not.toHaveBeenCalled();
    // The route chunk is still warmed, and a pending hover on another row is
    // still cancelled.
    expect(preloadThreadRoute).toHaveBeenCalledTimes(2);
    const canRetain = vi.fn((_threadRef: ScopedThreadRef) => false);
    const other = setup({ canRetain });
    other.intents.hover(ref("b"));
    other.intents.press(ref("c"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS * 2);
    expect(canRetain.mock.calls.map(([threadRef]) => threadRef.threadId)).toEqual(["c"]);
    expect(other.retain).not.toHaveBeenCalled();
  });

  it("asks at press time", () => {
    let ready = false;
    const { intents, retain } = setup({ canRetain: () => ready });
    intents.hover(ref("a"));
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS);
    expect(retain).not.toHaveBeenCalled();
    ready = true;
    intents.press(ref("a"));
    intents.press(ref("a"));
    expect(retain).toHaveBeenCalledExactlyOnceWith(ref("a"));
  });

  it("reset releases everything and drops a pending hover", () => {
    const { intents, retain, releases } = setup();
    intents.press(ref("a"));
    intents.hover(ref("b"));
    intents.reset();
    vi.advanceTimersByTime(THREAD_NAVIGATION_HOVER_DELAY_MS + THREAD_NAVIGATION_INTENT_RETAIN_MS);
    expect(retain).toHaveBeenCalledOnce();
    expect(releases.get("a")).toHaveBeenCalledOnce();
  });
});

describe("mayPrefetchThreadWindow", () => {
  it("always may outside hosted Web, and on hosted Web only from a ready session off the phone tier", () => {
    for (const phoneTier of [false, true]) {
      for (const sessionReady of [false, true]) {
        expect(mayPrefetchThreadWindow({ hosted: false, phoneTier, sessionReady })).toBe(true);
      }
    }
    expect(mayPrefetchThreadWindow({ hosted: true, phoneTier: true, sessionReady: true })).toBe(
      false,
    );
    expect(mayPrefetchThreadWindow({ hosted: true, phoneTier: false, sessionReady: false })).toBe(
      false,
    );
    expect(mayPrefetchThreadWindow({ hosted: true, phoneTier: false, sessionReady: true })).toBe(
      true,
    );
  });
});

describe("isNavigationPress", () => {
  const row = { closest: () => row };
  const press = (overrides: Partial<NavigationPressEvent> = {}): NavigationPressEvent => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    target: row,
    currentTarget: row,
    ...overrides,
  });

  it("accepts a plain primary press on the row", () => {
    expect(isNavigationPress(press())).toBe(true);
    // Text inside the row resolves to the row itself.
    expect(isNavigationPress(press({ target: { closest: () => row } }))).toBe(true);
    // A target outside the DOM (no `closest`) counts as the row.
    expect(isNavigationPress(press({ target: null }))).toBe(true);
  });

  it("rejects selection modifiers and other buttons", () => {
    for (const modifier of ["metaKey", "ctrlKey", "shiftKey", "altKey"] as const) {
      expect(isNavigationPress(press({ [modifier]: true }))).toBe(false);
    }
    expect(isNavigationPress(press({ button: 1 }))).toBe(false);
    expect(isNavigationPress(press({ button: 2 }))).toBe(false);
  });

  it("rejects a press on a control nested in the row", () => {
    const badge = { closest: () => badge };
    expect(isNavigationPress(press({ target: badge }))).toBe(false);
  });
});

describe("node pre-connect on a navigation press", () => {
  const row = { closest: () => row };
  const press = (overrides: Partial<NavigationPressEvent> = {}): NavigationPressEvent => ({
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    pointerType: "mouse",
    target: row,
    currentTarget: row,
    ...overrides,
  });
  const onNode = (environment: string): ScopedThreadRef => ({
    environmentId: EnvironmentId.make(environment),
    threadId: ThreadId.make(`thread-${environment}`),
  });

  function preconnectSetup(
    options: { readonly enabled?: boolean; readonly connected?: ReadonlySet<string> } = {},
  ) {
    let now = 1_000_000;
    const preconnect = vi.fn();
    const nodePreconnect = createNodePreconnect({
      enabled: () => options.enabled ?? true,
      needsConnection: (environment) => !(options.connected?.has(environment) ?? false),
      preconnect,
      now: () => now,
    });
    /** A row press as rows report it: read the pointer press, then the row's thread. */
    const pressRow = (threadRef: ScopedThreadRef, event = press()) => {
      if (nodePreconnect.notePress(event)) nodePreconnect.press(threadRef);
    };
    return {
      nodePreconnect,
      preconnect,
      pressRow,
      advance: (ms: number) => {
        now += ms;
      },
    };
  }

  it("pre-connects the pressed row's node and reads the press like isNavigationPress", () => {
    const test = preconnectSetup();
    expect(test.nodePreconnect.notePress(press())).toBe(true);
    test.nodePreconnect.press(onNode("env-a"));
    expect(test.preconnect).toHaveBeenCalledExactlyOnceWith("env-a");
    expect(test.nodePreconnect.notePress(press({ ctrlKey: true }))).toBe(false);
    expect(test.nodePreconnect.notePress(press({ button: 2 }))).toBe(false);
  });

  it("only follows navigation presses, never a touch that may be a scroll", () => {
    const test = preconnectSetup();
    // A press without a navigation press read before it.
    test.nodePreconnect.press(onNode("env-a"));
    // A modified press: the row does not report it as a navigation.
    test.nodePreconnect.notePress(press({ metaKey: true }));
    test.nodePreconnect.press(onNode("env-a"));
    // A touch press navigates, but connects nothing ahead of it.
    expect(test.nodePreconnect.notePress(press({ pointerType: "touch" }))).toBe(true);
    test.nodePreconnect.press(onNode("env-a"));
    expect(test.preconnect).not.toHaveBeenCalled();

    test.pressRow(onNode("env-a"), press({ pointerType: "pen" }));
    expect(test.preconnect).toHaveBeenCalledExactlyOnceWith("env-a");
  });

  it("connects at most one node per interval and each node once per cooldown", () => {
    const test = preconnectSetup();
    test.pressRow(onNode("env-a"));
    test.advance(NODE_PRECONNECT_INTERVAL_MS - 1);
    test.pressRow(onNode("env-b"));
    expect(test.preconnect.mock.calls).toEqual([["env-a"]]);

    test.advance(1);
    test.pressRow(onNode("env-b"));
    expect(test.preconnect.mock.calls).toEqual([["env-a"], ["env-b"]]);

    // Node A again: past the interval, but inside its own cooldown.
    test.advance(NODE_PRECONNECT_INTERVAL_MS);
    test.pressRow(onNode("env-a"));
    expect(test.preconnect).toHaveBeenCalledTimes(2);

    test.advance(NODE_PRECONNECT_COOLDOWN_MS);
    test.pressRow(onNode("env-a"));
    expect(test.preconnect.mock.calls.at(-1)).toEqual(["env-a"]);
  });

  it("leaves a node with a live session to the navigation, without spending the interval", () => {
    const test = preconnectSetup({ connected: new Set(["env-a"]) });
    test.pressRow(onNode("env-a"));
    test.pressRow(onNode("env-b"));
    expect(test.preconnect.mock.calls).toEqual([["env-b"]]);
  });

  it("does nothing where pre-connect is off, as on the phone tier", () => {
    const test = preconnectSetup({ enabled: false });
    test.pressRow(onNode("env-a"));
    expect(test.preconnect).not.toHaveBeenCalled();
  });

  it("forgets the pending press once it is used", () => {
    const test = preconnectSetup();
    test.pressRow(onNode("env-a"));
    test.advance(NODE_PRECONNECT_COOLDOWN_MS);
    // The row press above was consumed; this press was never read.
    test.nodePreconnect.press(onNode("env-b"));
    expect(test.preconnect).toHaveBeenCalledOnce();
  });

  it("never lets a press read in an earlier task arm a later one", async () => {
    const test = preconnectSetup();
    expect(test.nodePreconnect.notePress(press())).toBe(true);
    await Promise.resolve();
    test.nodePreconnect.press(onNode("env-a"));
    expect(test.preconnect).not.toHaveBeenCalled();
  });
});

describe("row press intents on hosted Web", () => {
  const row = { closest: () => row };
  const navigationPress: NavigationPressEvent = {
    button: 0,
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    pointerType: "mouse",
    target: row,
    currentTarget: row,
  };
  const threadRef: ScopedThreadRef = {
    environmentId: EnvironmentId.make("environment-wired"),
    threadId: ThreadId.make("thread-wired"),
  };

  it("connects no node ahead of a navigation press on the phone tier", () => {
    wiring.tier = "phone";
    expect(readRowPress(navigationPress)).toBe(true);
    noteThreadPressIntent(threadRef);
    expect(wiring.retainHostedIntentScope).not.toHaveBeenCalled();
    expect(wiring.markNodeSwitchIntent).not.toHaveBeenCalled();

    // The same press elsewhere connects ahead: only the tier held it back,
    // and the phone press spent none of the pre-connect bounds.
    wiring.tier = "desktop";
    expect(readRowPress(navigationPress)).toBe(true);
    noteThreadPressIntent(threadRef);
    expect(wiring.retainHostedIntentScope).toHaveBeenCalledExactlyOnceWith(threadRef.environmentId);
    expect(wiring.markNodeSwitchIntent).toHaveBeenCalledExactlyOnceWith(
      threadRef.environmentId,
      "press",
    );
  });

  it("reads a pressed thread's window only from a ready session, off the phone tier", () => {
    const onNode = (environment: string): ScopedThreadRef => ({
      environmentId: EnvironmentId.make(environment),
      threadId: ThreadId.make(`thread-${environment}`),
    });
    const readySession = {
      transportStatus: "online",
      sessionEstablished: true,
      suspended: false,
      relayGap: false,
      snapshotAcceptedAt: 1,
      sessionStatus: "ready",
      sessionRecoveredAfterUnknown: false,
    };
    wiring.sessions.set("environment-ready", readySession);
    // Online, but its shell snapshot is not accepted yet.
    wiring.sessions.set("environment-online", { ...readySession, snapshotAcceptedAt: null });
    wiring.retainThreadDetailSubscription.mockClear();

    wiring.tier = "phone";
    noteThreadPressIntent(onNode("environment-ready"));
    wiring.tier = "desktop";
    noteThreadPressIntent(onNode("environment-online"));
    noteThreadPressIntent(onNode("environment-unknown"));
    expect(wiring.retainThreadDetailSubscription).not.toHaveBeenCalled();

    noteThreadPressIntent(onNode("environment-ready"));
    expect(wiring.retainThreadDetailSubscription).toHaveBeenCalledExactlyOnceWith(
      "environment-ready",
      "thread-environment-ready",
      { speculative: true },
    );
  });
});
