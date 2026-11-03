import type { SettingsSharingStamp } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import type { NodeSettingsTarget } from "./nodeSettingsTargets.ts";
import { createSettingsSharingClock } from "./settingsSharingClock.ts";
import {
  nextSettingsSharingStamp,
  readSharedSettingView,
  useSettingEverywhere,
  writeSharedSetting,
  type SettingsSharingCache,
} from "./sharedDeviceSettings.ts";
import {
  createSettingsSharingRunner,
  executeSettingsSharingCommand,
  settingsSharingRetryDelay,
} from "./sharedDeviceSettingsRunner.ts";
import {
  createDeviceNetwork,
  createManualTimers,
  type SimulatedDevice,
} from "./sharedDeviceSettings.testSupport.ts";

const stamp = (at: number, by = "client-a"): SettingsSharingStamp => ({ at, by });

function shared(value: string, at: number, by = "client-a") {
  return {
    worktreeBranchPrefix: value,
    settingsSharing: { worktreeBranchPrefix: { mode: "shared" as const, stamp: stamp(at, by) } },
  };
}

/** Lets queued config pushes run. */
const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function setup(
  net: ReturnType<typeof createDeviceNetwork>,
  input: {
    readonly clientId?: string;
    readonly skewMs?: number;
    readonly readTargets?: () => ReadonlyArray<NodeSettingsTarget>;
    readonly cache?: { value: unknown };
  } = {},
) {
  const time = { now: 1_000_000 };
  const manual = createManualTimers(time);
  const clock = createSettingsSharingClock({
    clientId: input.clientId ?? "client-a",
    now: () => time.now + (input.skewMs ?? 0),
  });
  const runner = createSettingsSharingRunner({
    readTargets: input.readTargets ?? net.readTargets,
    subscribe: net.subscribe,
    clock,
    now: () => time.now,
    timers: manual.timers,
    ...(input.cache === undefined
      ? {}
      : {
          cache: {
            read: () => input.cache?.value,
            write: (next: SettingsSharingCache) => {
              if (input.cache) input.cache.value = JSON.parse(JSON.stringify(next));
            },
          },
        }),
  });
  return { runner, clock, manual, time };
}

const prefixes = (devices: ReadonlyArray<SimulatedDevice>) =>
  devices.map((device) => device.settings.worktreeBranchPrefix);
const writeCount = (devices: ReadonlyArray<SimulatedDevice>) =>
  devices.reduce((sum, device) => sum + device.writes.length, 0);

describe("settings sharing runner", () => {
  it("catches an offline device up once it reconnects, and writes nothing more after", async () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("new", 5) });
    const b = net.add("b", { settings: shared("old", 1), connected: false });
    const { runner } = setup(net);
    runner.start();
    await runner.runNow();
    expect(b.writes).toEqual([]);
    expect(
      readSharedSettingView({ key: "worktreeBranchPrefix", devices: net.readTargets() }).devices[1]
        ?.state,
    ).toEqual({ kind: "queued", reason: "offline" });
    b.connected = true;
    await runner.runNow();
    expect(b.settings.worktreeBranchPrefix).toBe("new");
    expect(b.settings.settingsSharing.worktreeBranchPrefix?.stamp).toEqual(stamp(5));
    await settle();
    await runner.runNow();
    await runner.runNow();
    expect(b.writes).toHaveLength(1);
    runner.stop();
  });

  it("converges two clients with skewed clocks on one value, without a write storm", async () => {
    const net = createDeviceNetwork();
    const devices = [net.add("desktop"), net.add("laptop"), net.add("phone-node")];
    const desktop = setup(net, { clientId: "desktop-app", skewMs: 60 * 60_000 }); // an hour ahead
    const web = setup(net, { clientId: "web-app" });
    // Both edit at once, each seeing only some devices connected.
    devices[2]!.connected = false;
    const fromDesktop = writeSharedSetting({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "desktop",
      stamp: nextSettingsSharingStamp(desktop.clock, net.readTargets()),
    });
    const fromWeb = writeSharedSetting({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "web",
      stamp: nextSettingsSharingStamp(web.clock, net.readTargets()),
    });
    // The web's write lands last on the laptop.
    await executeSettingsSharingCommand(
      net.readTargets().filter((t) => t.environmentId === "laptop"),
      fromDesktop,
    );
    await executeSettingsSharingCommand(net.readTargets(), fromWeb);
    await executeSettingsSharingCommand(
      net.readTargets().filter((t) => t.environmentId === "desktop"),
      fromDesktop,
    );
    devices[2]!.connected = true;
    await settle();
    desktop.runner.start();
    web.runner.start();
    await Promise.all([desktop.runner.runNow(), web.runner.runNow()]);
    await settle();
    await Promise.all([desktop.runner.runNow(), web.runner.runNow()]);
    // The ahead clock's stamp wins everywhere: the same winner on both clients.
    expect(prefixes(devices)).toEqual(["desktop", "desktop", "desktop"]);
    const writes = writeCount(devices);
    for (let round = 0; round < 3; round += 1) {
      await settle();
      await Promise.all([desktop.runner.runNow(), web.runner.runNow()]);
    }
    expect(writeCount(devices)).toBe(writes);
    // A later edit from the web orders after the stamp it saw, despite its slower clock.
    const later = useSettingEverywhere({
      devices: net.readTargets(),
      key: "worktreeBranchPrefix",
      value: "web-later",
      stamp: nextSettingsSharingStamp(web.clock, net.readTargets()),
    });
    await executeSettingsSharingCommand(net.readTargets(), later);
    await settle();
    await Promise.all([desktop.runner.runNow(), web.runner.runNow()]);
    expect(prefixes(devices)).toEqual(["web-later", "web-later", "web-later"]);
    desktop.runner.stop();
    web.runner.stop();
  });

  it("never catches up an override, even with an older stamp", async () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("new", 5) });
    const mine = net.add("mine", {
      settings: {
        worktreeBranchPrefix: "mine",
        settingsSharing: { worktreeBranchPrefix: { mode: "override", stamp: stamp(1) } },
      },
    });
    const { runner } = setup(net);
    runner.start();
    await runner.runNow();
    expect(mine.writes).toEqual([]);
    expect(mine.settings.worktreeBranchPrefix).toBe("mine");
    runner.stop();
  });

  it("writes nothing without the write capability, and catches up once it is granted", async () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("new", 5) });
    const viewer = net.add("viewer", { settings: shared("old", 1), canWrite: false });
    const { runner } = setup(net);
    runner.start();
    await runner.runNow();
    expect(viewer.writes).toEqual([]);
    viewer.canWrite = true;
    await runner.runNow();
    expect(viewer.settings.worktreeBranchPrefix).toBe("new");
    runner.stop();
  });

  it("checks the capability again right before writing", async () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("new", 5) });
    const b = net.add("b", { settings: shared("old", 1) });
    let reads = 0;
    // Writable while planning, revoked (a new hosted generation) by the time of the write.
    const readTargets = () =>
      net
        .readTargets()
        .map((target) =>
          target.environmentId === "b" && reads++ > 0 ? { ...target, canWrite: false } : target,
        );
    const { runner } = setup(net, { readTargets });
    runner.start();
    await runner.runNow();
    expect(b.writes).toEqual([]);
    runner.stop();
  });

  it("leaves a device on an older Ryco alone and never counts it as queued", async () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("new", 5) });
    const old = net.add("old", { settings: { worktreeBranchPrefix: "old" }, sharingVersion: null });
    const { runner } = setup(net);
    runner.start();
    await runner.runNow();
    expect(old.writes).toEqual([]);
    expect(
      readSharedSettingView({ key: "worktreeBranchPrefix", devices: net.readTargets() }).devices[1]
        ?.state,
    ).toEqual({ kind: "unsupported" });
    runner.stop();
  });

  it("splits a refused batch per key, reports the key, and retries it only after backoff", async () => {
    const net = createDeviceNetwork();
    net.add("a", {
      settings: {
        worktreeBranchPrefix: "team",
        chatsRoot: "/only/on/a",
        settingsSharing: {
          worktreeBranchPrefix: { mode: "shared", stamp: stamp(5) },
          chatsRoot: { mode: "shared", stamp: stamp(5) },
        },
      },
    });
    const b = net.add("b");
    b.reject = (patch) => (patch.chatsRoot !== undefined ? "Chats folder does not exist" : null);
    const { runner, manual } = setup(net);
    runner.start();
    await runner.runNow();
    expect(b.settings.worktreeBranchPrefix).toBe("team");
    expect(b.settings.chatsRoot).toBe("");
    const attempts = runner.readAttempts();
    const view = readSharedSettingView({
      key: "chatsRoot",
      devices: net.readTargets(),
      attempts,
    });
    expect(view.devices[1]?.state).toEqual({
      kind: "couldNotApply",
      reason: "Chats folder does not exist",
    });
    // Pushes and passes before the backoff send nothing.
    const refusedTries = () =>
      runner.readAttempts().get(b.environmentId)?.get("chatsRoot")?.tries ?? 0;
    for (let index = 0; index < 5; index += 1) {
      net.notify();
      await runner.runNow();
    }
    expect(refusedTries()).toBe(1);
    manual.advance(settingsSharingRetryDelay(1));
    await settle();
    await runner.runNow();
    expect(refusedTries()).toBe(2);
    runner.stop();
  });

  it("caches the newest value, so a device catches up while every newer device is offline", async () => {
    const net = createDeviceNetwork();
    const a = net.add("a", { settings: shared("new", 5) });
    const b = net.add("b", { settings: shared("old", 1), connected: false });
    const cache = { value: undefined as unknown };
    const first = setup(net, { cache });
    first.runner.start();
    await first.runner.runNow();
    first.runner.stop();
    expect(cache.value).toMatchObject({ worktreeBranchPrefix: { value: "new", source: "a" } });
    // Later, another session of this client: the newer device is offline and its last known
    // config is gone; the older one is back.
    a.connected = false;
    b.connected = true;
    const withoutA = () =>
      net
        .readTargets()
        .map((target) => (target.environmentId === "a" ? { ...target, config: null } : target));
    const second = setup(net, { cache, readTargets: withoutA });
    second.runner.start();
    await second.runner.runNow();
    expect(b.settings.worktreeBranchPrefix).toBe("new");
    second.runner.stop();
  });

  it("writes nothing once stopped", async () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("new", 5) });
    const b = net.add("b", { settings: shared("old", 1) });
    const { runner, manual } = setup(net);
    runner.start();
    runner.stop();
    net.notify();
    manual.advance(10_000);
    await runner.runNow();
    expect(b.writes).toEqual([]);
  });

  it("runs on config pushes after its debounce", async () => {
    const net = createDeviceNetwork();
    net.add("a", { settings: shared("new", 5) });
    const b = net.add("b", { settings: shared("old", 1), connected: false });
    const { runner, manual } = setup(net);
    runner.start();
    manual.advance(1_000);
    await settle();
    b.connected = true;
    net.notify();
    manual.advance(1_000);
    await settle();
    await settle();
    expect(b.settings.worktreeBranchPrefix).toBe("new");
    runner.stop();
  });
});
