import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@ryco/contracts";
import { autoSettleRuleHandOverPatch } from "@ryco/client-runtime/state/settings";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  hosted: false,
  primaryEnvironmentId: "primary" as string | null,
  configs: new Map<string, unknown>(),
  hostedNodes: [] as Array<{ environmentId: string; effectiveRole: string }>,
  hostedWritable: new Set<string>(),
  machines: [] as Array<{ environmentId: string; canConnect: boolean; effectiveRole: string }>,
  saved: {} as Record<string, { role: string | null }>,
  sessionRole: "owner" as string | null,
  fetchSessionState: vi.fn(),
  updateEnvironmentServerSettings: vi.fn(),
  updateClientAutoSettleAfterDays: vi.fn(),
}));

vi.mock("./env", () => ({ isElectron: false, isHostedHubMode: () => state.hosted }));
vi.mock("./environments/primary", () => ({
  fetchSessionState: state.fetchSessionState,
  getPrimaryKnownEnvironment: () =>
    state.primaryEnvironmentId === null ? null : { environmentId: state.primaryEnvironmentId },
}));
vi.mock("./environments/runtime", () => ({
  updateEnvironmentServerSettings: state.updateEnvironmentServerSettings,
  useSavedEnvironmentRuntimeStore: { getState: () => ({ byId: state.saved }) },
}));
vi.mock("./hooks/useSettings", () => ({
  updateClientAutoSettleAfterDays: state.updateClientAutoSettleAfterDays,
}));
vi.mock("./hostedHub/capabilities", () => ({
  readHostedRpcCapability: (_method: string, environmentId: string) => ({
    allowed: state.hostedWritable.has(environmentId),
  }),
}));
vi.mock("./hostedHub/state", () => ({
  useHostedHubStore: { getState: () => ({ nodes: state.hostedNodes }) },
}));
vi.mock("./platform/desktopWorkspace", () => ({
  readDesktopWorkspaceState: () => ({ machines: state.machines }),
}));
vi.mock("./rpc/serverState", () => ({ getServerConfig: () => null }));
vi.mock("@ryco/client-runtime/rpc", () => ({
  readEnvironmentServerConfig: (environmentId: string) => state.configs.get(environmentId) ?? null,
  subscribeEnvironmentServerConfigs: () => () => undefined,
}));

import { handOverAutoSettleRule, setAutoSettleRule } from "./nodeAutoSettlement";

function nodeConfig(input: { readonly keepsRule: boolean; readonly rule?: 3 | 30 | null }) {
  return {
    environment: { capabilities: input.keepsRule ? { nodeAutoSettlement: true } : {} },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      ...(input.rule === undefined ? {} : { threadAutoSettleAfterDays: input.rule }),
    },
  };
}

/** A node that keeps the rule but has none set yet. */
function connectNode(environmentId: string, config = nodeConfig({ keepsRule: true })) {
  state.configs.set(environmentId, config);
  return EnvironmentId.make(environmentId);
}

beforeEach(() => {
  state.hosted = false;
  state.primaryEnvironmentId = "primary";
  state.configs.clear();
  state.hostedNodes = [];
  state.hostedWritable.clear();
  state.machines = [];
  state.saved = {};
  state.fetchSessionState.mockReset();
  state.fetchSessionState.mockImplementation(async () => ({
    authenticated: true,
    role: state.sessionRole,
  }));
  state.updateEnvironmentServerSettings.mockReset();
  state.updateEnvironmentServerSettings.mockResolvedValue(undefined);
  state.updateClientAutoSettleAfterDays.mockReset();
});

describe("setAutoSettleRule", () => {
  const studio = {
    environmentId: EnvironmentId.make("studio"),
    label: "Studio",
    ownsRule: true,
    value: 7,
    editable: true,
  } as const;

  it("writes the rule to the node that keeps it", async () => {
    await expect(setAutoSettleRule(studio, 30)).resolves.toBe("node");
    expect(state.updateEnvironmentServerSettings).toHaveBeenCalledWith(studio.environmentId, {
      threadAutoSettleAfterDays: 30,
    });
    expect(state.updateClientAutoSettleAfterDays).not.toHaveBeenCalled();
  });

  it("keeps this device's own rule for a node that keeps none", async () => {
    await expect(setAutoSettleRule({ ...studio, ownsRule: false }, 3)).resolves.toBe("device");
    expect(state.updateClientAutoSettleAfterDays).toHaveBeenCalledWith(3);
    expect(state.updateEnvironmentServerSettings).not.toHaveBeenCalled();
  });
});

describe("handOverAutoSettleRule", () => {
  it("hands this client's rule to a Desktop workspace machine it owns", () => {
    const machine = connectNode("handover-machine");
    state.machines = [
      { environmentId: "handover-machine", canConnect: true, effectiveRole: "owner" },
    ];
    expect(handOverAutoSettleRule([{ environmentId: machine, mutationReady: true }], 30)).toEqual([
      machine,
    ]);
    expect(state.updateEnvironmentServerSettings).toHaveBeenCalledWith(
      machine,
      autoSettleRuleHandOverPatch(30),
    );
  });

  it("asks this page's own role on the primary first, and leaves a client session alone", async () => {
    state.primaryEnvironmentId = "handover-primary-client";
    state.sessionRole = "client";
    const primary = connectNode("handover-primary-client");
    const listed = [{ environmentId: primary, mutationReady: true }];

    expect(handOverAutoSettleRule(listed, 30)).toEqual([]);
    await vi.waitFor(() => expect(state.fetchSessionState).toHaveBeenCalledTimes(1));
    await Promise.resolve();
    expect(handOverAutoSettleRule(listed, 30)).toEqual([]);
    expect(state.fetchSessionState).toHaveBeenCalledTimes(1);
    expect(state.updateEnvironmentServerSettings).not.toHaveBeenCalled();
  });

  it("hands the rule to the primary once its owner session is known", async () => {
    state.primaryEnvironmentId = "handover-primary-owner";
    state.sessionRole = "owner";
    const primary = connectNode("handover-primary-owner");
    const listed = [{ environmentId: primary, mutationReady: true }];

    expect(handOverAutoSettleRule(listed, 30)).toEqual([]);
    await vi.waitFor(() => expect(handOverAutoSettleRule(listed, 30)).toEqual([primary]));
  });

  it("does not repeat a refused write while the node stays ready", async () => {
    const node = connectNode("handover-refused");
    state.saved["handover-refused"] = { role: "owner" };
    state.updateEnvironmentServerSettings.mockRejectedValue(new Error("Not allowed."));
    const listed = [{ environmentId: node, mutationReady: true }];

    expect(handOverAutoSettleRule(listed, 30)).toEqual([node]);
    for (let run = 0; run < 5; run += 1) {
      await Promise.resolve();
      expect(handOverAutoSettleRule(listed, 30)).toEqual([]);
    }
    expect(state.updateEnvironmentServerSettings).toHaveBeenCalledTimes(1);
  });

  it("never writes to a node that already has a rule", () => {
    const node = connectNode("handover-set", nodeConfig({ keepsRule: true, rule: null }));
    state.saved["handover-set"] = { role: "owner" };
    expect(handOverAutoSettleRule([{ environmentId: node, mutationReady: true }], 30)).toEqual([]);
    expect(state.updateEnvironmentServerSettings).not.toHaveBeenCalled();
  });
});
