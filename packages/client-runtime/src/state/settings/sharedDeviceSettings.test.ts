import { EnvironmentId } from "@ryco/contracts";
import type { SettingsSharingStamp } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
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
  readDeviceSharingDifferences,
  readNewestSharedSetting,
  readSharedSettingView,
  readSharedSettingViews,
  resetSettingToShared,
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
    // Reopened: the same id, and the clock stays past what it issued.
    a.clock.observe({ at: 5_000, by: "other" });
    const again = open(accountA);
    expect(again.clock.clientId).toBe(a.clock.clientId);
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
    expect(persistence.clock.clientId).toBe("fresh");
    expect(persistence.cache.read()).toBeUndefined();
    expect(() => persistence.cache.write({})).not.toThrow();
    expect(persistence.clock.next()).toEqual({ at: 7, by: "fresh" });
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
    net.add("override", { settings: override("mine", 1) });
    net.add("offline", { settings: shared("old", 1), connected: false });
    net.add("viewer", { settings: shared("old", 1), canWrite: false });
    net.add("old-ryco", { settings: { worktreeBranchPrefix: "old" }, sharingVersion: null });
    const plan = planSettingsSharingCatchUp({ devices: net.readTargets(), now: 0 });
    expect(plan.map((write) => write.environmentId)).toEqual(["older", "zero"]);
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
    net.add("b");
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
    const b = net.add("b");
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
      { key: "worktreeBranchPrefix", state: { kind: "queued", reason: "offline" } },
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
