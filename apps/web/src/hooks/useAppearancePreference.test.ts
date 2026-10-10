import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it } from "vite-plus/test";

import { PREFERS_REDUCED_MOTION_QUERY } from "../lib/perf/motion";
import {
  APPEARANCE_PREFERENCES_CHANGE_EVENT,
  APPEARANCE_PREFERENCES_STORAGE_KEY,
  resetAppearancePreference,
  setAppearancePreference,
} from "../themes/appearancePreferences";
import {
  subscribeToReducedMotionEffective,
  useReducedMotionEffective,
} from "./useAppearancePreference";

class FakeMediaQueryList extends EventTarget {
  matches = false;
}

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

const GLOBAL_KEYS = ["window", "localStorage"] as const;

let reducedMotionQuery: FakeMediaQueryList;
let fakeWindow: EventTarget;
let originalDescriptors: Map<string, PropertyDescriptor | undefined>;

function storageEvent(key: string): Event {
  return Object.assign(new Event("storage"), { key });
}

function ReducedMotionProbe() {
  return createElement("span", null, String(useReducedMotionEffective()));
}

beforeEach(() => {
  originalDescriptors = new Map(
    GLOBAL_KEYS.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
  );
  reducedMotionQuery = new FakeMediaQueryList();
  // Every query other than reduced motion (e.g. the phone tier) never matches.
  fakeWindow = Object.assign(new EventTarget(), {
    matchMedia: (query: string) =>
      query === PREFERS_REDUCED_MOTION_QUERY ? reducedMotionQuery : new FakeMediaQueryList(),
  });
  Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  for (const [key, descriptor] of originalDescriptors) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
});

describe("useReducedMotionEffective", () => {
  it("reads the in-app Motion preference and the OS query", () => {
    expect(renderToString(createElement(ReducedMotionProbe))).toBe("<span>false</span>");

    setAppearancePreference("motion", "reduce");
    expect(renderToString(createElement(ReducedMotionProbe))).toBe("<span>true</span>");

    resetAppearancePreference("motion");
    reducedMotionQuery.matches = true;
    expect(renderToString(createElement(ReducedMotionProbe))).toBe("<span>true</span>");
  });
});

describe("subscribeToReducedMotionEffective", () => {
  it("notifies on an in-app preference change, a cross-tab write, and an OS query change", () => {
    let notifications = 0;
    const unsubscribe = subscribeToReducedMotionEffective(() => {
      notifications += 1;
    });

    fakeWindow.dispatchEvent(new Event(APPEARANCE_PREFERENCES_CHANGE_EVENT));
    expect(notifications).toBe(1);

    fakeWindow.dispatchEvent(storageEvent("unrelated-key"));
    expect(notifications).toBe(1);
    fakeWindow.dispatchEvent(storageEvent(APPEARANCE_PREFERENCES_STORAGE_KEY));
    expect(notifications).toBe(2);

    reducedMotionQuery.dispatchEvent(new Event("change"));
    expect(notifications).toBe(3);

    unsubscribe();
    fakeWindow.dispatchEvent(new Event(APPEARANCE_PREFERENCES_CHANGE_EVENT));
    fakeWindow.dispatchEvent(storageEvent(APPEARANCE_PREFERENCES_STORAGE_KEY));
    reducedMotionQuery.dispatchEvent(new Event("change"));
    expect(notifications).toBe(3);
  });

  it("still follows the preference where the media query API is missing", () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: new EventTarget(),
    });
    let notifications = 0;
    const unsubscribe = subscribeToReducedMotionEffective(() => {
      notifications += 1;
    });
    window.dispatchEvent(new Event(APPEARANCE_PREFERENCES_CHANGE_EVENT));
    expect(notifications).toBe(1);
    unsubscribe();
  });
});
