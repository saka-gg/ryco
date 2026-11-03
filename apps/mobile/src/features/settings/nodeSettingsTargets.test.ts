import {
  nodeAutoSettleRulePatch,
  nodeOwnsAutoSettleRule,
} from "@ryco/client-runtime/state/settings";
import {
  applyNodeSettingsPatch,
  describeNodeSettingsApplyResult,
  readNodeSettingsAgreement,
} from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts/rpc";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { describe, expect, it, vi } from "vite-plus/test";

import type { InboxEnvironment } from "../inbox/inboxModel";
import {
  buildNodeSettingsTargets,
  canChangeNodeSettings,
  homeNodeSettingsTargets,
  NODE_SETTINGS_OWNER_ONLY,
  NODE_SETTINGS_RECONNECT,
  nodeSettingsReadOnlyReason,
} from "./nodeSettingsTargets";

const STUDIO = EnvironmentId.make("studio");
const LAPTOP = EnvironmentId.make("laptop");
const OLD_BOX = EnvironmentId.make("old-box");
const AWAY = EnvironmentId.make("away");

function config(input: {
  readonly nodeAutoSettlement: boolean;
  readonly defaultThreadEnvMode?: "local" | "worktree";
}): ServerConfig {
  return {
    environment: {
      label: "node",
      capabilities: input.nodeAutoSettlement ? { nodeAutoSettlement: true } : {},
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...(input.defaultThreadEnvMode ? { defaultThreadEnvMode: input.defaultThreadEnvMode } : {}),
    },
  } as unknown as ServerConfig;
}

const labels: Record<string, string> = { studio: "Studio", laptop: "Laptop", "old-box": "Old box" };

describe("buildNodeSettingsTargets", () => {
  it("writes to every node it can and reports the unreachable, older and read-only ones", async () => {
    const write = vi.fn(async () => undefined);
    const targets = buildNodeSettingsTargets({
      environmentIds: [STUDIO, LAPTOP, OLD_BOX, AWAY, STUDIO],
      configs: new Map([
        [STUDIO, config({ nodeAutoSettlement: true })],
        [LAPTOP, config({ nodeAutoSettlement: true })],
        [OLD_BOX, config({ nodeAutoSettlement: false })],
      ]),
      labelOf: (environmentId) => labels[environmentId] ?? "Away",
      isOwner: (environmentId) => environmentId !== LAPTOP,
      isConnected: (environmentId) => environmentId !== AWAY,
      write,
    });
    const result = await applyNodeSettingsPatch(targets, nodeAutoSettleRulePatch(30), {
      supported: nodeOwnsAutoSettleRule,
    });

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(STUDIO, { threadAutoSettleAfterDays: 30 });
    expect(describeNodeSettingsApplyResult(result)).toBe(
      "Applied to Studio. Not changed: Laptop (only its owner can change it), Old box (needs an update), Away (not connected).",
    );
  });

  it("gives each node its own config, so a per-node patch compares that node's values", async () => {
    const write = vi.fn(
      async (_environmentId: EnvironmentId, _patch: ServerSettingsPatch) => undefined,
    );
    const targets = buildNodeSettingsTargets({
      environmentIds: [STUDIO, LAPTOP],
      configs: new Map([
        [STUDIO, config({ nodeAutoSettlement: true, defaultThreadEnvMode: "worktree" })],
        [LAPTOP, config({ nodeAutoSettlement: true, defaultThreadEnvMode: "local" })],
      ]),
      labelOf: (environmentId) => labels[environmentId] ?? environmentId,
      isOwner: () => true,
      isConnected: () => true,
      write,
    });
    await applyNodeSettingsPatch(targets, (nodeConfig) => ({
      defaultThreadEnvMode: "worktree",
      expectedNodePreferences: { defaultThreadEnvMode: nodeConfig.settings.defaultThreadEnvMode },
    }));

    expect(write).toHaveBeenCalledWith(STUDIO, {
      defaultThreadEnvMode: "worktree",
      expectedNodePreferences: { defaultThreadEnvMode: "worktree" },
    });
    expect(write).toHaveBeenCalledWith(LAPTOP, {
      defaultThreadEnvMode: "worktree",
      expectedNodePreferences: { defaultThreadEnvMode: "local" },
    });
  });
});

type AccessRow = Pick<InboxEnvironment, "role" | "mutationReady" | "connectionState">;

/** Every role (or none), connection state and synchronization a node row can carry. */
const everyRow: AccessRow[] = [];
for (const role of [undefined, "viewer", "operator", "owner", "client"] as const)
  for (const connectionState of ["connected", "read-only", "reconnecting", "offline"] as const)
    for (const mutationReady of [true, false, undefined]) {
      const row: { -readonly [K in keyof AccessRow]: AccessRow[K] } = { connectionState };
      if (role !== undefined) row.role = role;
      if (mutationReady !== undefined) row.mutationReady = mutationReady;
      everyRow.push(row);
    }

describe("canChangeNodeSettings", () => {
  it("is the node's own owner rule: only a connected, synchronized owner", () => {
    for (const row of everyRow)
      expect(canChangeNodeSettings(row), JSON.stringify(row)).toBe(
        row.role === "owner" && row.connectionState === "connected" && row.mutationReady === true,
      );
  });

  it("serves every owner-only node surface: their methods need the role settings writes need", () => {
    const settings = rpcAccessFor(WS_METHODS.serverUpdateSettings);
    for (const method of [
      WS_METHODS.storageScan,
      WS_METHODS.storageExecute,
      WS_METHODS.serverCheckNodeUpdate,
      WS_METHODS.serverUpdateNode,
      WS_METHODS.serverUpdateProvider,
      WS_METHODS.serverConsumeCodexResetCredit,
    ])
      expect(rpcAccessFor(method), method).toBe(settings);
  });

  it("asks the owner of an unreachable node to reconnect, and anyone else for the owner", () => {
    expect(
      nodeSettingsReadOnlyReason({
        role: "owner",
        connectionState: "connected",
        mutationReady: true,
      }),
    ).toBeNull();
    expect(
      nodeSettingsReadOnlyReason({
        role: "owner",
        connectionState: "offline",
        mutationReady: false,
      }),
    ).toBe(NODE_SETTINGS_RECONNECT);
    expect(
      nodeSettingsReadOnlyReason({
        role: "owner",
        connectionState: "connected",
        mutationReady: false,
      }),
    ).toBe(NODE_SETTINGS_RECONNECT);
    for (const role of [undefined, "viewer", "operator", "client"] as const)
      expect(
        nodeSettingsReadOnlyReason({
          connectionState: "offline",
          ...(role === undefined ? {} : { role }),
        }),
        role,
      ).toBe(NODE_SETTINGS_OWNER_ONLY);
    expect(NODE_SETTINGS_RECONNECT).toBe("Reconnect to change this.");
  });
});

describe("homeNodeSettingsTargets", () => {
  it("counts a viewer's node as connected: it says who may change it and counts in the compare", async () => {
    const write = vi.fn(async () => undefined);
    const targets = homeNodeSettingsTargets({
      nodes: [
        {
          environmentId: STUDIO,
          label: "Studio",
          role: "owner",
          connectionState: "connected",
          mutationReady: true,
        },
        {
          environmentId: LAPTOP,
          label: "Laptop",
          role: "viewer",
          connectionState: "read-only",
          mutationReady: false,
        },
        {
          environmentId: AWAY,
          label: "Away",
          role: "owner",
          connectionState: "offline",
          mutationReady: false,
        },
      ],
      configs: new Map([
        [STUDIO, config({ nodeAutoSettlement: true, defaultThreadEnvMode: "worktree" })],
        [LAPTOP, config({ nodeAutoSettlement: true, defaultThreadEnvMode: "local" })],
        [AWAY, config({ nodeAutoSettlement: true, defaultThreadEnvMode: "local" })],
      ]),
      write,
    });

    expect(readNodeSettingsAgreement(targets, (settings) => settings.defaultThreadEnvMode)).toEqual(
      {
        kind: "mixed",
        values: [
          { label: "Studio", value: "worktree" },
          { label: "Laptop", value: "local" },
        ],
      },
    );
    const result = await applyNodeSettingsPatch(targets, { defaultThreadEnvMode: "local" });
    expect(write).toHaveBeenCalledTimes(1);
    expect(describeNodeSettingsApplyResult(result)).toBe(
      "Applied to Studio. Not changed: Laptop (only its owner can change it), Away (not connected).",
    );
  });
});
