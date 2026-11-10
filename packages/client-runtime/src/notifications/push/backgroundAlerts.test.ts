import { EnvironmentId } from "@ryco/contracts";
import {
  PushRpcError,
  type PushDeviceStatus,
  type PushSetPresenceResult,
} from "@ryco/contracts/push";
import type { NativePushCapability } from "@ryco/contracts/push-hub";
import { describe, expect, it, vi } from "vite-plus/test";

import { HostedHubApiError } from "../../authorization/api.ts";
import type { WsRpcClient } from "../../rpc/wsRpcClient.ts";
import {
  createBackgroundAlerts,
  type BackgroundAlertsAccount,
  type BackgroundAlertsConnection,
  type PushKey,
} from "./backgroundAlerts.ts";
import {
  HUB_PUSH_CAPABILITY_RECHECK_MS,
  NODE_PUSH_RETRY_MS,
  PUSH_PRESENCE_LONG_REFRESH_MS,
  PUSH_PRESENCE_REFRESH_MS,
  PUSH_REGISTRATION_REFRESH_MS,
} from "./backgroundAlertsModel.ts";

const ACCOUNT = "acct_aaaaaaaaaaaaaaaaaaaaaa";
const OTHER_ACCOUNT = "acct_bbbbbbbbbbbbbbbbbbbbbb";
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
  // An older node answers presence with nothing; a newer one with the registration it holds.
  let presence: () => Promise<PushSetPresenceResult> = async () => ({});
  const push = {
    registerDevice: vi.fn((_input: unknown) => answer()),
    unregisterDevice: vi.fn(async (_input: unknown) => ({ removed: true })),
    setPresence: vi.fn((_input: unknown) => presence()),
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
    presence: (next: () => Promise<PushSetPresenceResult>) => {
      presence = next;
    },
    drop: () => {
      ready = null;
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
    /** What survives a restart: the key, the owed Hub removal and the confirmed registrations. */
    readonly device?: {
      storedKey: PushKey | null;
      hubRemovalOwed: string | null;
      nodeRegistrations?: string | null;
    };
    /** The key an earlier installation left, as the install check saved it. */
    readonly earlierInstallKey?: PushKey | null;
  } = {},
) {
  let preferences: {
    enabled: boolean;
    sound: boolean;
    mutedKinds?: ReadonlyArray<
      "approval" | "input" | "plan-ready" | "completed" | "failed" | "stopped"
    >;
    liveActivity?: boolean;
  } = { enabled: options.enabled ?? true, sound: false };
  let liveActivityToken: string | null = null;
  const liveActivityListeners = new Set<() => void>();
  let account: BackgroundAlertsAccount = options.account ?? {
    status: "signed-in",
    accountId: ACCOUNT,
    enrollmentId: ENROLLMENT,
  };
  let active = true;
  let now = 1_800_000_000_000;
  const device: {
    storedKey: PushKey | null;
    hubRemovalOwed: string | null;
    nodeRegistrations?: string | null;
  } = options.device ?? {
    storedKey: options.storedKey ?? null,
    hubRemovalOwed: null,
  };
  const preferenceListeners = new Set<() => void>();
  const accountListeners = new Set<() => void>();
  const appListeners = new Set<() => void>();
  const connectionListeners = new Set<() => void>();
  let connections: ReadonlyArray<ReturnType<typeof fakeConnection>> = [];
  const intervals: Array<() => void> = [];
  /** Each timer's period, by the same index as `intervals`. */
  const intervalMs: number[] = [];

  const hub = {
    getNativePushCapability: vi.fn(async () =>
      options.capability === undefined ? CAPABILITY : options.capability,
    ),
    registerNativePush: vi.fn(async (_input: unknown) => undefined),
    unregisterNativePush: vi.fn(async () => undefined),
  };
  const pushKey = {
    available: true,
    ensureKey: vi.fn(async () => (device.storedKey ??= KEY)),
    readKey: vi.fn(async () => device.storedKey),
    setRegistration: vi.fn(async (input: { readonly enrollmentId: string }) => {
      if (device.storedKey !== null) {
        device.storedKey = { ...device.storedKey, enrollmentId: input.enrollmentId };
      }
    }),
    deleteKey: vi.fn(async () => {
      device.storedKey = null;
    }),
  };
  const hubRemoval = {
    read: vi.fn(async () => device.hubRemovalOwed),
    write: vi.fn(async (accountId: string | null) => {
      device.hubRemovalOwed = accountId;
    }),
  };
  const nodeRegistrations = {
    read: vi.fn(async () => device.nodeRegistrations ?? null),
    write: vi.fn(async (value: string | null) => {
      device.nodeRegistrations = value;
    }),
  };
  const earlier = { key: options.earlierInstallKey ?? null };
  const earlierInstallKey = {
    read: vi.fn(async () => earlier.key),
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
    liveActivity: {
      readToken: () => liveActivityToken,
      subscribe: (listener) => {
        liveActivityListeners.add(listener);
        return () => liveActivityListeners.delete(listener);
      },
    },
    hubRemoval,
    earlierInstallKey,
    nodeRegistrations,
    notifications,
    app: {
      isActive: () => active,
      subscribe: (listener) => {
        appListeners.add(listener);
        return () => appListeners.delete(listener);
      },
    },
    timers: {
      setInterval: (callback, ms) => {
        intervals.push(callback);
        intervalMs.push(ms);
        return intervals.length - 1;
      },
      clearInterval: (handle) => {
        intervals[handle as number] = function cleared() {};
      },
    },
    now: () => now,
  });

  return {
    alerts,
    hub,
    pushKey,
    hubRemoval,
    earlier,
    earlierInstallKey,
    device,
    notifications,
    intervals,
    intervalMs,
    /** The timers still running, with their period. */
    liveTimers: () =>
      intervals
        .map((callback, index) => ({ callback, ms: intervalMs[index]! }))
        .filter(({ callback }) => callback.name !== "cleared"),
    setConnections: (next: ReadonlyArray<ReturnType<typeof fakeConnection>>) => {
      connections = next;
      for (const listener of connectionListeners) listener();
    },
    setPreferences: (next: Partial<typeof preferences>) => {
      preferences = { ...preferences, ...next };
      for (const listener of preferenceListeners) listener();
    },
    setLiveActivityToken: (next: string | null) => {
      liveActivityToken = next;
      for (const listener of liveActivityListeners) listener();
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

  it("ask only for the kinds the person wants, register again when they change, and count none as off", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.setPreferences({ mutedKinds: ["input", "plan-ready", "completed", "stopped", "stopped"] });
    test.alerts.start();
    await settle();
    expect(node.push.registerDevice).toHaveBeenLastCalledWith({
      keyId: KEY.keyId,
      publicKey: KEY.publicKey,
      kinds: ["approval", "failed"],
      sound: false,
    });

    test.setPreferences({ mutedKinds: ["input", "plan-ready", "stopped"] });
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(2);
    expect(node.push.registerDevice).toHaveBeenLastCalledWith(
      expect.objectContaining({ kinds: ["approval", "completed", "failed"] }),
    );

    test.setPreferences({
      mutedKinds: ["approval", "input", "plan-ready", "completed", "failed", "stopped"],
    });
    await settle();
    expect(test.alerts.getSnapshot().enabled).toBe(false);
    expect(node.push.unregisterDevice).toHaveBeenCalled();
  });

  it("hand a Hub that takes Live Activity updates the card's token, and tell the nodes", async () => {
    const LA_TOKEN = "ab".repeat(40);
    const test = harness({ capability: { ...CAPABILITY, liveActivities: true } });
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.setPreferences({ liveActivity: true });
    test.alerts.start();
    await settle();
    // On, but no card yet: the device registers as before, and new cards may ask for a token.
    expect(test.alerts.getSnapshot().liveActivityUpdates).toBe(true);
    expect(test.hub.registerNativePush).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ liveActivityToken: expect.anything() }),
    );
    expect(node.push.registerDevice).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ liveActivity: true }),
    );

    test.setLiveActivityToken(LA_TOKEN);
    await settle();
    expect(test.hub.registerNativePush).toHaveBeenLastCalledWith(
      expect.objectContaining({ token: TOKEN, liveActivityToken: LA_TOKEN }),
    );
    expect(node.push.registerDevice).toHaveBeenLastCalledWith(
      expect.objectContaining({ liveActivity: true }),
    );

    // The card ended: the next registration drops its token.
    test.setLiveActivityToken(null);
    await settle();
    expect(test.hub.registerNativePush).toHaveBeenCalledTimes(3);
    expect(test.hub.registerNativePush).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ liveActivityToken: expect.anything() }),
    );
  });

  it("never send a Live Activity token to a Hub that does not take one", async () => {
    const test = harness();
    test.setConnections([fakeConnection("env-a")]);
    test.setPreferences({ liveActivity: true });
    test.setLiveActivityToken("cd".repeat(40));
    test.alerts.start();
    await settle();
    expect(test.alerts.getSnapshot().liveActivityUpdates).toBe(false);
    expect(test.hub.registerNativePush).toHaveBeenCalledTimes(1);
    expect(test.hub.registerNativePush).toHaveBeenLastCalledWith(
      expect.not.objectContaining({ liveActivityToken: expect.anything() }),
    );
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

  it("ask an older machine, a refusing channel and a failing one only once per connect", async () => {
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
    const flaky = fakeConnection("env-flaky");
    flaky.answer(async () => {
      throw new Error("SocketCloseError");
    });
    test.setConnections([older, local, flaky]);
    test.alerts.start();
    await settle();

    // The Hub directory poll and session updates reconcile often; none asks again.
    for (let poll = 0; poll < 5; poll += 1) {
      test.setAccount({ status: "signed-in", accountId: ACCOUNT, enrollmentId: ENROLLMENT });
      await settle();
    }
    expect(older.push.registerDevice).toHaveBeenCalledTimes(1);
    expect(local.push.registerDevice).toHaveBeenCalledTimes(1);
    expect(flaky.push.registerDevice).toHaveBeenCalledTimes(1);
    expect(test.notifications.readPermission).toHaveBeenCalledTimes(1);

    // A failure is tried again after a minute, at the next trigger.
    test.advance(NODE_PUSH_RETRY_MS);
    test.setAccount({ status: "signed-in", accountId: ACCOUNT, enrollmentId: ENROLLMENT });
    await settle();
    expect(flaky.push.registerDevice).toHaveBeenCalledTimes(2);

    // Coming back retries the failure and reads the permission again; a
    // refusal waits for the next connect.
    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(flaky.push.registerDevice).toHaveBeenCalledTimes(3);
    expect(older.push.registerDevice).toHaveBeenCalledTimes(1);
    expect(test.notifications.readPermission).toHaveBeenCalledTimes(2);

    older.reconnect();
    await settle();
    expect(older.push.registerDevice).toHaveBeenCalledTimes(2);
    expect(local.push.registerDevice).toHaveBeenCalledTimes(1);
  });

  it("ask a machine that reports nothing on presence (an older node) again while in front until its Hub confirmed delivery, and never count offline as covered", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    // A node that just restarted reports offline until its first delivered signal.
    node.answer(async () => nodeStatus({ hubDelivery: "offline" }));
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);
    expect(test.intervals).toHaveLength(1);

    // Still offline at the next presence tick: asked again, still not covered.
    test.intervals[0]!();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(2);
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);
    // Settings keep showing the machine as on while it is asked again.
    expect(test.alerts.getSnapshot().environments.get(env("env-a"))?.status).toBe("registered");

    // A refresh that does not get through keeps the registration and its presence.
    node.answer(async () => {
      throw new Error("SocketCloseError");
    });
    test.intervals[0]!();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(3);
    expect(test.alerts.getSnapshot().environments.get(env("env-a"))?.status).toBe("registered");
    const presence = node.push.setPresence.mock.calls.length;

    node.answer(async () => nodeStatus());
    test.intervals[0]!();
    await settle();
    expect(node.push.setPresence).toHaveBeenCalledTimes(presence + 1);
    expect(node.push.registerDevice).toHaveBeenCalledTimes(4);
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(true);

    // Confirmed: presence ticks and foregrounds ask nothing more.
    test.intervals[0]!();
    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(4);
    expect(node.push.setPresence).toHaveBeenLastCalledWith({ state: "foreground" });
  });

  it("ask a machine again on coming back when its Hub had not confirmed delivery", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    node.answer(async () => nodeStatus({ hubDelivery: "offline" }));
    test.setConnections([node]);
    test.alerts.start();
    await settle();

    // In the background the node pushed, so its Hub now delivers.
    test.setActive(false);
    node.answer(async () => nodeStatus());
    test.setActive(true);
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(2);
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(true);
  });

  it("take a node's presence answer for its registration, and register again only when it lost it", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    // A node that just restarted reports offline until its first delivered signal.
    node.answer(async () => nodeStatus({ hubDelivery: "offline" }));
    node.presence(async () => ({ status: nodeStatus({ hubDelivery: "offline" }) }));
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(1);
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);
    // The current presence timer (leaving and coming back starts a new one).
    const tick = () => test.intervals.at(-1)!();

    // Presence ticks and coming back ask nothing more of it: no registration file rewrites.
    tick();
    await settle();
    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(1);
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);

    // Its Hub delivered a signal: the next answer says so, and push covers the machine.
    node.presence(async () => ({ status: nodeStatus() }));
    tick();
    await settle();
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(true);
    expect(node.push.registerDevice).toHaveBeenCalledTimes(1);

    // The node left its Hub and came back: it lost the registration, so the app registers again.
    node.presence(async () => ({
      status: nodeStatus({ registered: false, keyId: null, kinds: [], hubDelivery: "offline" }),
    }));
    tick();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(2);
    expect(test.alerts.getSnapshot().environments.get(env("env-a"))?.status).toBe("registered");

    // So does a registration of another key (the node kept an older one).
    node.presence(async () => ({
      status: nodeStatus({ keyId: "AAAAAAAAAAAAAAAAAAAAAA" as PushKey["keyId"] }),
    }));
    tick();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(3);
  });

  it("count a lost registration as not covered until the node took it again", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    node.presence(async () => ({ status: nodeStatus() }));
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(true);
    const tick = () => test.intervals.at(-1)!();

    node.answer(async () => {
      throw new Error("SocketCloseError");
    });
    node.presence(async () => ({ status: nodeStatus({ registered: false, keyId: null }) }));
    tick();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(2);
    expect(test.alerts.isConfirmed(env("env-a"), "completed")).toBe(false);
    expect(test.alerts.getSnapshot().environments.get(env("env-a"))?.status).toBe("failed");
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
    expect(node.push.unregisterDevice).toHaveBeenCalledWith({
      keyId: KEY.keyId,
      publicKey: KEY.publicKey,
    });
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
    expect(test.device.hubRemovalOwed).toBeNull();
  });

  it("asks the Hub again when removing the registration failed, also after a restart", async () => {
    const test = harness();
    test.alerts.start();
    await settle();
    test.hub.unregisterNativePush.mockRejectedValueOnce(new Error("offline"));
    test.setPreferences({ enabled: false });
    await settle();
    // The key goes at once; the removal stays owed where a restart finds it.
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);
    expect(test.device.hubRemovalOwed).toBe(ACCOUNT);

    test.setActive(false);
    test.setActive(true);
    await settle();
    expect(test.hub.unregisterNativePush).toHaveBeenCalledTimes(2);
    expect(test.device.hubRemovalOwed).toBeNull();
  });

  it("removes the Hub registration on the next start when the app was closed before it could", async () => {
    const first = harness();
    first.alerts.start();
    await settle();
    first.hub.unregisterNativePush.mockRejectedValue(new Error("offline"));
    first.setPreferences({ enabled: false });
    await settle();
    expect(first.device).toEqual({
      storedKey: null,
      hubRemovalOwed: ACCOUNT,
      // Turning off forgets what nodes confirmed for the key.
      nodeRegistrations: null,
    });

    // The next launch finds no key, only the owed removal.
    const next = harness({ enabled: false, device: first.device });
    next.alerts.start();
    await settle();
    expect(next.hub.unregisterNativePush).toHaveBeenCalledTimes(1);
    expect(next.device.hubRemovalOwed).toBeNull();
    expect(next.hub.registerNativePush).not.toHaveBeenCalled();
  });

  it("removes the Hub registration even when this run's own registration failed", async () => {
    // Launched on, with the key from an earlier run; the Hub refuses this run's PUT.
    const test = harness({ storedKey: { ...KEY, enrollmentId: ENROLLMENT } });
    test.hub.registerNativePush.mockRejectedValue(new Error("offline"));
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(test.alerts.getSnapshot().hub).toBe("failed");

    test.setPreferences({ enabled: false });
    await settle();
    expect(test.hub.unregisterNativePush).toHaveBeenCalledTimes(1);
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);
    expect(test.device.hubRemovalOwed).toBeNull();
  });

  it("asks the machines that are up to forget a key an earlier run left", async () => {
    const test = harness({ enabled: false, storedKey: { ...KEY, enrollmentId: ENROLLMENT } });
    const node = fakeConnection("env-a");
    const direct = fakeConnection("env-direct", { viaHub: false });
    test.setConnections([node, direct]);
    test.alerts.start();
    await settle();
    expect(node.push.unregisterDevice).toHaveBeenCalledWith({
      keyId: KEY.keyId,
      publicKey: KEY.publicKey,
    });
    expect(direct.push.unregisterDevice).not.toHaveBeenCalled();
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);
  });

  it("lets a removal owed for another account go, and a new registration overtake one", async () => {
    const switched = harness({
      enabled: false,
      device: { storedKey: null, hubRemovalOwed: OTHER_ACCOUNT },
    });
    switched.alerts.start();
    await settle();
    // That session, and the Hub's registration with it, are gone.
    expect(switched.hub.unregisterNativePush).not.toHaveBeenCalled();
    expect(switched.device.hubRemovalOwed).toBeNull();

    const turnedOn = harness({ device: { storedKey: null, hubRemovalOwed: ACCOUNT } });
    turnedOn.alerts.start();
    await settle();
    expect(turnedOn.hub.unregisterNativePush).not.toHaveBeenCalled();
    expect(turnedOn.hub.registerNativePush).toHaveBeenCalledTimes(1);
    expect(turnedOn.device.hubRemovalOwed).toBeNull();
  });
});

describe("the key an earlier installation left", () => {
  const EARLIER: PushKey = {
    publicKey: "0123456789abcdefghijklmnopqrstuvwxyzABCDEFG" as PushKey["publicKey"],
    keyId: "EEEEEEEEEEEEEEEEEEEEEE" as PushKey["keyId"],
    enrollmentId: null,
  };

  it("is retired by its public key on every Hub machine it connects to, whether or not alerts are on here", async () => {
    const test = harness({ enabled: false, earlierInstallKey: EARLIER });
    const node = fakeConnection("env-a");
    const later = fakeConnection("env-b");
    later.drop();
    const direct = fakeConnection("env-direct", { viaHub: false });
    test.setConnections([node, later, direct]);
    test.alerts.start();
    await settle();
    const retire = { keyId: EARLIER.keyId, publicKey: EARLIER.publicKey };
    expect(node.push.unregisterDevice).toHaveBeenCalledWith(retire);
    expect(direct.push.unregisterDevice).not.toHaveBeenCalled();
    // Nothing else happens while alerts are off here.
    expect(test.hub.getNativePushCapability).not.toHaveBeenCalled();
    expect(test.hub.unregisterNativePush).not.toHaveBeenCalled();

    later.reconnect();
    await settle();
    expect(later.push.unregisterDevice).toHaveBeenCalledWith(retire);
    expect(node.push.unregisterDevice).toHaveBeenCalledTimes(1);

    // Every machine the app listed answered, but the app lists only the machines
    // it is connected to: the key stays remembered, and a new connect asks again.
    expect(test.earlier.key).not.toBeNull();
    node.reconnect();
    await settle();
    expect(node.push.unregisterDevice).toHaveBeenCalledTimes(2);
  });

  it("asks a machine again when retiring it failed, and an older node's answer once per connection", async () => {
    const test = harness({ earlierInstallKey: EARLIER });
    const flaky = fakeConnection("env-a");
    const older = fakeConnection("env-b");
    // An older node ignores the public key and finds no registration of this device's to remove.
    older.push.unregisterDevice.mockResolvedValue({ removed: false });
    flaky.push.unregisterDevice.mockRejectedValueOnce(new Error("SocketCloseError"));
    test.setConnections([flaky, older]);
    test.alerts.start();
    await settle();
    expect(test.earlier.key).not.toBeNull();
    // This installation still registers as usual.
    expect(flaky.push.registerDevice).toHaveBeenCalledTimes(1);

    flaky.reconnect();
    await settle();
    expect(flaky.push.unregisterDevice).toHaveBeenCalledTimes(2);
    expect(older.push.unregisterDevice).toHaveBeenCalledTimes(1);
    expect(test.earlier.key).not.toBeNull();
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

  it("is replaced when the device enrolls again while the app runs", async () => {
    const test = harness();
    test.alerts.start();
    await settle();
    expect(test.pushKey.ensureKey).toHaveBeenCalledTimes(1);

    const reenrolled = `enr_${"r".repeat(22)}`;
    test.setAccount({ status: "signed-in", accountId: ACCOUNT, enrollmentId: reenrolled });
    await settle();
    expect(test.pushKey.deleteKey).toHaveBeenCalledTimes(1);
    expect(test.pushKey.ensureKey).toHaveBeenCalledTimes(2);
    expect(test.pushKey.setRegistration).toHaveBeenLastCalledWith({
      enrollmentId: reenrolled,
      sound: false,
    });
    expect(test.hub.registerNativePush).toHaveBeenCalledTimes(2);
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

describe("node registrations and presence cadence", () => {
  /** A current node: answers presence with the registration it holds and announces its hold. */
  function currentNode(id: string) {
    const node = fakeConnection(id);
    node.answer(async () => nodeStatus({ foregroundHoldMs: 90_000 }));
    node.presence(async () => ({ status: nodeStatus({ foregroundHoldMs: 90_000 }) }));
    return node;
  }

  it("skip the registration on a connect when the node confirmed exactly this one", async () => {
    const test = harness();
    const node = currentNode("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(1);
    expect(node.push.setPresence).toHaveBeenCalledTimes(1);

    node.reconnect();
    await settle();
    // The presence the connect sends anyway is the whole check.
    expect(node.push.registerDevice).toHaveBeenCalledTimes(1);
    expect(node.push.setPresence).toHaveBeenCalledTimes(2);
    expect(node.push.setPresence).toHaveBeenLastCalledWith({ state: "foreground" });
    expect(test.alerts.isConfirmed(env("env-a"), "approval")).toBe(true);
  });

  it("register again when the node lost it, the settings changed, or a day went by", async () => {
    const test = harness();
    const node = currentNode("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();

    node.presence(async () => ({
      status: nodeStatus({ registered: false, keyId: null, kinds: [], foregroundHoldMs: 90_000 }),
    }));
    node.reconnect();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(2);

    node.presence(async () => ({ status: nodeStatus({ foregroundHoldMs: 90_000 }) }));
    test.setPreferences({ sound: true });
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(3);
    node.reconnect();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(3);

    test.advance(PUSH_REGISTRATION_REFRESH_MS);
    node.reconnect();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(4);
  });

  it("remember what nodes confirmed across a restart, and forget it with the key", async () => {
    const device = {
      storedKey: null as PushKey | null,
      hubRemovalOwed: null,
      nodeRegistrations: null,
    };
    const first = harness({ device });
    const node = currentNode("env-a");
    first.setConnections([node]);
    const stop = first.alerts.start();
    await settle();
    stop();
    expect(device.nodeRegistrations).not.toBeNull();

    const second = harness({ device });
    const again = currentNode("env-a");
    second.setConnections([again]);
    second.alerts.start();
    await settle();
    expect(again.push.registerDevice).not.toHaveBeenCalled();
    expect(again.push.setPresence).toHaveBeenCalledWith({ state: "foreground" });

    second.setAccount({ status: "signed-out" });
    await settle();
    expect(device.nodeRegistrations).toBeNull();
  });

  it("keep registering an older node on every connect", async () => {
    const test = harness();
    const node = fakeConnection("env-a");
    test.setConnections([node]);
    test.alerts.start();
    await settle();
    node.reconnect();
    await settle();
    expect(node.push.registerDevice).toHaveBeenCalledTimes(2);
  });

  it("repeat presence every 40 s to a node holding it 90 s, and every 30 s to an older node", async () => {
    const test = harness();
    const current = currentNode("env-new");
    const older = fakeConnection("env-old");
    test.setConnections([current, older]);
    test.alerts.start();
    await settle();
    expect(
      test
        .liveTimers()
        .map((timer) => timer.ms)
        .toSorted(),
    ).toEqual([PUSH_PRESENCE_REFRESH_MS, PUSH_PRESENCE_LONG_REFRESH_MS]);
    // Each timer speaks to its own nodes, well inside each node's hold.
    expect(PUSH_PRESENCE_LONG_REFRESH_MS * 2).toBeLessThanOrEqual(90_000);
    expect(PUSH_PRESENCE_REFRESH_MS).toBeLessThan(45_000);
    const presenceBefore = [current, older].map((node) => node.push.setPresence.mock.calls.length);
    test
      .liveTimers()
      .find((timer) => timer.ms === PUSH_PRESENCE_LONG_REFRESH_MS)!
      .callback();
    expect(current.push.setPresence.mock.calls.length).toBe(presenceBefore[0]! + 1);
    expect(older.push.setPresence.mock.calls.length).toBe(presenceBefore[1]);

    // Leaving stops both; a node that drops its announcement falls back to 30 s.
    test.setActive(false);
    expect(test.liveTimers()).toEqual([]);
  });

  /**
   * One hour in front with three machines, each reconnecting six times (returns to the app):
   * every registration and presence message the machines receive.
   */
  async function hourWithThreeMachines(nodes: ReadonlyArray<ReturnType<typeof fakeConnection>>) {
    const test = harness();
    test.setConnections(nodes);
    test.alerts.start();
    await settle();
    const HOUR = 60 * 60_000;
    const due = new Map<number, number>();
    for (let elapsed = 0; elapsed <= HOUR; elapsed += 1_000) {
      if (elapsed > 0 && elapsed % (HOUR / 6) === 0) {
        for (const node of nodes) node.reconnect();
        await settle();
      }
      for (const timer of test.liveTimers()) {
        const next = (due.get(timer.ms) ?? 0) + 1_000;
        if (next >= timer.ms) {
          timer.callback();
          due.set(timer.ms, 0);
        } else due.set(timer.ms, next);
      }
      test.advance(1_000);
    }
    await settle();
    const count = (
      pick: (node: ReturnType<typeof fakeConnection>) => { mock: { calls: unknown[] } },
    ) => nodes.reduce((sum, node) => sum + pick(node).mock.calls.length, 0);
    return {
      registrations: count((node) => node.push.registerDevice),
      presence: count((node) => node.push.setPresence),
    };
  }

  it("counts the messages of an hour for three current machines", async () => {
    expect(
      await hourWithThreeMachines([currentNode("a"), currentNode("b"), currentNode("c")]),
    ).toEqual({ registrations: 3, presence: 3 + 18 + 270 });
  });

  it("counts the messages of an hour for three older machines, as before", async () => {
    expect(
      await hourWithThreeMachines([fakeConnection("a"), fakeConnection("b"), fakeConnection("c")]),
    ).toEqual({ registrations: 21, presence: 21 + 360 });
  });
});
