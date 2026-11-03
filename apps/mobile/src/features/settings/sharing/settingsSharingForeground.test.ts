import { describe, expect, it } from "vite-plus/test";

import {
  runSettingsSharingInForeground,
  type SettingsSharingAppState,
} from "./settingsSharingForeground";

function appState(foreground: boolean) {
  const listeners = new Set<(foreground: boolean) => void>();
  let current = foreground;
  const state: SettingsSharingAppState = {
    isForeground: () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    state,
    set: (next: boolean) => {
      current = next;
      for (const listener of listeners) listener(next);
    },
    listenerCount: () => listeners.size,
  };
}

function counter() {
  const calls = { starts: 0, stops: 0 };
  const start = () => {
    calls.starts += 1;
    return () => {
      calls.stops += 1;
    };
  };
  return { calls, start, running: () => calls.starts - calls.stops };
}

describe("shared settings on the phone", () => {
  it("run in the foreground and stop in the background, never twice at once", () => {
    const app = appState(true);
    const runtime = counter();
    const end = runSettingsSharingInForeground(app.state, runtime.start);
    expect(runtime.running()).toBe(1);
    app.set(true);
    expect(runtime.calls.starts).toBe(1);
    app.set(false);
    expect(runtime.running()).toBe(0);
    app.set(false);
    expect(runtime.calls.stops).toBe(1);
    app.set(true);
    expect(runtime.running()).toBe(1);
    end();
    expect(runtime.running()).toBe(0);
    expect(app.listenerCount()).toBe(0);
  });

  it("wait for the foreground when they mount in the background", () => {
    const app = appState(false);
    const runtime = counter();
    const end = runSettingsSharingInForeground(app.state, runtime.start);
    expect(runtime.calls.starts).toBe(0);
    app.set(true);
    expect(runtime.running()).toBe(1);
    end();
    expect(runtime.running()).toBe(0);
  });
});
