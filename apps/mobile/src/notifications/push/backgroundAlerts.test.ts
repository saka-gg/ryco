import { HostedHubApiError } from "@ryco/client-runtime/authorization";
import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import { EnvironmentId } from "@ryco/contracts";
import { PushRpcError, type PushDeviceStatus } from "@ryco/contracts/push";
import type { NativePushCapability } from "@ryco/contracts/push-hub";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  createBackgroundAlerts,
  type BackgroundAlertsAccount,
  type BackgroundAlertsConnection,
} from "./backgroundAlerts";
import { HUB_PUSH_CAPABILITY_RECHECK_MS, PUSH_PRESENCE_REFRESH_MS } from "./backgroundAlertsModel";
import type { PushKey } from "./pushKeyStore";

const ACCOUNT = "acct_aaaaaaaaaaaaaaaaaaaaaa";
const ENROLLMENT = `enr_${"e".repeat(22)}`;
const TOKEN = "ab".repeat(32);
const TOPIC = "dev.ryco.app.dev";
const KEY: PushKey = {
  publicKey: "yP7Kgb4ZbN8srer_E8SQPXYy3OSVWqaLbl2a3vVOJhY" as PushKey["publicKey"],
  keyId: "DEQhCHjLCTVmDnk--WkGOQ" as PushKey["keyId"],
  enrollmentId: null,
};
const CAPABILITY: NativePushCapability = {
  protocolVersion: 1,
  platforms: ["ios"],
  topics: [TOPIC],
};

const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function nodeStatus(overrides: Partial<PushDeviceStatus> = {}): PushDeviceStatus {
  return {
    eligible: true,
    registered: true,
    keyId: KEY.keyId,
    kinds: ["approval", "input", "plan-ready", "completed", "failed", "stopped"],
    hubDelivery: "available",
    ...overrides,
  };
}

function fakeConnection(id: string, options: { readonly viaHub?: boolean } = {}) {
  let ready: object | null = {};
  const listeners = new Set<() => void>();
  let answer: () => Promise<PushDeviceStatus> = async () => nodeStatus();
  const push = {
    registerDevice: vi.fn((_input: unknown) => answer()),
    unregisterDevice: vi.fn(async (_input: unknown) => ({ removed: true })),
    setPresence: vi.fn(async (_input: unknown) => ({})),
  };
  const view: BackgroundAlertsConnection = {
    environmentId: EnvironmentId.make(id),
    viaHub: options.viaHub ?? true,
    readReady: () => ready,
    subscribeReady: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    push: push as unknown as WsRpcClient["push"],
  };
  return {
    view,
    push,
    answer: (next: () => Promise<PushDeviceStatus>) => {
      answer = next;
    },
    reconnect: () => {
      ready = {};
      for (const listener of listeners) listener();
    },
  };
}

function harness(
  options: {
    readonly capability?: NativePushCapability | null;
    readonly enabled?: boolean;
    readonly permission?: boolean;
    readonly account?: BackgroundAlertsAccount;
    readonly storedKey?: PushKey | null;
  } = {},
) {
  let preferences = { enabled: options.enabled ?? true, sound: false };
  let account: BackgroundAlertsAccount = options.account ?? {
    status: "signed-in",
    accountId: ACCOUNT,
    enrollmentId: ENROLLMENT,
  };
  let active = true;
  let now = 1_800_000_000_000;
  let storedKey: PushKey | null = options.storedKey ?? null;
  const preferenceListeners = new Set<() => void>();
  const accountListeners = new Set<() => void>();
  const appListeners = new Set<() => void>();
  const connectionListeners = new Set<() => void>();
  let connections: ReadonlyArray<ReturnType<typeof fakeConnection>> = [];
  const intervals: Array<() => void> = [];

  const hub = {
    getNativePushCapability: vi.fn(async () =>
      options.capability === undefined ? CAPABILITY : options.capability,
    ),
    registerNativePush: vi.fn(async (_input: unknown) => undefined),
    unregisterNativePush: vi.fn(async () => undefined),
  };
  const pushKey = {
    available: true,
    ensureKey: vi.fn(async () => (storedKey ??= KEY)),
    readKey: vi.fn(async () => storedKey),
    setRegistration: vi.fn(async (input: { readonly enrollmentId: string }) => {
      if (storedKey !== null) storedKey = { ...storedKey, enrollmentId: input.enrollmentId };
    }),
    deleteKey: vi.fn(async () => {
      storedKey = null;
    }),
  };
  const notifications = {
    readPermission: vi.fn(async () => options.permission ?? true),
    readDeviceToken: vi.fn(async () => TOKEN),
  };

  const alerts = createBackgroundAlerts({
    support: "supported",
    build: { platform: "ios", topic: TOPIC, apnsEnvironment: "sandbox" },
    preferences: {
      read: () => preferences,
      subscribe: (listener) => {
        preferenceListeners.add(listener);
        return () => preferenceListeners.delete(listener);
      },
    },
    account: {
      read: () => account,
      subscribe: (listener) => {
        accountListeners.add(listener);
        return () => accountListeners.delete(listener);
      },
    },
    hub: () => hub,
    connections: {
      list: () => connections.map((connection) => connection.view),
      subscribe: (listener) => {
        connectionListeners.add(listener);
        return () => connectionListeners.delete(listener);
      },
    },
    pushKey,
    notifications,
    app: {
      isActive: () => active,
      subscribe: (listener) => {
        appListeners.add(listener);
        return () => appListeners.delete(listener);
      },
    },
    timers: {
      setInterval: (callback) => {
        intervals.push(callback);
        return intervals.length - 1;
      },
      clearInterval: (handle) => {
        intervals[handle as number] = () => undefined;
      },
    },
    now: () => now,
  });

  return {
    alerts,
    hub,
    pushKey,
    notifications,
    intervals,
    setConnections: (next: ReadonlyArray<ReturnType<typeof fakeConnection>>) => {
      connections = next;
      for (const listener of connectionListeners) listener();
    },
    setPreferences: (next: Partial<typeof preferences>) => {
      preferences = { ...preferences, ...next };
      for (const listener of preferenceListeners) listener();
    },
    setAccount: (next: BackgroundAlertsAccount) => {
      account = next;
      for (const listener of accountListeners) listener();
    },
    setActive: (next: boolean) => {
      active = next;
      for (const listener of appListeners) listener();
    },
    advance: (ms: number) => {
      now += ms;
    },
  };
}

const env = (id: string) => EnvironmentId.make(id);

describe("background alerts with a Hub that sends no push", () => {
  it("read the capability once and do nothing else: no prompt, no token, no key, no node", async () => {
    const test = harness({ capability: null });
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();

    // More triggers within the hour ask nothing new.
    node.reconnect();
    test.setActive(false);
    test.setActive(true);
    await settle();

    expect(test.hub.getNativePushCapability).toHaveBeenCalledTimes(1);
    expect(test.hub.registerNativePush).not.toHaveBeenCalled();
    expect(test.hub.unregisterNativePush).not.toHaveBeenCalled();
    expect(test.notifications.readPermission).not.toHaveBeenCalled();
    expect(test.notifications.readDeviceToken).not.toHaveBeenCalled();
    expect(test.pushKey.ensureKey).not.toHaveBeenCalled();
    expect(node.push.registerDevice).not.toHaveBeenCalled();
    expect(node.push.setPresence).not.toHaveBeenCalled();
    expect(test.alerts.getSnapshot().hub).toBe("hub-unsupported");
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);

    // An hour on, coming back asks the Hub again: it may have been upgraded.
    test.advance(HUB_PUSH_CAPABILITY_RECHECK_MS);
    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(test.hub.getNativePushCapability).toHaveBeenCalledTimes(2);
  });

  it("stay off for a build the Hub cannot send to", async () => {
    const test = harness({ capability: { ...CAPABILITY, topics: ["dev.ryco.app"] } });
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();

    expect(test.alerts.getSnapshot().hub).toBe("topic-unsupported");
    expect(test.hub.registerNativePush).not.toHaveBeenCalled();
    expect(node.push.registerDevice).not.toHaveBeenCalled();
  });
});

describe("background alerts that were never turned on", () => {
  it("make no Hub request and no node RPC; the settings row reads the capability alone", async () => {
    const test = harness({ enabled: false });
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();

    expect(test.hub.getNativePushCapability).not.toHaveBeenCalled();
    expect(test.hub.unregisterNativePush).not.toHaveBeenCalled();
    expect(node.push.registerDevice).not.toHaveBeenCalled();
    expect(node.push.unregisterDevice).not.toHaveBeenCalled();
    expect(test.notifications.readPermission).not.toHaveBeenCalled();

    await test.alerts.checkAvailability();
    expect(test.hub.getNativePushCapability).toHaveBeenCalledTimes(1);
    expect(test.alerts.getSnapshot().hub).toBe("available");
    expect(test.hub.registerNativePush).not.toHaveBeenCalled();
    expect(node.push.registerDevice).not.toHaveBeenCalled();
  });
});

describe("background alerts on a Hub that sends push", () => {
  it("register the token with the Hub and the key with every Hub channel, then tell it the app is in front", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    const direct = fakeConnection("env-direct", { viaHub: false });
    test.setConnections([node, direct]);
    test.alerts.start();
    await settle();

    expect(test.hub.registerNativePush).toHaveBeenCalledWith({
      platform: "ios",
      token: TOKEN,
      environment: "sandbox",
      topic: TOPIC,
    });
    expect(test.pushKey.setRegistration).toHaveBeenCalledWith({
      enrollmentId: ENROLLMENT,
      sound: false,
    });
    expect(node.push.registerDevice).toHaveBeenCalledWith({
      keyId: KEY.keyId,
      publicKey: KEY.publicKey,
      kinds: ["approval", "input", "plan-ready", "completed", "failed", "stopped"],
      sound: false,
    });
    expect(node.push.setPresence).toHaveBeenCalledWith({ state: "foreground" });
    expect(direct.push.registerDevice).not.toHaveBeenCalled();
    expect(test.alerts.getSnapshot()).toMatchObject({ hub: "registered", device: "ready" });
    expect(test.alerts.isConfirmed(env("env-a"), "approval")).toBe(true);
    expect(test.alerts.isConfirmed(env("env-direct"), "approval")).toBe(false);
  });

  it("register again on every connect, and only then", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(1);

    node.reconnect();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(2);
    expect(test.hub.registerNativePush).toHaveBeenCalledTimes(1);
  });

  it("are not confirmed until the node's Hub took a signal, nor for a kind a viewer never gets", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    node.answer(async () => nodeStatus({ hubDelivery: "unknown", kinds: ["completed"] }));
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);

    node.answer(async () => nodeStatus({ kinds: ["completed", "failed", "stopped"] }));
    node.reconnect();
    await settle();
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(true);
    expect(test.alerts.isConfirmed(env("env-a"), "approval")).toBe(false);
  });

  it("tell an older machine apart from a channel that cannot receive push", async () => {
    const test = harness();
    const older = fakeConnection("env-old");
    older.answer(async () => {
      throw new Error("Unknown request tag: push.registerDevice");
    });
    const local = fakeConnection("env-local");
    local.answer(async () => {
      throw new PushRpcError({
        message: "Push alerts need a device signed in to this node's Hub.",
      });
    });
    test.setConnections([older, local]);
    test.alerts.start();
    await settle();

    expect(test.alerts.getSnapshot().environments.get(env("env-old"))).toEqual({
      status: "update-needed",
    });
    expect(test.alerts.getSnapshot().environments.get(env("env-local"))).toEqual({
      status: "ineligible",
    });
    expect(test.alerts.isConfirmed(env("env-old"), "completed")).toBe(false);
  });

  it("keep the presence current while in front and say when the app leaves", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(node.push.setPresence).toHaveBeenCalledTimes(1);

    expect(test.intervals).toHaveLength(1);
    test.intervals[0]!();
    expect(node.push.setPresence).toHaveBeenLastCalledWith({ state: "foreground" });

    test.setActive(false);
    expect(node.push.setPresence).toHaveBeenLastCalledWith({ state: "background" });
    const sent = node.push.setPresence.mock.calls.length;
    test.intervals[0]!();
    expect(node.push.setPresence).toHaveBeenCalledTimes(sent);
    expect(PUSH_PRESENCE_REFRESH_MS).toBeLessThan(45_000);
  });

  it("wait for the device's enrollment and ask for nothing without permission", async () => {
    const waiting = harness({
      account: { status: "signed-in", accountId: ACCOUNT, enrollmentId: null },
    });
    const node = fakeConnection("env-a");
    waiting.setConnections([node]);
    waiting.alerts.start();
    await settle();
    expect(waiting.alerts.getSnapshot().hub).toBe("enrollment-pending");
    expect(waiting.hub.registerNativePush).not.toHaveBeenCalled();
    expect(node.push.registerDevice).not.toHaveBeenCalled();

    const denied = harness({ permission: false });
    denied.setConnections([node]);
    denied.alerts.start();
    await settle();
    expect(denied.alerts.getSnapshot().device).toBe("permission-denied");
    expect(denied.notifications.readDeviceToken).not.toHaveBeenCalled();
    expect(denied.hub.registerNativePush).not.toHaveBeenCalled();
  });

  it("retry a failed Hub registration on the next foreground, not on every connection event", async () => {
    const test = harness();
    test.hub.registerNativePush.mockRejectedValueOnce(new Error("offline"));
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(test.alerts.getSnapshot().hub).toBe("failed");

    node.reconnect();
    await settle();
    expect(test.hub.registerNativePush).toHaveBeenCalledTimes(1);
    expect(node.push.registerDevice).not.toHaveBeenCalled();

    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(test.hub.registerNativePush).toHaveBeenCalledTimes(2);
    expect(node.push.registerDevice).toHaveBeenCalledTimes(1);
  });

  it("report the Hub's refusals and register no node", async () => {
    const test = harness();
    test.hub.registerNativePush.mockRejectedValueOnce(
      new HostedHubApiError("conflict", 409, undefined, undefined, "push_enrollment_required"),
    );
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(test.alerts.getSnapshot().hub).toBe("enrollment-pending");
    expect(node.push.registerDevice).not.toHaveBeenCalled();

    // Coming back retries.
    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(test.alerts.getSnapshot().hub).toBe("registered");
    expect(node.push.registerDevice).toHaveBeenCalledTimes(1);
  });
});

describe("turning background alerts off", () => {
  it("removes the Hub registration, the live nodes' registrations and the key", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();

    test.setPreferences({ enabled: false });
    await settle();
    expect(test.hub.unregisterNativePush).toHaveBeenCalledTimes(1);
    expect(node.push.unregisterDevice).toHaveBeenCalledWith({ keyId: KEY.keyId });
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);
    expect(test.alerts.getSnapshot().environments.size).toBe(0);
  });

  it("cleans up a key an earlier run left, once", async () => {
    const test = harness({ enabled: false, storedKey: { ...KEY, enrollmentId: ENROLLMENT } });
    test.alerts.start();
    await settle();
    test.setActive(false);
    test.setActive(true);
    await settle();

    expect(test.hub.unregisterNativePush).toHaveBeenCalledTimes(1);
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);
    expect(test.pushKey.readKey).toHaveBeenCalledTimes(1);
  });

  it("counts a Hub without the route as nothing to remove", async () => {
    const test = harness({ enabled: false, storedKey: { ...KEY, enrollmentId: ENROLLMENT } });
    test.hub.unregisterNativePush.mockRejectedValue(new HostedHubApiError("not_found", 404));
    test.alerts.start();
    await settle();
    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(test.hub.unregisterNativePush).toHaveBeenCalledTimes(1);
  });

  it("asks the Hub again when removing the registration failed", async () => {
    const test = harness();
    test.alerts.start();
    await settle();
    test.hub.unregisterNativePush.mockRejectedValueOnce(new Error("offline"));
    test.setPreferences({ enabled: false });
    await settle();
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);

    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(test.hub.unregisterNativePush).toHaveBeenCalledTimes(2);
  });
});

describe("the push key across accounts", () => {
  it("is deleted on sign-out and replaced for the next account", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();

    test.setAccount({ status: "signed-out" });
    await settle();
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);
    expect(test.hub.unregisterNativePush).not.toHaveBeenCalled();
    expect(test.alerts.getSnapshot().hub).toBe("signed-out");
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);

    test.setAccount({
      status: "signed-in",
      accountId: "acct_bbbbbbbbbbbbbbbbbbbbbb",
      enrollmentId: `enr_${"f".repeat(22)}`,
    });
    node.reconnect();
    await settle();
    expect(test.pushKey.ensureKey).toHaveBeenCalledTimes(2);
    expect(test.hub.registerNativePush).toHaveBeenCalledTimes(2);
    expect(test.alerts.getSnapshot().hub).toBe("registered");
  });

  it("is replaced when it was recorded for another enrollment", async () => {
    const test = harness({ storedKey: { ...KEY, enrollmentId: `enr_${"o".repeat(22)}` } });
    test.alerts.start();
    await settle();
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);
    expect(test.pushKey.ensureKey).toHaveBeenCalledTimes(2);
    expect(test.pushKey.setRegistration).toHaveBeenCalledWith({
      enrollmentId: ENROLLMENT,
      sound: false,
    });
  });

  it("stays while the session is only being restored", async () => {
    const test = harness();
    test.alerts.start();
    await settle();
    test.setAccount({ status: "pending" });
    await settle();
    test.setAccount({ status: "signed-in", accountId: ACCOUNT, enrollmentId: ENROLLMENT });
    await settle();
    expect(test.pushKey.deleteKey).not.toHaveBeenCalled();
    expect(test.hub.registerNativePush).toHaveBeenCalledTimes(1);
  });
});
