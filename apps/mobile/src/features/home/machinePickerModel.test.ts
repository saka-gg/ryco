import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildMachinePickerModel,
  combinedMachineTone,
  fallbackMachineFacts,
  machinePickerFactsOf,
  machineTone,
  relativeSeen,
  type MachinePickerFactSources,
  type MachinePickerFacts,
} from "./machinePickerModel";

const NOW = Date.parse("2026-11-09T12:00:00Z");
const MAC = "mac" as EnvironmentId;
const MINI = "mini" as EnvironmentId;
const BOX = "box" as EnvironmentId;
const CLOUD = "cloud" as EnvironmentId;

const FACTS: Record<string, MachinePickerFacts> = {
  mac: { kind: "laptop", reach: "direct", lastSeenAt: null },
  mini: { kind: "mini-pc", reach: "hub", lastSeenAt: null },
  box: { kind: "server", reach: "hub", lastSeenAt: null },
  cloud: { kind: "cloud", reach: "hub", lastSeenAt: NOW - 2 * 3_600_000 },
};
const factsOf = (environmentId: EnvironmentId) => FACTS[environmentId]!;

const MACHINES = [
  { environmentId: MAC, label: "MacBook Pro", connectionState: "connected" as const },
  { environmentId: MINI, label: "Mac mini M4", connectionState: "connected" as const },
  { environmentId: BOX, label: "build-box", connectionState: "reconnecting" as const },
  { environmentId: CLOUD, label: "Ryco Cloud", connectionState: "offline" as const },
];

describe("machine tone", () => {
  it("reads connected, connecting and offline from the connection", () => {
    expect(machineTone({ connectionState: "connected" })).toBe("connected");
    expect(machineTone({ connectionState: "read-only" })).toBe("connected");
    expect(machineTone({ connectionState: "reconnecting" })).toBe("connecting");
    expect(machineTone({ connectionState: "offline" })).toBe("offline");
  });

  it("shows a machine with only cached rows as offline, however its socket looks", () => {
    expect(machineTone({ connectionState: "reconnecting", stale: true })).toBe("offline");
    expect(machineTone({ connectionState: "connected", stale: true })).toBe("offline");
  });

  it("combines several machines: all, some or none connected", () => {
    expect(combinedMachineTone(["connected", "connected"])).toBe("connected");
    expect(combinedMachineTone(["connected", "offline"])).toBe("connecting");
    expect(combinedMachineTone(["connecting"])).toBe("connecting");
    expect(combinedMachineTone(["offline", "offline"])).toBe("offline");
    expect(combinedMachineTone([])).toBe("offline");
  });
});

describe("machine picker model", () => {
  it("stacks the online machines on All machines", () => {
    const model = buildMachinePickerModel({
      environments: MACHINES,
      selected: null,
      factsOf,
      now: NOW,
    });
    expect(model.faceKey).toBe("all");
    expect(model.allSelected).toBe(true);
    expect(model.allDetail).toBe("3 of 4 online");
    expect(model.face).toMatchObject({ kind: "all", onlineCount: 3, tone: "connecting" });
    if (model.face.kind !== "all") throw new Error("expected the All face");
    expect(model.face.stack.map((row) => row.symbol)).toEqual([
      "laptopcomputer",
      "macmini",
      "server.rack",
    ]);
    expect(model.accessibilityLabel).toBe("Machine: All machines, 3 online. Show work from");
  });

  it("stacks at most three machines", () => {
    const many = Array.from({ length: 5 }, (_, index) => ({
      environmentId: `m${index}` as EnvironmentId,
      label: `Machine ${index}`,
      connectionState: "connected" as const,
    }));
    const model = buildMachinePickerModel({
      environments: many,
      selected: null,
      factsOf: (_id, label) => fallbackMachineFacts(label),
      now: NOW,
    });
    expect(model.face).toMatchObject({ kind: "all", onlineCount: 5, tone: "connected" });
    expect(model.face.kind === "all" ? model.face.stack : []).toHaveLength(3);
  });

  it("says how each machine is reached, and when an offline one was last seen", () => {
    const model = buildMachinePickerModel({
      environments: [
        ...MACHINES,
        { environmentId: "viewer" as EnvironmentId, label: "Shared", connectionState: "read-only" },
      ],
      selected: MINI,
      factsOf: (environmentId, label) => FACTS[environmentId] ?? fallbackMachineFacts(label),
      now: NOW,
    });
    expect(model.rows.map((row) => [row.label, row.tone, row.status, row.detail])).toEqual([
      ["MacBook Pro", "connected", "Connected", "Direct"],
      ["Mac mini M4", "connected", "Connected", "Hub"],
      ["build-box", "connecting", "Connecting…", "Hub · connecting"],
      ["Ryco Cloud", "offline", "Offline", "Offline · seen 2h ago"],
      ["Shared", "connected", "View only", "Hub · view only"],
    ]);
    expect(model.rows.map((row) => row.selected)).toEqual([false, true, false, false, false]);
  });

  it("shows the picked machine on the button", () => {
    const model = buildMachinePickerModel({
      environments: MACHINES,
      selected: BOX,
      factsOf,
      now: NOW,
    });
    expect(model.faceKey).toBe("machine:box");
    expect(model.allSelected).toBe(false);
    expect(model.face).toMatchObject({
      kind: "machine",
      machine: { label: "build-box", symbol: "server.rack", tone: "connecting" },
    });
    expect(model.accessibilityLabel).toBe("Machine: build-box, Connecting…. Show work from");
  });

  it("falls back to All machines when the picked machine is gone", () => {
    const model = buildMachinePickerModel({
      environments: MACHINES,
      selected: "gone" as EnvironmentId,
      factsOf,
      now: NOW,
    });
    expect(model.faceKey).toBe("all");
  });

  it("says Offline without a time when it never saw the machine", () => {
    const model = buildMachinePickerModel({
      environments: [{ environmentId: CLOUD, label: "Ryco Cloud", connectionState: "offline" }],
      selected: null,
      factsOf: () => ({ kind: "cloud", reach: "hub", lastSeenAt: null }),
      now: NOW,
    });
    expect(model.rows[0]?.detail).toBe("Offline");
    expect(model.face).toMatchObject({ kind: "all", onlineCount: 0, stack: [], tone: "offline" });
  });
});

describe("relative last seen", () => {
  it("rounds to minutes, hours and days", () => {
    expect(relativeSeen(NOW - 30_000, NOW)).toBe("just now");
    expect(relativeSeen(NOW - 5 * 60_000, NOW)).toBe("5m ago");
    expect(relativeSeen(NOW - 3 * 3_600_000, NOW)).toBe("3h ago");
    expect(relativeSeen(NOW - 50 * 3_600_000, NOW)).toBe("2d ago");
  });
});

describe("machine facts", () => {
  const descriptor = (os: "darwin" | "linux" | "windows", machine?: "server" | null) => ({
    label: "node",
    platform: { os, arch: "arm64" as const, ...(machine === undefined ? {} : { machine }) },
  });
  const config = (
    environmentIcon: "workstation" | undefined,
    os: "darwin" | "linux" | "windows",
    machine?: "server" | null,
  ) =>
    ({
      settings: environmentIcon === undefined ? {} : { environmentIcon },
      environment: descriptor(os, machine),
    }) as unknown as Pick<ServerConfig, "settings" | "environment">;
  const empty: MachinePickerFactSources = {
    direct: new Map(),
    configs: new Map(),
    catalog: new Map(),
    hubLastSeen: new Map(),
  };

  it("prefers the desktop's icon setting, then the machine hint, then the OS", () => {
    expect(
      machinePickerFactsOf(
        { ...empty, configs: new Map([[MINI, config("workstation", "darwin", "server")]]) },
        MINI,
        "Mac mini",
      ).kind,
    ).toBe("workstation");
    expect(
      machinePickerFactsOf(
        { ...empty, configs: new Map([[MINI, config(undefined, "darwin", "server")]]) },
        MINI,
        "Mac mini",
      ).kind,
    ).toBe("server");
    expect(
      machinePickerFactsOf(
        { ...empty, configs: new Map([[BOX, config(undefined, "linux")]]) },
        BOX,
        "build-box",
      ).kind,
    ).toBe("linux");
  });

  it("reads a direct machine's descriptor and when it disconnected", () => {
    const facts = machinePickerFactsOf(
      {
        ...empty,
        direct: new Map([
          [
            MAC,
            {
              descriptor: descriptor("windows"),
              serverConfig: null,
              connectedAt: "2026-11-09T09:00:00Z",
              disconnectedAt: "2026-11-09T10:00:00Z",
            },
          ],
        ]),
      },
      MAC,
      "Gaming PC",
    );
    expect(facts).toEqual({
      kind: "windows",
      reach: "direct",
      lastSeenAt: Date.parse("2026-11-09T10:00:00Z"),
    });
  });

  it("reads a Hub machine from the node catalog and the roster", () => {
    expect(
      machinePickerFactsOf(
        {
          ...empty,
          catalog: new Map([[CLOUD, { iconKind: "cloud", lastSeenAt: 5 }]]),
          hubLastSeen: new Map([[CLOUD, 9]]),
        },
        CLOUD,
        "Ryco Cloud",
      ),
    ).toEqual({ kind: "cloud", reach: "hub", lastSeenAt: 9 });
  });

  it("guesses from the name when nothing else is known", () => {
    expect(machinePickerFactsOf(empty, MINI, "Mac mini M4")).toEqual({
      kind: "mini-pc",
      reach: "hub",
      lastSeenAt: null,
    });
  });
});
