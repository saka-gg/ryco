import { EnvironmentId } from "@ryco/contracts";
import type { SettingsSharingStamp } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_SHARING_STAMP_MAX_AT } from "@ryco/contracts/settings";

import {
  SETTINGS_SHARING_MAX_CLOCK_LEAD_MS,
  clearSettingsSharingNamespace,
  createScopedSettingsSharingPersistence,
  createSettingsSharingClock,
  resolveSettingsSharingClientId,
  settingsSharingStorageKeys,
  type SettingsSharingNamespace,
} from "./settingsSharingClock.ts";
import {
  decodeSettingsSharingCache,
  mergeSettingsSharingCache,
  nextSettingsSharingStamp,
  planSettingsSharingCatchUp,
  describeSettingsSharingResult,
  readDeviceSharingDifferences,
  readDeviceValuesFromBeforeSharing,
  readNewestSharedSetting,
  readSharedSettingView,
  readSharedSettingViews,
  resetSettingToShared,
  resolveDeviceDifferences,
  setSettingOverride,
  sharedDeviceValuesAgree,
  useSettingEverywhere,
  writeSharedSetting,
  type SettingsSharingAttempts,
} from "./sharedDeviceSettings.ts";
import { createDeviceNetwork } from "./sharedDeviceSettings.testSupport.ts";

const stamp = (at: number, by = "client-a"): SettingsSharingStamp => ({ at, by });

function shared(value: string, at: number, by = "client-a") {
  return {
    worktreeBranchPrefix: value,
    settingsSharing: { worktreeBranchPrefix: { mode: "shared" as const, stamp: stamp(at, by) } },
  };
}

function override(value: string, at: number) {
  return {
    worktreeBranchPrefix: value,
    settingsSharing: { worktreeBranchPrefix: { mode: "override" as const, stamp: stamp(at) } },
  };
}

describe("settings sharing clock", () => {
  it("never goes back: not behind the wall clock, issued stamps, or stamps it saw", () => {
    let wall = 1_000;
    const clock = createSettingsSharingClock({ clientId: "a", now: () => wall });
    expect(clock.next()).toEqual({ at: 1_000, by: "a" });
    expect(clock.next()).toEqual({ at: 1_001, by: "a" });
    wall = 500; // set back
    expect(clock.next().at).toBe(1_002);
    clock.observe(stamp(9_000, "b")); // another client's clock runs ahead
    expect(clock.next().at).toBe(9_001);
    wall = 20_000;
    expect(clock.next().at).toBe(20_000);
  });

  it("stays monotonic across a restart from its persisted last time", () => {
    const clock = createSettingsSharingClock({ clientId: "a", now: () => 10, initialLast: 50 });
    expect(clock.next().at).toBe(51);
  });

  it("keeps one stable client id per install", () => {
    let stored: unknown = undefined;
    const store = { read: () => stored, write: (id: string) => (stored = id) };
    const first = resolveSettingsSharingClientId({ ...store, generate: () => "  id-1 " });
    const second = resolveSettingsSharingClientId({ ...store, generate: () => "id-2" });
    expect(first).toBe("id-1");
    expect(second).toBe("id-1");
  });
});

describe("scoped sharing persistence", () => {
  const memory = () => {
    const items = new Map<string, string>();
    return {
      items,
      storage: {
        getItem: (key: string) => items.get(key) ?? null,
        setItem: (key: string, value: string) => void items.set(key, value),
      },
    };
  };
  const local: SettingsSharingNamespace = { kind: "local" };
  const accountA: SettingsSharingNamespace = {
    kind: "hosted",
    hubOrigin: "https://hub.example/",
    accountId: "a",
  };
  const accountB: SettingsSharingNamespace = { ...accountA, accountId: "b" };

  it("keeps a client id, clock and cache per namespace", () => {
    const { storage } = memory();
    let ids = 0;
    const open = (namespace: SettingsSharingNamespace) =>
      createScopedSettingsSharingPersistence({
        storage,
        namespace,
        now: () => 1_000,
        generateId: () => `id-${++ids}`,
      });
    const a = open(accountA);
    const b = open(accountB);
    const l = open(local);
    expect(new Set([a.clock.clientId, b.clock.clientId, l.clock.clientId]).size).toBe(3);
    a.cache.write({ worktreeRoot: "x" });
    expect(b.cache.read()).toBeUndefined();
    expect(l.cache.read()).toBeUndefined();
    // Reopened: the same stored id with this instance's own part, and the clock stays past
    // what it issued.
    a.clock.observe({ at: 5_000, by: "other" });
    const again = open(accountA);
    const stored = (id: string) => id.split("~")[0];
    expect(stored(again.clock.clientId)).toBe(stored(a.clock.clientId));
    expect(again.clock.clientId).not.toBe(a.clock.clientId);
    expect(again.cache.read()).toEqual({ worktreeRoot: "x" });
    expect(again.clock.next().at).toBe(5_001);
    expect(open(accountB).clock.next().at).toBe(1_000);
  });

  it("names the same namespace the same way whatever the origin's case", () => {
    expect(
      settingsSharingStorageKeys({ ...accountA, hubOrigin: "HTTPS://HUB.example" }).cache,
    ).toBe(settingsSharingStorageKeys(accountA).cache);
    expect(settingsSharingStorageKeys(local).cache).not.toBe(
      settingsSharingStorageKeys(accountA).cache,
    );
  });

  it("survives unreadable storage", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    const persistence = createScopedSettingsSharingPersistence({
      storage,
      namespace: local,
      now: () => 7,
      generateId: () => "fresh",
    });
    expect(persistence.clock.clientId).toBe("fresh~fresh");
    expect(persistence.cache.read()).toBeUndefined();
    expect(() => persistence.cache.write({})).not.toThrow();
    expect(() => persistence.cache.clear()).not.toThrow();
    expect(persistence.clock.next()).toEqual({ at: 7, by: "fresh~fresh" });
  });
});

describe("newest shared value", () => {
  it("takes the highest stamp of a shared device, ignoring overrides and zero stamps", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("old", 1) });
    net.add("b", { settings: shared("new", 5) });
    net.add("c", { settings: override("mine", 9) });
    net.add("d", { settings: { worktreeBranchPrefix: "untouched" } });
    const newest = readNewestSharedSetting(net.readTargets(), "worktreeBranchPrefix");
    expect(newest).toMatchObject({ value: "new", stamp: stamp(5), source: "b", fromCache: false });
  });

  it("is null at rollout, so differing values are never unified on their own", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: { worktreeBranchPrefix: "one" } });
    net.add("b", { settings: { worktreeBranchPrefix: "two" } });
    expect(readNewestSharedSetting(net.readTargets(), "worktreeBranchPrefix")).toBeNull();
    expect(planSettingsSharingCatchUp({ devices: net.readTargets(), now: 0 })).toEqual([]);
    const view = readSharedSettingView({ key: "worktreeBranchPrefix", devices: net.readTargets() });
    expect(view.agreement).toEqual({ kind: "differs" });
    expect(view.devices.map((device) => device.state.kind)).toEqual(["shared", "shared"]);
  });

  it("breaks a tie by the lowest environment id", () => {
    const net = createDeviceNetwork();
    net.add("b", { settings: shared("x", 5) });
    net.add("a", { settings: shared("x", 5) });
    expect(readNewestSharedSetting(net.readTargets(), "worktreeBranchPrefix")?.source).toBe("a");
  });

  it("uses the cache only when newer and learned from a device still known", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("device", 3) });
    const cache = {
      worktreeBranchPrefix: { stamp: stamp(8), value: "cached", source: EnvironmentId.make("a") },
    };
    expect(readNewestSharedSetting(net.readTargets(), "worktreeBranchPrefix", cache)).toMatchObject(
      { value: "cached", fromCache: true },
    );
    const foreign = {
      worktreeBranchPrefix: { ...cache.worktreeBranchPrefix, source: EnvironmentId.make("other") },
    };
    expect(readNewestSharedSetting(net.readTargets(), "worktreeBranchPrefix", foreign)?.value).toBe(
      "device",
    );
  });

  it("merges newer device values into the cache and keeps its identity otherwise", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("x", 3) });
    const merged = mergeSettingsSharingCache({}, net.readTargets());
    expect(merged.worktreeBranchPrefix).toEqual({ stamp: stamp(3), value: "x", source: "a" });
    expect(mergeSettingsSharingCache(merged, net.readTargets())).toBe(merged);
    expect(decodeSettingsSharingCache(JSON.parse(JSON.stringify(merged)))).toEqual(merged);
    expect(
      decodeSettingsSharingCache({ worktreeBranchPrefix: { stamp: { at: 0 } }, nope: {} }),
    ).toEqual({});
  });
});

describe("catch-up plan", () => {
  it("writes only connected, writable, shared devices holding an older stamp", () => {
    const net = createDeviceNetwork();
    net.add("newest", { settings: shared("new", 5) });
    net.add("older", { settings: shared("old", 1) });
    net.add("zero", { settings: { worktreeBranchPrefix: "never-shared" } });
    net.add("zero-same", { settings: { worktreeBranchPrefix: "new" } });
    net.add("override", { settings: override("mine", 1) });
    net.add("offline", { settings: shared("old", 1), connected: false });
    net.add("viewer", { settings: shared("old", 1), canWrite: false });
    net.add("old-ryco", { settings: { worktreeBranchPrefix: "old" }, sharingVersion: null });
    const plan = planSettingsSharingCatchUp({ devices: net.readTargets(), now: 0 });
    // A device that never shared takes the stamp only when it already holds the value.
    expect(plan.map((write) => write.environmentId)).toEqual(["older", "zero-same"]);
    expect(plan[0]?.patch).toEqual({
      worktreeBranchPrefix: "new",
      settingsSharing: {
        worktreeBranchPrefix: { mode: "shared", stamp: stamp(5), onlyIfOlderShared: true },
      },
    });
  });

  it("batches every key of a device into one patch, with each key's own part", () => {
    const net = createDeviceNetwork();
    net.add("a", {
      settings: {
        worktreeBranchPrefix: "p",
        runSetupScript: false,
        settingsSharing: {
          worktreeBranchPrefix: { mode: "shared", stamp: stamp(2) },
          runSetupScript: { mode: "shared", stamp: stamp(2) },
        },
      },
    });
    net.add("b", {
      settings: {
        settingsSharing: {
          worktreeBranchPrefix: { mode: "shared", stamp: stamp(1) },
          runSetupScript: { mode: "shared", stamp: stamp(1) },
        },
      },
    });
    const [write] = planSettingsSharingCatchUp({ devices: net.readTargets(), now: 0 });
    expect(write?.environmentId).toBe("b");
    expect(write?.parts.map((part) => part.key).toSorted()).toEqual([
      "runSetupScript",
      "worktreeBranchPrefix",
    ]);
    expect(write?.patch).toMatchObject({ worktreeBranchPrefix: "p", runSetupScript: false });
    expect(Object.keys(write?.patch.settingsSharing ?? {}).toSorted()).toEqual([
      "runSetupScript",
      "worktreeBranchPrefix",
    ]);
  });

  it("holds a key back while its attempt for the same stamp waits", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("new", 5) });
    const b = net.add("b", { settings: shared("old", 1) });
    const attempts: SettingsSharingAttempts = new Map([
      [
        b.environmentId,
        new Map([
          ["worktreeBranchPrefix", { stamp: stamp(5), state: "failed", tries: 1, retryAt: 100 }],
        ]),
      ],
    ]);
    expect(planSettingsSharingCatchUp({ devices: net.readTargets(), attempts, now: 50 })).toEqual(
      [],
    );
    expect(
      planSettingsSharingCatchUp({ devices: net.readTargets(), attempts, now: 100 }),
    ).toHaveLength(1);
  });
});

describe("row view", () => {
  it("names each device's state", () => {
    const net = createDeviceNetwork();
    net.add("newest", { settings: shared("new", 5) });
    net.add("syncing", { settings: shared("old", 1) });
    net.add("offline", { settings: shared("old", 1), connected: false });
    net.add("viewer", { settings: shared("old", 1), canWrite: false });
    net.add("override", { settings: override("mine", 1) });
    net.add("old-ryco", { settings: { worktreeBranchPrefix: "old" }, sharingVersion: null });
    const failed = net.add("failed", { settings: shared("old", 1) });
    const attempts: SettingsSharingAttempts = new Map([
      [
        failed.environmentId,
        new Map([
          [
            "worktreeBranchPrefix",
            { stamp: stamp(5), state: "failed", reason: "bad", tries: 1, retryAt: 9 },
          ],
        ]),
      ],
    ]);
    const devices = [
      ...net.readTargets(),
      {
        environmentId: EnvironmentId.make("unknown"),
        label: "unknown",
        config: null,
        connected: false,
        canWrite: false,
      },
    ];
    const view = readSharedSettingView({ key: "worktreeBranchPrefix", devices, attempts });
    expect(view.devices.map((device) => [device.environmentId, device.state])).toEqual([
      ["newest", { kind: "shared" }],
      ["syncing", { kind: "syncing" }],
      ["offline", { kind: "queued", reason: "offline" }],
      ["viewer", { kind: "queued", reason: "read-only" }],
      ["override", { kind: "override" }],
      ["old-ryco", { kind: "unsupported" }],
      ["failed", { kind: "couldNotApply", reason: "bad" }],
      ["unknown", { kind: "unknown" }],
    ]);
    expect(view.agreement).toEqual({ kind: "differs" });
    expect(view.devices[0]?.holdsNewest).toBe(true);
    const differences = readDeviceSharingDifferences(
      readSharedSettingViews({ devices, attempts }),
      EnvironmentId.make("offline"),
    );
    expect(differences).toEqual([
      { key: "worktreeBranchPrefix", state: { kind: "queued", reason: "offline" }, value: "old" },
    ]);
  });

  it("reads one value when every device agrees", () => {
    const net = createDeviceNetwork();
    net.add("a");
    net.add("b", { connected: false });
    expect(
      readSharedSettingView({ key: "worktreeBranchPrefix", devices: net.readTargets() }).agreement,
    ).toEqual({ kind: "same", value: "ryco" });
  });
});

describe("shared paths across operating systems", () => {
  const sharedPath = (stored: string, at: number, written?: string) => ({
    worktreeRoot: stored,
    settingsSharing: {
      worktreeRoot: {
        mode: "shared" as const,
        stamp: stamp(at),
        ...(written === undefined ? {} : { written }),
      },
    },
  });

  it("catches another OS up to the path as written, never the newest device's own path", () => {
    const net = createDeviceNetwork();
    net.add("mac", { home: "/Users/me", settings: sharedPath("/Users/me/w", 5, "~/w") });
    const linux = net.add("linux", { home: "/home/me", settings: sharedPath("", 1) });
    const [write] = planSettingsSharingCatchUp({ devices: net.readTargets(), now: 0 });
    expect(write?.environmentId).toBe("linux");
    expect(write?.patch.worktreeRoot).toBe("~/w");
    expect(write?.patch.settingsSharing?.worktreeRoot).toEqual({
      mode: "shared",
      stamp: stamp(5),
      onlyIfOlderShared: true,
      written: "~/w",
    });
  });

  it("reads devices on one shared path write as agreeing, by the path as written", async () => {
    const net = createDeviceNetwork();
    const mac = net.add("mac", { home: "/Users/me" });
    const linux = net.add("linux", { home: "/home/me" });
    const command = writeSharedSetting({
      devices: net.readTargets(),
      key: "worktreeRoot",
      value: "~/w",
      stamp: stamp(9),
    });
    for (const write of command.writes)
      await net
        .readTargets()
        .find((t) => t.environmentId === write.environmentId)
        ?.write(write.patch);
    expect([mac.settings.worktreeRoot, linux.settings.worktreeRoot]).toEqual([
      "/Users/me/w",
      "/home/me/w",
    ]);
    const view = readSharedSettingView({ key: "worktreeRoot", devices: net.readTargets() });
    expect(view.agreement).toEqual({ kind: "same", value: "~/w" });
    expect(view.newest?.value).toBe("~/w");
    expect(
      view.devices.map((device) => [device.value, device.written, device.holdsNewest]),
    ).toEqual([
      ["/Users/me/w", "~/w", true],
      ["/home/me/w", "~/w", true],
    ]);
    expect(planSettingsSharingCatchUp({ devices: net.readTargets(), now: 0 })).toEqual([]);
  });

  it("falls back to the stored path and the equal stamp for entries without a written path", () => {
    const net = createDeviceNetwork();
    net.add("mac", { settings: sharedPath("/Users/me/w", 5) });
    net.add("linux", { settings: sharedPath("/home/me/w", 5) });
    net.add("behind", { settings: sharedPath("", 1) });
    const view = readSharedSettingView({ key: "worktreeRoot", devices: net.readTargets() });
    // The first two took one write; only the device behind differs.
    expect(view.agreement).toEqual({ kind: "differs" });
    const [macView, linuxView] = view.devices;
    expect(macView && linuxView && sharedDeviceValuesAgree(macView, linuxView)).toBe(true);
    // Old data has nothing better than the newest device's stored path (tie: lowest id).
    expect(
      planSettingsSharingCatchUp({ devices: net.readTargets(), now: 0 })[0]?.patch.worktreeRoot,
    ).toBe("/home/me/w");
  });

  it("compares written paths, not stamps, when both entries record one", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: sharedPath("/Users/me/a", 5, "~/a") });
    net.add("b", { settings: sharedPath("/home/me/b", 5, "~/b") });
    const [a, b] = readSharedSettingView({
      key: "worktreeRoot",
      devices: net.readTargets(),
    }).devices;
    expect(a && b && sharedDeviceValuesAgree(a, b)).toBe(false);
  });
});

describe("commands", () => {
  it("writes a shared change to shared devices it can write now, guarded like a catch-up", () => {
    const net = createDeviceNetwork();
    net.add("a");
    net.add("override", { settings: override("mine", 1) });
    net.add("offline", { connected: false });
    net.add("old-ryco", { sharingVersion: null });
    const command = writeSharedSetting({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "team",
      stamp: stamp(10),
    });
    expect(command.writes).toEqual([
      {
        environmentId: "a",
        patch: {
          worktreeBranchPrefix: "team",
          settingsSharing: {
            worktreeBranchPrefix: { mode: "shared", stamp: stamp(10), onlyIfOlderShared: true },
          },
        },
      },
    ]);
    expect(command.skipped.map((entry) => [entry.environmentId, entry.reason])).toEqual([
      ["override", "override"],
      ["offline", "offline"],
      ["old-ryco", "unsupported"],
    ]);
    expect(command.shared).toEqual({ stamp: stamp(10), value: "team" });
  });

  it("sets an override on one device, and a plain edit on an older Ryco", () => {
    const net = createDeviceNetwork();
    const a = net.add("a");
    const old = net.add("old", { sharingVersion: null });
    expect(
      setSettingOverride({ device: a.target(), key: "worktreeBranchPrefix", stamp: stamp(3) })
        .writes[0]?.patch,
    ).toEqual({ settingsSharing: { worktreeBranchPrefix: { mode: "override", stamp: stamp(3) } } });
    expect(
      setSettingOverride({
        device: old.target(),
        key: "worktreeBranchPrefix",
        value: "x",
        stamp: stamp(3),
      }).writes[0]?.patch,
    ).toEqual({ worktreeBranchPrefix: "x" });
  });

  it("resets to the newest shared value and stamp, or to the zero stamp before any", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("shared", 4) });
    const b = net.add("b", { settings: override("mine", 9) });
    expect(
      resetSettingToShared({
        device: b.target(),
        devices: net.readTargets(),
        key: "worktreeBranchPrefix",
      }).writes[0]?.patch,
    ).toEqual({
      worktreeBranchPrefix: "shared",
      settingsSharing: { worktreeBranchPrefix: { mode: "shared", stamp: stamp(4) } },
    });
    const lone = createDeviceNetwork();
    const c = lone.add("c", { settings: override("mine", 9) });
    expect(
      resetSettingToShared({
        device: c.target(),
        devices: lone.readTargets(),
        key: "worktreeBranchPrefix",
      }).writes[0]?.patch,
    ).toEqual({ settingsSharing: { worktreeBranchPrefix: null } });
  });

  it("uses a value everywhere it can write now, clearing overrides", () => {
    const net = createDeviceNetwork();
    net.add("a");
    net.add("override", { settings: override("mine", 1) });
    net.add("offline-override", { settings: override("mine", 1), connected: false });
    const command = useSettingEverywhere({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "team",
      stamp: stamp(10),
    });
    expect(command.writes.map((write) => write.environmentId)).toEqual(["a", "override"]);
    expect(command.writes[1]?.patch.settingsSharing).toEqual({
      worktreeBranchPrefix: { mode: "shared", stamp: stamp(10) },
    });
    expect(command.skipped).toEqual([
      { environmentId: "offline-override", label: "offline-override", reason: "offline" },
    ]);
  });

  it("stamps an edit after every stamp the devices show", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("ahead", 50_000, "skewed") });
    const clock = createSettingsSharingClock({ clientId: "me", now: () => 1_000 });
    expect(nextSettingsSharingStamp(clock, net.readTargets())).toEqual({ at: 50_001, by: "me" });
  });
});

describe("review fixes: clock bounds and instances", () => {
  it("ignores stamps far ahead of the wall clock, and never issues past the maximum", () => {
    const wall = 1_000_000;
    const clock = createSettingsSharingClock({ clientId: "a", now: () => wall });
    clock.observe({ at: Number.MAX_SAFE_INTEGER, by: "hostile" });
    clock.observe({ at: wall + SETTINGS_SHARING_MAX_CLOCK_LEAD_MS + 1, by: "hostile" });
    expect(clock.next().at).toBe(wall);
    // A clock a few hours ahead is followed, as before.
    clock.observe({ at: wall + 3_600_000, by: "skewed" });
    expect(clock.next().at).toBe(wall + 3_600_001);
    // A persisted clock pinned far ahead (by a stamp followed before this fix) starts over.
    const restarted = createSettingsSharingClock({
      clientId: "a",
      now: () => wall,
      initialLast: Number.MAX_SAFE_INTEGER,
    });
    expect(restarted.next().at).toBe(wall);
    const atMax = createSettingsSharingClock({
      clientId: "a",
      now: () => SETTINGS_SHARING_STAMP_MAX_AT + 10,
    });
    expect(atMax.next().at).toBe(SETTINGS_SHARING_STAMP_MAX_AT);
  });

  it("gives two tabs on one storage their own `by` and one monotonic clock", () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
    };
    let ids = 0;
    const open = () =>
      createScopedSettingsSharingPersistence({
        storage,
        namespace: { kind: "local" },
        now: () => 1_000,
        generateId: () => `id-${++ids}`,
      });
    const tabA = open();
    const tabB = open();
    // Both saw the same stamp of a device ahead of them.
    const seen = { at: 9_000, by: "skewed" };
    tabA.clock.observe(seen);
    tabB.clock.observe(seen);
    const fromA = tabA.clock.next();
    const fromB = tabB.clock.next();
    expect(fromA.by).not.toBe(fromB.by);
    expect(fromA.by.split("~")[0]).toBe(fromB.by.split("~")[0]);
    // B read A's stored stamp first, so its edit orders after A's.
    expect(fromB.at).toBeGreaterThan(fromA.at);
    // A tab whose clock is behind never stores an older last stamp over a newer one.
    const tabC = createScopedSettingsSharingPersistence({
      storage,
      namespace: { kind: "local" },
      now: () => 1_000,
      generateId: () => `id-${++ids}`,
    });
    const storedLast = () =>
      Number(items.get(settingsSharingStorageKeys({ kind: "local" }).clockLast));
    const before = storedLast();
    tabA.clock.observe({ at: 5, by: "old" });
    expect(storedLast()).toBe(before);
    expect(tabC.clock.next().at).toBeGreaterThan(before);
  });

  it("forgets a namespace's cache and clock, keeping others", () => {
    const items = new Map<string, string>();
    const storage = {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => void items.set(key, value),
      removeItem: (key: string) => void items.delete(key),
    };
    const account: SettingsSharingNamespace = {
      kind: "hosted",
      hubOrigin: "https://hub.example",
      accountId: "a",
    };
    const open = (namespace: SettingsSharingNamespace) =>
      createScopedSettingsSharingPersistence({
        storage,
        namespace,
        now: () => 1_000,
        generateId: () => "id",
      });
    const hosted = open(account);
    hosted.cache.write({ worktreeRoot: "secret" });
    hosted.clock.next();
    const local = open({ kind: "local" });
    local.cache.write({ worktreeRoot: "mine" });
    clearSettingsSharingNamespace(storage, account);
    const keys = settingsSharingStorageKeys(account);
    expect(items.has(keys.cache)).toBe(false);
    expect(items.has(keys.clockLast)).toBe(false);
    expect(local.cache.read()).toEqual({ worktreeRoot: "mine" });
  });
});

describe("review fixes: devices that never shared", () => {
  it("leaves a never-shared device's own value alone and names it, adopting only equal values", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("team", 5) });
    net.add("paired-later", { settings: { worktreeBranchPrefix: "mine" } });
    net.add("same", { settings: { worktreeBranchPrefix: "team" } });
    const devices = net.readTargets();
    const plan = planSettingsSharingCatchUp({ devices, now: 0 });
    expect(plan.map((write) => write.environmentId)).toEqual(["same"]);
    const view = readSharedSettingView({ key: "worktreeBranchPrefix", devices });
    expect(view.devices.map((device) => device.state.kind)).toEqual([
      "shared",
      "differs",
      "shared",
    ]);
    const views = readSharedSettingViews({ devices });
    expect(readDeviceValuesFromBeforeSharing(views, EnvironmentId.make("paired-later"))).toEqual([
      "worktreeBranchPrefix",
    ]);
    expect(readDeviceValuesFromBeforeSharing(views, EnvironmentId.make("same"))).toEqual([]);
  });

  it("still brings a never-shared device along when a person's edit was meant for it", async () => {
    const net = createDeviceNetwork();
    const online = net.add("online");
    const offline = net.add("offline", { connected: false });
    const command = writeSharedSetting({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "team",
      stamp: stamp(10),
    });
    expect(command.followers).toEqual(["online", "offline"]);
    await online.target().write(command.writes[0]!.patch);
    offline.connected = true;
    const devices = net.readTargets();
    // Without this client's record of the edit, the offline device would only be named.
    expect(planSettingsSharingCatchUp({ devices, now: 0 })).toEqual([]);
    const cache = {
      worktreeBranchPrefix: {
        stamp: stamp(10),
        value: "team",
        source: online.environmentId,
        covers: [offline.environmentId],
      },
    };
    expect(
      planSettingsSharingCatchUp({ devices, cache, now: 0 }).map((write) => write.environmentId),
    ).toEqual(["offline"]);
    expect(decodeSettingsSharingCache(JSON.parse(JSON.stringify(cache)))).toEqual(cache);
  });

  it("settles a device's values from before sharing in one write, shared or its own", () => {
    const net = createDeviceNetwork();
    net.add("a", {
      settings: {
        worktreeBranchPrefix: "team",
        runSetupScript: false,
        settingsSharing: {
          worktreeBranchPrefix: { mode: "shared", stamp: stamp(5) },
          runSetupScript: { mode: "shared", stamp: stamp(6) },
        },
      },
    });
    const later = net.add("later", { settings: { worktreeBranchPrefix: "mine" } });
    const devices = net.readTargets();
    const keys = readDeviceValuesFromBeforeSharing(
      readSharedSettingViews({ devices }),
      later.environmentId,
    );
    expect(keys.toSorted()).toEqual(["runSetupScript", "worktreeBranchPrefix"]);
    const useShared = resolveDeviceDifferences({
      device: later.target(),
      devices,
      keys,
      choice: "shared",
      stamp: stamp(20),
    });
    expect(useShared?.writes).toHaveLength(1);
    expect(useShared?.writes[0]?.patch).toMatchObject({
      worktreeBranchPrefix: "team",
      runSetupScript: false,
      settingsSharing: {
        worktreeBranchPrefix: { mode: "shared", stamp: stamp(5) },
        runSetupScript: { mode: "shared", stamp: stamp(6) },
      },
    });
    const keepOwn = resolveDeviceDifferences({
      device: later.target(),
      devices,
      keys,
      choice: "own",
      stamp: stamp(20),
    });
    expect(keepOwn?.writes[0]?.patch).toEqual({
      settingsSharing: {
        worktreeBranchPrefix: { mode: "override", stamp: stamp(20) },
        runSetupScript: { mode: "override", stamp: stamp(20) },
      },
    });
  });

  it("lists rollout differences and an older node's differing value on the device page", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: { worktreeBranchPrefix: "one" } });
    net.add("b", { settings: { worktreeBranchPrefix: "two" } });
    net.add("old", { settings: { worktreeBranchPrefix: "three" }, sharingVersion: null });
    const views = readSharedSettingViews({ devices: net.readTargets() });
    expect(readDeviceSharingDifferences(views, EnvironmentId.make("a"))).toEqual([
      { key: "worktreeBranchPrefix", state: { kind: "differs" }, value: "one" },
    ]);
    expect(readDeviceSharingDifferences(views, EnvironmentId.make("old"))).toEqual([
      { key: "worktreeBranchPrefix", state: { kind: "unsupported" }, value: "three" },
    ]);
  });
});

describe("review fixes: commands and agreement", () => {
  it("does not promise a shared write to an offline device keeping its own value", () => {
    const net = createDeviceNetwork();
    net.add("a");
    net.add("away-own", { settings: override("mine", 1), connected: false });
    net.add("away-shared", { connected: false });
    const write = writeSharedSetting({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "team",
      stamp: stamp(10),
    });
    expect(write.skipped.map((entry) => [entry.environmentId, entry.reason])).toEqual([
      ["away-own", "override"],
      ["away-shared", "offline"],
    ]);
    const everywhere = useSettingEverywhere({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "team",
      stamp: stamp(10),
    });
    const result = {
      applied: [{ environmentId: EnvironmentId.make("a"), label: "a" }],
      notApplied: [],
    };
    expect(describeSettingsSharingResult(everywhere, result)).toBe(
      "Saved on a. Applies when they reconnect: away-shared. Offline: away-own.",
    );
  });

  it("says nothing applies later when no device follows the value", () => {
    const net = createDeviceNetwork();
    net.add("gone", { settings: override("mine", 1) });
    const everywhere = useSettingEverywhere({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "team",
      stamp: stamp(10),
    });
    const result = {
      applied: [],
      notApplied: [
        {
          environmentId: EnvironmentId.make("gone"),
          label: "gone",
          reason: "disconnected" as const,
        },
      ],
    };
    expect(describeSettingsSharingResult(everywhere, result)).toBe(
      "No device was changed now. Went offline before it was saved: gone.",
    );
  });

  it("reads equal stamps holding different values as differing, except for paths", () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("one", 5) });
    net.add("b", { settings: shared("two", 5) });
    expect(
      readSharedSettingView({ key: "worktreeBranchPrefix", devices: net.readTargets() }).agreement,
    ).toEqual({ kind: "differs" });
  });

  it("writes one field of a larger value into each device's own value", () => {
    const net = createDeviceNetwork();
    const agentControl = (maxDepth: number | null, maxTasksPerTree: number | null) => ({
      agentControl: { enabled: false, delegation: { maxDepth, maxTasksPerTree } },
    });
    net.add("a", { settings: agentControl(3, null) });
    net.add("b", { settings: agentControl(null, 50) });
    net.add("away", { settings: agentControl(null, null), connected: false });
    const enable = (value: { enabled: boolean }) => (current: typeof value) => ({
      ...current,
      enabled: value.enabled,
    });
    const command = writeSharedSetting({
      devices: net.readTargets(),
      key: "agentControl",
      value: { enabled: true, delegation: { maxDepth: 3, maxTasksPerTree: null } },
      valueFor: enable({ enabled: true }) as never,
      stamp: stamp(10),
    });
    expect(command.writes.map((write) => write.patch.agentControl)).toEqual([
      { enabled: true, delegation: { maxDepth: 3, maxTasksPerTree: null } },
      { enabled: true, delegation: { maxDepth: null, maxTasksPerTree: 50 } },
    ]);
    // The devices now differ beyond the field: no one value to give a device that missed it.
    expect(command.shared).toBeNull();
    expect(command.followers).toEqual([]);
    const same = createDeviceNetwork();
    same.add("a", { settings: agentControl(3, null) });
    same.add("b", { settings: agentControl(3, null) });
    const together = useSettingEverywhere({
      devices: same.readTargets(),
      key: "agentControl",
      value: { enabled: true, delegation: { maxDepth: 3, maxTasksPerTree: null } },
      valueFor: enable({ enabled: true }) as never,
      stamp: stamp(10),
    });
    expect(together.shared?.value).toEqual({
      enabled: true,
      delegation: { maxDepth: 3, maxTasksPerTree: null },
    });
  });
});
