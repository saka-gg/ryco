import { EnvironmentId, type ScopedThreadRef, ThreadId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadNavigationIntents,
  isNavigationPress,
  type NavigationPressEvent,
  THREAD_NAVIGATION_HOVER_DELAY_MS,
  THREAD_NAVIGATION_INTENT_RETAIN_MS,
} from "./threadNavigationIntent.logic";

const environmentId = EnvironmentId.make("environment");
const ref = (threadId: string): ScopedThreadRef => ({
  environmentId,
  threadId: ThreadId.make(threadId),
});

function setup(
  options: { readonly maxRetains?: number; readonly loaded?: ReadonlySet<string> } = {},
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
