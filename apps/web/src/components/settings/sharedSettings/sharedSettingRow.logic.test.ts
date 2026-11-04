import type { NodeSettingsConfig } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import {
  readSharedSettingView,
  type SharingDevice,
} from "@ryco/client-runtime/state/settings/sharedDeviceSettings";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerSettings } from "@ryco/contracts";
import { SETTINGS_SHARING_VERSION } from "@ryco/shared/settingsSharing";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSharedRowCommand,
  pickSharedRowsDevice,
  describeSharedRowOutcome,
  readSharedRowModel,
  type SharedSettingsMode,
} from "./sharedSettingRow.logic";

const stamp = (at: number, by = "a") => ({ at, by });

function device(
  id: string,
  settings: Partial<ServerSettings> = {},
  options: { connected?: boolean; canWrite?: boolean; sharing?: boolean } = {},
): SharingDevice {
  return {
    environmentId: EnvironmentId.make(id),
    label: id,
    connected: options.connected ?? true,
    canWrite: options.canWrite ?? true,
    config: {
      environment: {
        capabilities:
          options.sharing === false ? {} : { settingsSharingVersion: SETTINGS_SHARING_VERSION },
      },
      settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
    } as unknown as NodeSettingsConfig,
  };
}

const ALL: SharedSettingsMode = { kind: "all" };

function model(
  devices: ReadonlyArray<SharingDevice>,
  input: { mode?: SharedSettingsMode; open?: boolean } = {},
) {
  const view = readSharedSettingView({ key: "worktreeRoot", devices });
  return readSharedRowModel({ view, devices, mode: input.mode ?? ALL, open: input.open ?? false });
}

describe("shared row model", () => {
  it("is one control while every device agrees, counting devices waiting for it", () => {
    const devices = [
      device("a", {
        worktreeRoot: "/w",
        settingsSharing: { worktreeRoot: { mode: "shared", stamp: stamp(5) } },
      }),
      device(
        "b",
        {
          worktreeRoot: "/old",
          settingsSharing: { worktreeRoot: { mode: "shared", stamp: stamp(1) } },
        },
        { connected: false },
      ),
    ];
    expect(model(devices)).toMatchObject({ kind: "same", value: "/w", deviceCount: 2, queued: 1 });
  });

  it("lists the devices while they differ, offering the shared value everywhere", () => {
    const devices = [
      device("a", {
        worktreeRoot: "/w",
        settingsSharing: { worktreeRoot: { mode: "shared", stamp: stamp(5) } },
      }),
      device("b", {
        worktreeRoot: "/mine",
        settingsSharing: { worktreeRoot: { mode: "override", stamp: stamp(5) } },
      }),
    ];
    expect(model(devices)).toMatchObject({ kind: "list", differs: 1, everywhere: "/w" });
    // "Set per device" opens the list while they agree; nothing to unify then.
    expect(model([device("a"), device("b")], { open: true })).toMatchObject({
      kind: "list",
      differs: 0,
      everywhere: null,
    });
  });

  it("reads one device's own value with what the others hold", () => {
    const devices = [device("a", { worktreeRoot: "/a" }), device("b", { worktreeRoot: "/b" })];
    expect(
      model(devices, { mode: { kind: "device", environmentId: EnvironmentId.make("a") } }),
    ).toMatchObject({
      kind: "single",
      device: { value: "/a" },
      others: [{ label: "b", value: "/b" }],
    });
  });

  it("treats devices on the same shared write as agreeing, though each stored its own path", () => {
    const entry = { worktreeRoot: { mode: "shared" as const, stamp: stamp(7) } };
    const devices = [
      device("mac", { worktreeRoot: "/Users/me/w", settingsSharing: entry }),
      device("linux", { worktreeRoot: "/home/me/w", settingsSharing: entry }),
    ];
    expect(model(devices)).toMatchObject({ kind: "same", value: "/Users/me/w" });
  });

  it("shows a shared path as written, the same on a Mac and on Linux", () => {
    const entry = { worktreeRoot: { mode: "shared" as const, stamp: stamp(7), written: "~/w" } };
    const devices = [
      device("mac", { worktreeRoot: "/Users/me/w", settingsSharing: entry }),
      device("linux", { worktreeRoot: "/home/me/w", settingsSharing: entry }),
    ];
    expect(model(devices)).toMatchObject({ kind: "same", value: "~/w" });
    const linux = model(devices, {
      mode: { kind: "device", environmentId: EnvironmentId.make("linux") },
    });
    expect(linux).toMatchObject({ kind: "single", device: { value: "~/w" }, others: [] });
  });

  it("never offers one control when no device can share", () => {
    const devices = [device("a", {}, { sharing: false }), device("b", {}, { sharing: false })];
    expect(model(devices).kind).toBe("list");
  });

  it("marks only connected devices this client may write as editable", () => {
    const devices = [
      device("a", { worktreeRoot: "/a" }),
      device("b", { worktreeRoot: "/b" }, { connected: false }),
      device("c", { worktreeRoot: "/c" }, { canWrite: false }),
    ];
    const result = model(devices);
    if (result.kind !== "list") throw new Error("expected a list");
    expect(result.devices.map((entry) => entry.editable)).toEqual([true, false, false]);
  });
});

describe("shared row commands", () => {
  const nextStamp = () => stamp(10, "me");
  const command = (
    devices: ReadonlyArray<SharingDevice>,
    action: Parameters<typeof buildSharedRowCommand>[0]["action"],
  ) =>
    buildSharedRowCommand({
      key: "worktreeRoot",
      action,
      view: readSharedSettingView({ key: "worktreeRoot", devices }),
      devices,
      nextStamp,
    });

  it("writes every shared device for the one control", () => {
    const result = command([device("a"), device("b")], { kind: "all", value: "/x" });
    expect(result?.writes.map((write) => write.environmentId)).toEqual(["a", "b"]);
    expect(result?.writes[0]?.patch.settingsSharing?.worktreeRoot).toMatchObject({
      mode: "shared",
    });
  });

  it("gives one device among several its own value", () => {
    const result = command([device("a"), device("b")], {
      kind: "device",
      environmentId: EnvironmentId.make("b"),
      value: "/x",
    });
    expect(result?.writes).toEqual([
      expect.objectContaining({
        environmentId: "b",
        patch: expect.objectContaining({
          worktreeRoot: "/x",
          settingsSharing: {
            worktreeRoot: { mode: "override", stamp: stamp(10, "me"), written: "/x" },
          },
        }),
      }),
    ]);
  });

  it("keeps the only device on the shared value, unless it keeps its own", () => {
    const only = command([device("a")], {
      kind: "device",
      environmentId: EnvironmentId.make("a"),
      value: "/x",
    });
    expect(only?.writes[0]?.patch.settingsSharing?.worktreeRoot).toMatchObject({ mode: "shared" });
    const own = command(
      [
        device("a", {
          settingsSharing: { worktreeRoot: { mode: "override", stamp: stamp(2) } },
        }),
      ],
      { kind: "device", environmentId: EnvironmentId.make("a"), value: "/x" },
    );
    expect(own?.writes[0]?.patch.settingsSharing?.worktreeRoot).toMatchObject({
      mode: "override",
    });
  });

  it("writes an older node plainly, without sharing state", () => {
    const result = command([device("a"), device("old", {}, { sharing: false })], {
      kind: "device",
      environmentId: EnvironmentId.make("old"),
      value: "/x",
    });
    expect(result?.writes).toEqual([{ environmentId: "old", patch: { worktreeRoot: "/x" } }]);
  });

  it("says which offline device keeps its own value after “Use … everywhere”", () => {
    const devices = [
      device("a"),
      device(
        "box",
        { settingsSharing: { worktreeRoot: { mode: "override", stamp: stamp(2) } } },
        { connected: false },
      ),
      device("shared-offline", {}, { connected: false }),
    ];
    const action = { kind: "everywhere" as const, value: "/x" };
    const built = command(devices, action);
    if (built === null) throw new Error("expected a command");
    const notes = describeSharedRowOutcome({
      action,
      command: built,
      result: { applied: [{ environmentId: EnvironmentId.make("a"), label: "a" }], notApplied: [] },
      view: readSharedSettingView({ key: "worktreeRoot", devices }),
    });
    expect(notes).toEqual(["box keeps its own value until it is online."]);
  });
});

describe("the device shared rows use when the shown one cannot be", () => {
  it("takes a connected device this client may write, this app's own first", () => {
    const devices = [
      device("offline", {}, { connected: false }),
      device("viewer", {}, { canWrite: false }),
      device("remote"),
      device("own"),
    ];
    expect(pickSharedRowsDevice(devices, EnvironmentId.make("own"))).toBe("own");
    expect(pickSharedRowsDevice(devices, EnvironmentId.make("offline"))).toBe("remote");
    expect(pickSharedRowsDevice(devices, null)).toBe("remote");
  });

  it("is none while no device can be written now, so the rows wait", () => {
    expect(
      pickSharedRowsDevice(
        [device("offline", {}, { connected: false }), device("viewer", {}, { canWrite: false })],
        null,
      ),
    ).toBeNull();
  });
});

describe("review fixes: shared row model and commands", () => {
  const sharedRoot = (root: string, at: number, mode: "shared" | "override" = "shared") => ({
    worktreeRoot: root,
    settingsSharing: { worktreeRoot: { mode, stamp: stamp(at) } },
  });

  it("lists a device keeping its own value, even an equal one, instead of one control", () => {
    const devices = [
      device("a", sharedRoot("/w", 5)),
      device("b", sharedRoot("/w", 5, "override")),
    ];
    expect(model(devices).kind).toBe("list");
  });

  it("lists a device holding a value from before sharing", () => {
    const devices = [device("a", sharedRoot("/w", 5)), device("later", { worktreeRoot: "/mine" })];
    const result = model(devices);
    expect(result.kind).toBe("list");
    if (result.kind === "list") expect(result.devices[1]?.state).toEqual({ kind: "differs" });
  });

  it("counts offline, owner-only, older and unloaded devices apart on one control", () => {
    const unloaded: SharingDevice = {
      environmentId: EnvironmentId.make("unloaded"),
      label: "unloaded",
      config: null,
      connected: false,
      canWrite: false,
    };
    const devices = [
      device("a", sharedRoot("/w", 5)),
      device("away", sharedRoot("/old", 1), { connected: false }),
      device("viewer", sharedRoot("/old", 1), { canWrite: false }),
      device("old", { worktreeRoot: "/w" }, { sharing: false }),
      unloaded,
    ];
    expect(model(devices)).toMatchObject({
      kind: "same",
      deviceCount: 4,
      queued: 1,
      waitingForOwner: 1,
      needUpdate: ["old"],
      notLoaded: 1,
    });
  });

  it("writes one field into each device's own value from the one control", () => {
    const agentControl = (maxDepth: number | null) => ({
      agentControl: { enabled: false, delegation: { maxDepth, maxTasksPerTree: null } },
    });
    const devices = [device("a", agentControl(3)), device("b", agentControl(null))];
    const view = readSharedSettingView({ key: "agentControl", devices });
    const command = buildSharedRowCommand({
      key: "agentControl",
      action: {
        kind: "all",
        value: { enabled: true, delegation: { maxDepth: 3, maxTasksPerTree: null } },
      },
      view,
      devices,
      nextStamp: () => stamp(10),
      applyField: (current, edited) => ({ ...current, enabled: edited.enabled }),
    });
    expect(command?.writes.map((write) => write.patch.agentControl)).toEqual([
      { enabled: true, delegation: { maxDepth: 3, maxTasksPerTree: null } },
      { enabled: true, delegation: { maxDepth: null, maxTasksPerTree: null } },
    ]);
  });

  it("promises a catch-up only to devices that follow the shared value, and names refusals", () => {
    const devices = [
      device("a", sharedRoot("/w", 5)),
      device("own", sharedRoot("/x", 5, "override")),
    ];
    const view = readSharedSettingView({ key: "worktreeRoot", devices });
    const command = buildSharedRowCommand({
      key: "worktreeRoot",
      action: { kind: "everywhere", value: "/w" },
      view,
      devices,
      nextStamp: () => stamp(10),
    });
    if (command === null) throw new Error("expected a command");
    const notes = describeSharedRowOutcome({
      action: { kind: "everywhere", value: "/w" },
      command,
      view,
      result: {
        applied: [],
        notApplied: [
          { environmentId: EnvironmentId.make("a"), label: "a", reason: "disconnected" },
          { environmentId: EnvironmentId.make("own"), label: "own", reason: "disconnected" },
        ],
      },
    });
    expect(notes).toEqual([
      "a went offline; it catches up when it reconnects.",
      "own went offline before the change was saved there.",
    ]);
    const readOnly = describeSharedRowOutcome({
      action: { kind: "device", environmentId: EnvironmentId.make("a"), value: "/v" },
      command,
      view,
      result: {
        applied: [],
        notApplied: [{ environmentId: EnvironmentId.make("a"), label: "a", reason: "read-only" }],
      },
    });
    expect(readOnly).toEqual(["Not saved on a: only its owner can change it."]);
  });
});
