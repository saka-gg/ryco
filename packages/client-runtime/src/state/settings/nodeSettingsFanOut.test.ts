import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  type ServerConfig,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import { nodeAutoSettleRulePatch, nodeOwnsAutoSettleRule } from "./nodeAutoSettlement.ts";
import {
  applyNodeSettingsPatch,
  describeNodeSettingsApplyResult,
  nodeSettingsBlocker,
  readNodeSettingsAgreement,
  type NodeSettingsConfig,
  type NodeSettingsTarget,
} from "./nodeSettingsFanOut.ts";

const NODE_A = EnvironmentId.make("node-a");
const NODE_B = EnvironmentId.make("node-b");
const NODE_C = EnvironmentId.make("node-c");

function nodeConfig(
  input: {
    readonly nodeAutoSettlement?: boolean;
    readonly settings?: Partial<ServerSettings>;
  } = {},
): NodeSettingsConfig {
  return {
    environment: {
      capabilities:
        input.nodeAutoSettlement === undefined
          ? {}
          : { nodeAutoSettlement: input.nodeAutoSettlement },
    },
    settings: { ...DEFAULT_SERVER_SETTINGS, ...input.settings },
  } as Pick<ServerConfig, "environment" | "settings">;
}

function target(
  environmentId: EnvironmentId,
  label: string,
  input: Partial<Omit<NodeSettingsTarget, "environmentId" | "label">> = {},
): NodeSettingsTarget {
  return {
    environmentId,
    label,
    config: nodeConfig({ nodeAutoSettlement: true }),
    connected: true,
    canWrite: true,
    write: async () => undefined,
    ...input,
  };
}

describe("nodeSettingsBlocker", () => {
  const config = nodeConfig({ nodeAutoSettlement: true });

  it("says why a node cannot take a write now, or nothing when it can", () => {
    expect(nodeSettingsBlocker({ connected: true, config, canWrite: true })).toBeNull();
    expect(nodeSettingsBlocker({ connected: false, config, canWrite: true })).toBe("disconnected");
    expect(nodeSettingsBlocker({ connected: true, config: null, canWrite: true })).toBe(
      "disconnected",
    );
    expect(
      nodeSettingsBlocker(
        { connected: true, config: nodeConfig(), canWrite: true },
        nodeOwnsAutoSettleRule,
      ),
    ).toBe("unsupported");
    expect(nodeSettingsBlocker({ connected: true, config, canWrite: false })).toBe("read-only");
  });

  it("checks connection first, then support, then write access", () => {
    const older = nodeConfig();
    expect(
      nodeSettingsBlocker(
        { connected: false, config: older, canWrite: false },
        nodeOwnsAutoSettleRule,
      ),
    ).toBe("disconnected");
    expect(
      nodeSettingsBlocker(
        { connected: true, config: older, canWrite: false },
        nodeOwnsAutoSettleRule,
      ),
    ).toBe("unsupported");
    // Without a support check, every connected node knows the setting.
    expect(nodeSettingsBlocker({ connected: true, config: older, canWrite: true })).toBeNull();
  });
});

describe("applyNodeSettingsPatch", () => {
  it("writes to every reachable node and reports the ones it could not", async () => {
    const writeA = vi.fn(async () => undefined);
    const result = await applyNodeSettingsPatch(
      [
        target(NODE_A, "Studio", { write: writeA }),
        target(NODE_B, "Laptop", {
          write: async () => {
            throw new Error("Connection lost");
          },
        }),
        target(NODE_C, "Old box", { config: nodeConfig({ nodeAutoSettlement: false }) }),
      ],
      nodeAutoSettleRulePatch(14),
      { supported: nodeOwnsAutoSettleRule },
    );

    expect(writeA).toHaveBeenCalledWith({ threadAutoSettleAfterDays: 14 });
    expect(result.applied).toEqual([{ environmentId: NODE_A, label: "Studio" }]);
    expect(result.notApplied).toEqual([
      { environmentId: NODE_B, label: "Laptop", reason: "failed", detail: "Connection lost" },
      { environmentId: NODE_C, label: "Old box", reason: "unsupported" },
    ]);
  });

  it("builds each node's patch from that node's own config", async () => {
    const writes = new Map<EnvironmentId, ServerSettingsPatch>();
    const recordingTarget = (
      environmentId: EnvironmentId,
      label: string,
      mode: "local" | "worktree",
    ) =>
      target(environmentId, label, {
        config: nodeConfig({ settings: { defaultThreadEnvMode: mode } }),
        write: async (patch) => {
          writes.set(environmentId, patch);
        },
      });
    const patchFor = vi.fn((config: NodeSettingsConfig): ServerSettingsPatch => ({
      defaultThreadEnvMode: "worktree",
      expectedNodePreferences: { defaultThreadEnvMode: config.settings.defaultThreadEnvMode },
    }));

    const result = await applyNodeSettingsPatch(
      [
        recordingTarget(NODE_A, "Studio", "worktree"),
        recordingTarget(NODE_B, "Laptop", "local"),
        target(NODE_C, "Away", { connected: false }),
      ],
      patchFor,
    );

    expect(result.applied.map((node) => node.label)).toEqual(["Studio", "Laptop"]);
    // A blocked node never builds a patch.
    expect(patchFor).toHaveBeenCalledTimes(2);
    expect(writes.get(NODE_A)?.expectedNodePreferences).toEqual({
      defaultThreadEnvMode: "worktree",
    });
    expect(writes.get(NODE_B)?.expectedNodePreferences).toEqual({
      defaultThreadEnvMode: "local",
    });
  });

  it("keeps applying to the other nodes when one write is refused", async () => {
    const writeA = vi.fn(async () => undefined);
    const writeC = vi.fn(async () => undefined);
    const result = await applyNodeSettingsPatch(
      [
        target(NODE_A, "Studio", { write: writeA }),
        target(NODE_B, "Laptop", {
          write: async () => {
            throw new Error("Node preferences changed elsewhere. Reload before saving.");
          },
        }),
        target(NODE_C, "Mini", { write: writeC }),
      ],
      { pullRequestTemplates: false },
    );

    expect(writeA).toHaveBeenCalledWith({ pullRequestTemplates: false });
    expect(writeC).toHaveBeenCalledWith({ pullRequestTemplates: false });
    expect(result.applied.map((node) => node.label)).toEqual(["Studio", "Mini"]);
    expect(result.notApplied).toEqual([
      {
        environmentId: NODE_B,
        label: "Laptop",
        reason: "failed",
        detail: "Node preferences changed elsewhere. Reload before saving.",
      },
    ]);
  });

  it("never writes to a node this client may not change", async () => {
    const write = vi.fn(async () => undefined);
    const result = await applyNodeSettingsPatch(
      [target(NODE_A, "Studio", { canWrite: false, write })],
      { pullRequestTemplates: false },
    );
    expect(write).not.toHaveBeenCalled();
    expect(result.notApplied).toEqual([
      { environmentId: NODE_A, label: "Studio", reason: "read-only" },
    ]);
  });
});

describe("describeNodeSettingsApplyResult", () => {
  it("names the nodes it reached and every node it could not", () => {
    expect(
      describeNodeSettingsApplyResult({
        applied: [{ environmentId: NODE_A, label: "Studio" }],
        notApplied: [
          { environmentId: NODE_B, label: "Laptop", reason: "disconnected" },
          { environmentId: EnvironmentId.make("old"), label: "Old box", reason: "unsupported" },
          { environmentId: EnvironmentId.make("pi"), label: "Pi", reason: "read-only" },
          {
            environmentId: EnvironmentId.make("mini"),
            label: "Mini",
            reason: "failed",
            detail: "Connection lost",
          },
          { environmentId: EnvironmentId.make("box"), label: "Box", reason: "failed" },
        ],
      }),
    ).toBe(
      "Applied to Studio. Not changed: Laptop (not connected), Old box (needs an update), Pi (only its owner can change it), Mini (Connection lost), Box (could not save).",
    );
    expect(describeNodeSettingsApplyResult({ applied: [], notApplied: [] })).toBe(
      "No node was changed.",
    );
  });
});

describe("readNodeSettingsAgreement", () => {
  const node = (label: string, settings: Partial<ServerSettings>, connected = true) => ({
    label,
    connected,
    config: nodeConfig({ settings }),
  });
  const mode = (settings: ServerSettings) => settings.defaultThreadEnvMode;

  it("is mixed when connected nodes disagree, with each node's value", () => {
    expect(
      readNodeSettingsAgreement(
        [
          node("Studio", { defaultThreadEnvMode: "worktree" }),
          node("Laptop", { defaultThreadEnvMode: "local" }),
        ],
        mode,
      ),
    ).toEqual({
      kind: "mixed",
      values: [
        { label: "Studio", value: "worktree" },
        { label: "Laptop", value: "local" },
      ],
    });
  });

  it("is the same value when they agree, compared structurally", () => {
    const model = (instanceId: string) => ({
      instanceId,
      model: "gpt",
      options: [{ id: "reasoningEffort", value: "high" }],
    });
    expect(
      readNodeSettingsAgreement(
        [
          node("Studio", { textGenerationModelSelection: model("codex") as never }),
          node("Laptop", { textGenerationModelSelection: model("codex") as never }),
        ],
        (settings) => settings.textGenerationModelSelection,
      ),
    ).toEqual({ kind: "same", value: model("codex") });
  });

  it("ignores nodes that are not connected, have no config or do not know the setting", () => {
    const rule = (settings: ServerSettings) => settings.threadAutoSettleAfterDays;
    const nodes = [
      {
        label: "Studio",
        connected: true,
        config: nodeConfig({
          nodeAutoSettlement: true,
          settings: { threadAutoSettleAfterDays: 30 },
        }),
      },
      {
        label: "Away",
        connected: false,
        config: nodeConfig({
          nodeAutoSettlement: true,
          settings: { threadAutoSettleAfterDays: 3 },
        }),
      },
      { label: "Unknown", connected: true, config: null },
      // An older node's settings read as the default, which it does not keep.
      { label: "Old box", connected: true, config: nodeConfig({ nodeAutoSettlement: false }) },
    ];
    expect(readNodeSettingsAgreement(nodes, rule)).toEqual({
      kind: "mixed",
      values: [
        { label: "Studio", value: 30 },
        { label: "Old box", value: undefined },
      ],
    });
    expect(readNodeSettingsAgreement(nodes, rule, { supported: nodeOwnsAutoSettleRule })).toEqual({
      kind: "same",
      value: 30,
    });
  });

  it("is none when no node can be read", () => {
    expect(readNodeSettingsAgreement([], mode)).toEqual({ kind: "none" });
    expect(
      readNodeSettingsAgreement([node("Away", { defaultThreadEnvMode: "local" }, false)], mode),
    ).toEqual({ kind: "none" });
  });
});
