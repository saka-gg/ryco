import {
  nodeAutoSettleRulePatch,
  nodeOwnsAutoSettleRule,
} from "@ryco/client-runtime/state/settings";
import {
  applyNodeSettingsPatch,
  describeNodeSettingsApplyResult,
} from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";
import { describe, expect, it, vi } from "vite-plus/test";

import { buildNodeSettingsTargets } from "./nodeSettingsTargets";

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
