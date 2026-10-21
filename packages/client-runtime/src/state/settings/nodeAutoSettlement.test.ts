import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  applyAutoSettleRuleToNodes,
  autoSettleRuleHandOverKey,
  autoSettleRuleHandOverPatch,
  autoSettleRuleScopeNote,
  autoSettleRuleTargetBlocker,
  changeAutoSettleRule,
  createAutoSettleRuleHandOver,
  describeAutoSettleRuleApplyResult,
  readAutoSettleRuleHandOverKey,
  readNodeAutoSettleRule,
  resolveAutoSettleRuleEdit,
  shouldHandOverAutoSettleRule,
  type AutoSettleRuleHandOverInput,
} from "./nodeAutoSettlement.ts";

const NODE_A = EnvironmentId.make("node-a");
const NODE_B = EnvironmentId.make("node-b");

function nodeConfig(input: {
  readonly nodeAutoSettlement?: boolean;
  readonly threadAutoSettleAfterDays?: 1 | 3 | 7 | 14 | 30 | 90 | null;
}): Pick<ServerConfig, "environment" | "settings"> {
  return {
    environment: {
      capabilities:
        input.nodeAutoSettlement === undefined
          ? {}
          : { nodeAutoSettlement: input.nodeAutoSettlement },
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...(input.threadAutoSettleAfterDays === undefined
        ? {}
        : { threadAutoSettleAfterDays: input.threadAutoSettleAfterDays }),
    },
  } as Pick<ServerConfig, "environment" | "settings">;
}

describe("readNodeAutoSettleRule", () => {
  it("is the node's rule, the shared default until set, and none from an older node", () => {
    expect(readNodeAutoSettleRule(nodeConfig({ nodeAutoSettlement: true }))).toBe(7);
    expect(
      readNodeAutoSettleRule(
        nodeConfig({ nodeAutoSettlement: true, threadAutoSettleAfterDays: null }),
      ),
    ).toBeNull();
    expect(readNodeAutoSettleRule(nodeConfig({ threadAutoSettleAfterDays: 30 }))).toBeUndefined();
    expect(readNodeAutoSettleRule(null)).toBeUndefined();
  });
});

describe("shouldHandOverAutoSettleRule", () => {
  const handOver: AutoSettleRuleHandOverInput = {
    config: nodeConfig({ nodeAutoSettlement: true }),
    clientValue: 30,
    role: "owner",
    mutationReady: true,
  };

  it("hands a custom client rule to an owned, ready node that never had one", () => {
    expect(shouldHandOverAutoSettleRule(handOver)).toBe(true);
    // Off is a custom choice too.
    expect(shouldHandOverAutoSettleRule({ ...handOver, clientValue: null })).toBe(true);
  });

  it("never overwrites a rule the node already has", () => {
    for (const value of [7, 30, null] as const) {
      expect(
        shouldHandOverAutoSettleRule({
          ...handOver,
          config: nodeConfig({ nodeAutoSettlement: true, threadAutoSettleAfterDays: value }),
        }),
      ).toBe(false);
    }
  });

  it("does nothing for the default, a non-owner, an unready connection or an older node", () => {
    expect(shouldHandOverAutoSettleRule({ ...handOver, clientValue: 7 })).toBe(false);
    for (const role of ["viewer", "operator", "client", null] as const) {
      expect(shouldHandOverAutoSettleRule({ ...handOver, role })).toBe(false);
    }
    expect(shouldHandOverAutoSettleRule({ ...handOver, mutationReady: false })).toBe(false);
    expect(shouldHandOverAutoSettleRule({ ...handOver, config: nodeConfig({}) })).toBe(false);
    expect(shouldHandOverAutoSettleRule({ ...handOver, config: null })).toBe(false);
  });

  it("writes only while the node still has no rule", () => {
    expect(autoSettleRuleHandOverPatch(30)).toEqual({
      threadAutoSettleAfterDays: 30,
      expectedThreadAutoSettleAfterDays: "absent",
    });
  });
});

describe("createAutoSettleRuleHandOver", () => {
  const candidate = {
    environmentId: NODE_A,
    config: nodeConfig({ nodeAutoSettlement: true }),
    role: "owner" as const,
    mutationReady: true,
  };

  it("writes once per node while a hand-over is in flight", async () => {
    const write = vi.fn(async () => undefined);
    const handOver = createAutoSettleRuleHandOver(write);
    expect(handOver.run([candidate, { ...candidate, environmentId: NODE_B }], 30)).toEqual([
      NODE_A,
      NODE_B,
    ]);
    expect(handOver.run([candidate], 30)).toEqual([]);
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenCalledWith(NODE_A, autoSettleRuleHandOverPatch(30));
  });

  it("does not repeat a failing write on every run, only after the node was not ready", async () => {
    const write = vi.fn(async () => {
      throw new Error("Only the node's owner can change its settings.");
    });
    const handOver = createAutoSettleRuleHandOver(write);
    expect(handOver.run([candidate], 30)).toEqual([NODE_A]);
    await Promise.resolve();
    for (let run = 0; run < 5; run += 1) {
      expect(handOver.run([candidate], 30)).toEqual([]);
      await Promise.resolve();
    }
    expect(write).toHaveBeenCalledTimes(1);

    // A reconnect (or another account) passes through not ready and arms it again.
    expect(handOver.run([{ ...candidate, mutationReady: false }], 30)).toEqual([]);
    expect(handOver.run([candidate], 30)).toEqual([NODE_A]);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("leaves a node that is not its owner's, or keeps a rule, alone", () => {
    const write = vi.fn(async () => undefined);
    const handOver = createAutoSettleRuleHandOver(write);
    expect(
      handOver.run(
        [
          { ...candidate, role: "client" },
          {
            ...candidate,
            environmentId: NODE_B,
            config: nodeConfig({ nodeAutoSettlement: true, threadAutoSettleAfterDays: null }),
          },
        ],
        30,
      ),
    ).toEqual([]);
    expect(write).not.toHaveBeenCalled();
  });
});

describe("autoSettleRuleHandOverKey", () => {
  const listed = [
    { environmentId: NODE_A, mutationReady: true, role: "owner" as const, label: "Studio" },
    { environmentId: NODE_B, mutationReady: false, label: "Laptop" },
  ];

  it("stays equal while the same environments are listed, ready and owned", () => {
    const key = autoSettleRuleHandOverKey(listed, 30);
    expect(
      autoSettleRuleHandOverKey(
        listed.map((environment) => ({ ...environment })),
        30,
      ),
    ).toBe(key);
    expect(readAutoSettleRuleHandOverKey(key!)).toEqual([
      { environmentId: NODE_A, mutationReady: true, role: "owner" },
      { environmentId: NODE_B, mutationReady: false, role: null },
    ]);
    expect(
      autoSettleRuleHandOverKey(
        listed.map((environment) => ({ ...environment, mutationReady: true })),
        30,
      ),
    ).not.toBe(key);
  });

  it("is null for a client on the shared default, which never hands it over", () => {
    expect(autoSettleRuleHandOverKey(listed, 7)).toBeNull();
  });
});

describe("autoSettleRuleTargetBlocker", () => {
  const config = nodeConfig({ nodeAutoSettlement: true });

  it("says why a node cannot take the rule now, or nothing when it can", () => {
    expect(autoSettleRuleTargetBlocker({ connected: true, config, canWrite: true })).toBeNull();
    expect(autoSettleRuleTargetBlocker({ connected: false, config, canWrite: true })).toBe(
      "disconnected",
    );
    expect(autoSettleRuleTargetBlocker({ connected: true, config: null, canWrite: true })).toBe(
      "disconnected",
    );
    expect(
      autoSettleRuleTargetBlocker({ connected: true, config: nodeConfig({}), canWrite: true }),
    ).toBe("unsupported");
    expect(autoSettleRuleTargetBlocker({ connected: true, config, canWrite: false })).toBe(
      "read-only",
    );
  });
});

describe("applyAutoSettleRuleToNodes", () => {
  it("writes to every reachable node and reports the ones it could not", async () => {
    const writeA = vi.fn(async () => undefined);
    const result = await applyAutoSettleRuleToNodes(14, [
      { environmentId: NODE_A, label: "Studio", blocker: null, write: writeA },
      {
        environmentId: NODE_B,
        label: "Laptop",
        blocker: null,
        write: async () => {
          throw new Error("Connection lost");
        },
      },
      {
        environmentId: EnvironmentId.make("node-c"),
        label: "Old box",
        blocker: "unsupported",
        write: async () => undefined,
      },
    ]);

    expect(writeA).toHaveBeenCalledWith({ threadAutoSettleAfterDays: 14 });
    expect(result.applied).toEqual([{ environmentId: NODE_A, label: "Studio" }]);
    expect(result.notApplied).toEqual([
      { environmentId: NODE_B, label: "Laptop", reason: "failed", detail: "Connection lost" },
      { environmentId: EnvironmentId.make("node-c"), label: "Old box", reason: "unsupported" },
    ]);
  });
});

describe("describeAutoSettleRuleApplyResult", () => {
  it("names the nodes it reached and every node it could not", () => {
    expect(
      describeAutoSettleRuleApplyResult({
        applied: [{ environmentId: NODE_A, label: "Studio" }],
        notApplied: [
          { environmentId: NODE_B, label: "Laptop", reason: "disconnected" },
          { environmentId: EnvironmentId.make("old"), label: "Old box", reason: "unsupported" },
          {
            environmentId: EnvironmentId.make("mini"),
            label: "Mini",
            reason: "failed",
            detail: "Connection lost",
          },
        ],
      }),
    ).toBe(
      "Applied to Studio. Not changed: Laptop (not connected), Old box (needs an update), Mini (Connection lost).",
    );
    expect(describeAutoSettleRuleApplyResult({ applied: [], notApplied: [] })).toBe(
      "No node was changed.",
    );
  });
});

describe("resolveAutoSettleRuleEdit", () => {
  const studio = { label: "Studio", ownsRule: true, value: 7, editable: true } as const;

  it("writes the node's rule when the node keeps it, Off included", () => {
    expect(resolveAutoSettleRuleEdit(studio, 30)).toEqual({
      kind: "node",
      patch: { threadAutoSettleAfterDays: 30 },
    });
    expect(resolveAutoSettleRuleEdit(studio, null)).toEqual({
      kind: "node",
      patch: { threadAutoSettleAfterDays: null },
    });
  });

  it("changes nothing on a node this client may not change", () => {
    expect(resolveAutoSettleRuleEdit({ ...studio, editable: false }, 30)).toBeNull();
  });

  it("keeps this device's rule for an older node, or without a node", () => {
    expect(resolveAutoSettleRuleEdit({ ...studio, ownsRule: false }, 3)).toEqual({
      kind: "device",
      value: 3,
    });
    expect(resolveAutoSettleRuleEdit(null, null)).toEqual({ kind: "device", value: null });
  });
});

describe("changeAutoSettleRule", () => {
  const studio = {
    environmentId: NODE_A,
    label: "Studio",
    ownsRule: true,
    value: 7,
    editable: true,
  } as const;

  it("writes the node's rule to the node, not to this device", async () => {
    const writeNode = vi.fn(async () => undefined);
    const writeDevice = vi.fn();
    await expect(
      changeAutoSettleRule({ node: studio, value: 30, writeNode, writeDevice }),
    ).resolves.toBe("node");
    expect(writeNode).toHaveBeenCalledWith(NODE_A, { threadAutoSettleAfterDays: 30 });
    expect(writeDevice).not.toHaveBeenCalled();
  });

  it("keeps this device's rule for an older node and changes nothing read-only", async () => {
    const writeNode = vi.fn(async () => undefined);
    const writeDevice = vi.fn();
    await expect(
      changeAutoSettleRule({
        node: { ...studio, ownsRule: false },
        value: 3,
        writeNode,
        writeDevice,
      }),
    ).resolves.toBe("device");
    expect(writeDevice).toHaveBeenCalledWith(3);
    await expect(
      changeAutoSettleRule({
        node: { ...studio, editable: false },
        value: 3,
        writeNode,
        writeDevice,
      }),
    ).resolves.toBeNull();
    expect(writeNode).not.toHaveBeenCalled();
    expect(writeDevice).toHaveBeenCalledTimes(1);
  });

  it("passes a failed node write on to the caller", async () => {
    await expect(
      changeAutoSettleRule({
        node: studio,
        value: null,
        writeNode: async () => {
          throw new Error("Connection lost");
        },
        writeDevice: () => undefined,
      }),
    ).rejects.toThrow("Connection lost");
  });
});

describe("autoSettleRuleScopeNote", () => {
  it("names the node the rule is set on, and says when only its owner can change it", () => {
    expect(autoSettleRuleScopeNote({ node: { label: "Studio", editable: true } })).toBe(
      "Set on Studio, so every device lists its tasks the same way.",
    );
    expect(autoSettleRuleScopeNote({ node: { label: "Studio", editable: false } })).toBe(
      "Set on Studio, so every device lists its tasks the same way. Only its owner can change it while connected.",
    );
  });

  it("names the older nodes that follow this device's rule, or says nothing", () => {
    expect(autoSettleRuleScopeNote({ deviceRuleNodeLabels: ["Old box"] })).toBe(
      "Old box does not keep this rule yet, so it applies on this device only.",
    );
    expect(autoSettleRuleScopeNote({ deviceRuleNodeLabels: ["Old box", "Pi"] })).toBe(
      "Old box, Pi do not keep this rule yet, so it applies on this device only.",
    );
    expect(autoSettleRuleScopeNote({ deviceRuleNodeLabels: [] })).toBeNull();
  });
});
