import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

// Push presence sends one message to every registered machine for each change
// of "the app is in front" (`createBackgroundAlerts` `onAppState`). These
// count those changes for the previous test (raw `AppState === "active"`) and
// the app-wide one (`isAppInFront`), over the states iOS reports.

const native = vi.hoisted(() => ({
  appState: "active",
  appListeners: new Set<(state: string) => void>(),
}));

vi.mock("react-native", () => ({
  AppState: {
    get currentState() {
      return native.appState;
    },
    addEventListener: (_event: string, listener: (state: string) => void) => {
      native.appListeners.add(listener);
      return { remove: () => native.appListeners.delete(listener) };
    },
  },
}));
vi.mock("expo-network", () => ({
  NetworkStateType: { NONE: "NONE", UNKNOWN: "UNKNOWN" },
  getNetworkStateAsync: async () => ({ isConnected: true }),
  addNetworkStateListener: () => ({ remove: () => undefined }),
}));

const MACHINES = 3;
/** Three Notification Center pulls: `inactive` and back each time. */
const NOTIFICATION_CENTER_PULLS = [
  "inactive",
  "active",
  "inactive",
  "active",
  "inactive",
  "active",
];
/** A two-second trip to another app: through `inactive` to `background` and back. */
const APP_SWITCH = ["inactive", "background", "inactive", "active"];

function appState(state: string) {
  native.appState = state;
  for (const listener of [...native.appListeners]) listener(state);
}

/** The presence messages one sequence sends, with each test. */
async function presenceMessages(states: ReadonlyArray<string>) {
  const { isAppInFront, subscribeAppInFront } = await import("./appInFront");
  let raw = native.appState === "active";
  let rawChanges = 0;
  const rawListener = (state: string) => {
    const active = state === "active";
    if (active === raw) return;
    raw = active;
    rawChanges += 1;
  };
  native.appListeners.add(rawListener);

  let inFront = isAppInFront();
  let lifecycleChanges = 0;
  const unsubscribe = subscribeAppInFront((next) => {
    if (next === inFront) return;
    inFront = next;
    lifecycleChanges += 1;
  });
  for (const state of states) appState(state);
  unsubscribe();
  native.appListeners.delete(rawListener);
  return { before: rawChanges * MACHINES, after: lifecycleChanges * MACHINES, inFront };
}

beforeEach(() => {
  vi.resetModules();
  native.appState = "active";
  native.appListeners.clear();
});

describe("isAppInFront", () => {
  it("sends no presence for Notification Center pulls", async () => {
    expect(await presenceMessages(NOTIFICATION_CENTER_PULLS)).toEqual({
      before: 18,
      after: 0,
      inFront: true,
    });
  });

  it("still reports a real trip to the background, once each way", async () => {
    expect(await presenceMessages(APP_SWITCH)).toEqual({ before: 6, after: 6, inFront: true });
  });

  it("is false only in the background", async () => {
    const { isAppInFront } = await import("./appInFront");
    for (const [state, expected] of [
      ["active", true],
      ["inactive", true],
      ["background", false],
    ] as const) {
      native.appState = state;
      expect(isAppInFront()).toBe(expected);
    }
  });
});
