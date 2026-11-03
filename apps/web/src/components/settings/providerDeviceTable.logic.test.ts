import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@ryco/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  groupProviderInstancesAcrossDevices,
  providerInstanceStatus,
  type ProviderTableDevice,
} from "./providerDeviceTable.logic";

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const MAC = EnvironmentId.make("env-mac");
const BUILD = EnvironmentId.make("env-build");
const PI = EnvironmentId.make("env-pi");

function live(
  instanceId: string,
  driver: ProviderDriverKind,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-11-03T00:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

function device(
  environmentId: EnvironmentId,
  instances: Record<string, ProviderInstanceConfig>,
  providers: ReadonlyArray<ServerProvider>,
  overrides: Partial<ProviderTableDevice> = {},
): ProviderTableDevice {
  return {
    environmentId,
    label: environmentId,
    config: {
      settings: {
        providers: DEFAULT_UNIFIED_SETTINGS.providers,
        providerInstances: instances as Record<ProviderInstanceId, ProviderInstanceConfig>,
      },
      providers,
    },
    online: true,
    canEdit: true,
    ...overrides,
  };
}

const work: ProviderInstanceConfig = { driver: claude, enabled: true, displayName: "Work" };

describe("groupProviderInstancesAcrossDevices", () => {
  it("makes one row per instance id across devices, built-ins included", () => {
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, { claudeAgent_work: work }, [live("codex", codex)]),
      device(BUILD, { claudeAgent_work: work }, [live("codex", codex)]),
    ]);
    const codexRow = rows.find((row) => row.instanceId === "codex")!;
    expect(codexRow).toMatchObject({ displayName: "Codex", isDefault: true, match: "id" });
    expect(codexRow.cells.map((cell) => cell.status)).toEqual(["ready", "ready"]);
    const workRows = rows.filter((row) => row.displayName === "Work");
    expect(workRows).toHaveLength(1);
    expect(workRows[0]).toMatchObject({ match: "id", customName: "Work" });
    expect(workRows[0]!.cells.map((cell) => cell.instanceId)).toEqual([
      "claudeAgent_work",
      "claudeAgent_work",
    ]);
  });

  it("falls back to driver and name when the ids differ, and says so", () => {
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, { claudeAgent_work: work }, []),
      device(BUILD, { claudeAgent_job: { ...work, displayName: " work " } }, []),
    ]);
    const workRows = rows.filter((row) => row.customName !== null);
    expect(workRows).toHaveLength(1);
    expect(workRows[0]!.match).toBe("name");
    expect(workRows[0]!.cells.map((cell) => cell.instanceId)).toEqual([
      "claudeAgent_work",
      "claudeAgent_job",
    ]);
  });

  it("never matches by name an id another device holds, nor two instances of one device", () => {
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, { claudeAgent_a: work, claudeAgent_b: work }, []),
      device(BUILD, { claudeAgent_b: work }, []),
    ]);
    const workRows = rows.filter((row) => row.customName === "Work");
    expect(workRows.map((row) => [row.instanceId, row.match])).toEqual([
      ["claudeAgent_a", "id"],
      ["claudeAgent_b", "id"],
    ]);
    expect(workRows[0]!.cells.map((cell) => cell.status)).toEqual(["checking", "missing"]);
  });

  it("groups by id before matching by name, and never overwrites a matched cell", () => {
    // BUILD's job instance is listed before its copy of MAC's work instance: the id still wins.
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, { claudeAgent_work: work }, []),
      device(BUILD, { claudeAgent_job: work, claudeAgent_work: work }, []),
    ]);
    const workRows = rows.filter((row) => row.customName === "Work");
    expect(workRows.map((row) => [row.instanceId, row.match])).toEqual([
      ["claudeAgent_work", "id"],
      ["claudeAgent_job", "id"],
    ]);
    expect(workRows[0]!.cells.map((cell) => cell.instanceId)).toEqual([
      "claudeAgent_work",
      "claudeAgent_work",
    ]);
    expect(workRows[1]!.cells.map((cell) => cell.instanceId)).toEqual([null, "claudeAgent_job"]);
  });

  it("matches a lone instance by name into a row several devices share by id", () => {
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, { claudeAgent_job: work }, []),
      device(BUILD, { claudeAgent_work: work }, []),
      device(PI, { claudeAgent_work: work }, []),
    ]);
    const workRows = rows.filter((row) => row.customName === "Work");
    expect(workRows).toHaveLength(1);
    expect(workRows[0]!.match).toBe("name");
    expect(workRows[0]!.cells.map((cell) => cell.instanceId)).toEqual([
      "claudeAgent_job",
      "claudeAgent_work",
      "claudeAgent_work",
    ]);
  });

  it("keeps the same id on two drivers apart", () => {
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, { shared: { driver: codex, enabled: true, displayName: "Shared" } }, []),
      device(BUILD, { shared: { driver: claude, enabled: true, displayName: "Shared" } }, []),
    ]);
    const shared = rows.filter((row) => row.instanceId === "shared");
    expect(shared.map((row) => row.driver)).toEqual([codex, claude]);
    expect(new Set(shared.map((row) => row.key)).size).toBe(2);
    expect(shared.map((row) => row.cells.map((cell) => cell.status))).toEqual([
      ["checking", "missing"],
      ["missing", "checking"],
    ]);
  });

  it("does not match unnamed instances by their driver's label", () => {
    const unnamed: ProviderInstanceConfig = { driver: codex, enabled: true };
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, { codex_one: unnamed }, []),
      device(BUILD, { codex_two: unnamed }, []),
    ]);
    expect(rows.filter((row) => !row.isDefault).map((row) => row.instanceId)).toEqual([
      "codex_one",
      "codex_two",
    ]);
  });

  it("offers Add only for a custom instance, on an online device this client may edit", () => {
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, { claudeAgent_work: work }, []),
      device(BUILD, {}, []),
      device(PI, {}, [], { online: false }),
      device(EnvironmentId.make("env-viewer"), {}, [], { canEdit: false }),
    ]);
    const workRow = rows.find((row) => row.customName === "Work")!;
    expect(workRow.cells.map((cell) => [cell.status, cell.actionable, cell.stale])).toEqual([
      ["checking", true, false],
      ["missing", true, false],
      ["missing", false, true],
      ["missing", false, false],
    ]);
  });

  it("keeps an offline device's last known state, read only, and an unknown device unknown", () => {
    const rows = groupProviderInstancesAcrossDevices([
      device(MAC, {}, [live("codex", codex)], { online: false }),
      { environmentId: BUILD, label: "build", config: null, online: true, canEdit: true },
    ]);
    const codexRow = rows.find((row) => row.instanceId === "codex")!;
    expect(codexRow.cells).toEqual([
      {
        environmentId: MAC,
        status: "ready",
        instanceId: "codex",
        stale: true,
        actionable: false,
      },
      {
        environmentId: BUILD,
        status: "unknown",
        instanceId: null,
        stale: false,
        actionable: false,
      },
    ]);
  });
});

describe("providerInstanceStatus", () => {
  const instance: ProviderInstanceConfig = { driver: codex, enabled: true };
  it("reads each state from the device's own provider status", () => {
    expect(providerInstanceStatus(instance, live("codex", codex))).toBe("ready");
    expect(providerInstanceStatus({ ...instance, enabled: false }, live("codex", codex))).toBe(
      "off",
    );
    expect(providerInstanceStatus(instance, undefined)).toBe("checking");
    expect(
      providerInstanceStatus(instance, live("codex", codex, { installed: false, status: "error" })),
    ).toBe("not-installed");
    expect(
      providerInstanceStatus(
        instance,
        live("codex", codex, { auth: { status: "unauthenticated" }, status: "error" }),
      ),
    ).toBe("sign-in");
    expect(providerInstanceStatus(instance, live("codex", codex, { status: "warning" }))).toBe(
      "attention",
    );
  });
});
