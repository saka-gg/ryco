import {
  applyAutoSettleRuleToNodes,
  describeAutoSettleRuleApplyResult,
} from "@ryco/client-runtime/state/settings";
import { DEFAULT_SERVER_SETTINGS, EnvironmentId, type ServerConfig } from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  autoSettleRuleModelNote,
  buildAutoSettleRuleModel,
  buildAutoSettleRuleTargets,
  changeAutoSettleRuleModel,
} from "./autoSettleRuleModel";

const STUDIO = EnvironmentId.make("studio");
const LAPTOP = EnvironmentId.make("laptop");
const OLD_BOX = EnvironmentId.make("old-box");

function config(input: {
  readonly nodeAutoSettlement: boolean;
  readonly threadAutoSettleAfterDays?: 3 | 30 | null;
}): ServerConfig {
  return {
    environment: {
      label: "node",
      capabilities: input.nodeAutoSettlement ? { nodeAutoSettlement: true } : {},
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...(input.threadAutoSettleAfterDays === undefined
        ? {}
        : { threadAutoSettleAfterDays: input.threadAutoSettleAfterDays }),
    },
  } as unknown as ServerConfig;
}

const labels: Record<string, string> = { studio: "Studio", laptop: "Laptop", "old-box": "Old box" };

function model(input: {
  readonly configs: ReadonlyArray<readonly [EnvironmentId, ServerConfig]>;
  readonly owner?: ReadonlyArray<EnvironmentId>;
  readonly connected?: ReadonlyArray<EnvironmentId>;
  readonly selected?: EnvironmentId | null;
}) {
  return buildAutoSettleRuleModel({
    configs: new Map(input.configs),
    labelOf: (environmentId) => labels[environmentId] ?? environmentId,
    isOwner: (environmentId) => (input.owner ?? [STUDIO, LAPTOP]).includes(environmentId),
    isConnected: (environmentId) =>
      (input.connected ?? [STUDIO, LAPTOP, OLD_BOX]).includes(environmentId),
    selectedEnvironmentId: input.selected ?? null,
    deviceValue: 14,
  });
}

describe("buildAutoSettleRuleModel", () => {
  it("edits the chosen node's own rule and writes it to that node", async () => {
    const built = model({
      configs: [
        [STUDIO, config({ nodeAutoSettlement: true, threadAutoSettleAfterDays: 30 })],
        [LAPTOP, config({ nodeAutoSettlement: true })],
      ],
      selected: STUDIO,
    });
    expect(built.nodes.map((node) => [node.label, node.value])).toEqual([
      ["Laptop", 7],
      ["Studio", 30],
    ]);
    expect(built.editing?.environmentId).toBe(STUDIO);
    expect(built.value).toBe(30);
    const writeNode = vi.fn(async () => undefined);
    const writeDevice = vi.fn();
    await expect(changeAutoSettleRuleModel(built, 3, { writeNode, writeDevice })).resolves.toBe(
      "node",
    );
    expect(writeNode).toHaveBeenCalledWith(STUDIO, { threadAutoSettleAfterDays: 3 });
    expect(writeDevice).not.toHaveBeenCalled();
    expect(autoSettleRuleModelNote(built)).toBe(
      "Set on Studio, so every device lists its tasks the same way.",
    );
  });

  it("starts on the first node by label and keeps a non-owner read-only", async () => {
    const built = model({
      configs: [
        [STUDIO, config({ nodeAutoSettlement: true, threadAutoSettleAfterDays: null })],
        [LAPTOP, config({ nodeAutoSettlement: true, threadAutoSettleAfterDays: 3 })],
      ],
      owner: [STUDIO],
    });
    expect(built.editing).toMatchObject({ label: "Laptop", value: 3, editable: false });
    const writeNode = vi.fn(async () => undefined);
    await expect(
      changeAutoSettleRuleModel(built, 30, { writeNode, writeDevice: vi.fn() }),
    ).resolves.toBeNull();
    expect(writeNode).not.toHaveBeenCalled();
    expect(autoSettleRuleModelNote(built)).toMatch(/Only its owner can change it/);
  });

  it("falls back to this device's rule, naming the older nodes that follow it", async () => {
    const built = model({
      configs: [
        [OLD_BOX, config({ nodeAutoSettlement: false })],
        // A node that is not connected now is not listed.
        [STUDIO, config({ nodeAutoSettlement: true })],
      ],
      connected: [OLD_BOX],
    });
    expect(built.nodes).toEqual([]);
    expect(built.editing).toBeNull();
    expect(built.value).toBe(14);
    expect(built.deviceRuleNodeLabels).toEqual(["Old box"]);
    expect(autoSettleRuleModelNote(built)).toBe(
      "Old box does not keep this rule yet, so it applies on this device only.",
    );
    const writeDevice = vi.fn();
    await expect(
      changeAutoSettleRuleModel(built, 3, { writeNode: vi.fn(), writeDevice }),
    ).resolves.toBe("device");
    expect(writeDevice).toHaveBeenCalledWith(3);
  });
});

describe("buildAutoSettleRuleTargets", () => {
  it("writes to every node it can and reports the unreachable, older and read-only ones", async () => {
    const write = vi.fn(async () => undefined);
    const targets = buildAutoSettleRuleTargets({
      environmentIds: [STUDIO, LAPTOP, OLD_BOX, EnvironmentId.make("away"), STUDIO],
      configs: new Map([
        [STUDIO, config({ nodeAutoSettlement: true })],
        [LAPTOP, config({ nodeAutoSettlement: true })],
        [OLD_BOX, config({ nodeAutoSettlement: false })],
      ]),
      labelOf: (environmentId) => labels[environmentId] ?? "Away",
      isOwner: (environmentId) => environmentId !== LAPTOP,
      isConnected: (environmentId) => environmentId !== EnvironmentId.make("away"),
      write,
    });
    const result = await applyAutoSettleRuleToNodes(30, targets);

    expect(write).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(STUDIO, { threadAutoSettleAfterDays: 30 });
    expect(describeAutoSettleRuleApplyResult(result)).toBe(
      "Applied to Studio. Not changed: Laptop (only its owner can change it), Old box (needs an update), Away (not connected).",
    );
  });
});
