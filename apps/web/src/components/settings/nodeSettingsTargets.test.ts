import { DEFAULT_SERVER_SETTINGS, EnvironmentId } from "@ryco/contracts";
import {
  nodeAutoSettleRulePatch,
  nodeOwnsAutoSettleRule,
} from "@ryco/client-runtime/state/settings";
import {
  applyNodeSettingsPatch,
  describeNodeSettingsApplyResult,
  nodeSettingsBlocker,
} from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  hosted: false,
  primaryEnvironmentId: "primary" as string | null,
  configs: new Map<string, unknown>(),
  connected: new Set<string>(),
  hostedWritable: new Set<string>(),
  machines: [] as Array<{ environmentId: string; canConnect: boolean; effectiveRole: string }>,
  saved: {} as Record<string, { role: string | null }>,
  updateEnvironmentServerSettings: vi.fn(),
}));

vi.mock("../../env", () => ({ isElectron: false, isHostedHubMode: () => state.hosted }));
vi.mock("../../environments/primary", () => ({
  fetchSessionState: async () => ({ authenticated: true, role: "owner" }),
  getPrimaryKnownEnvironment: () =>
    state.primaryEnvironmentId === null ? null : { environmentId: state.primaryEnvironmentId },
  usePrimaryEnvironmentDescriptor: () => null,
}));
vi.mock("../../environments/runtime", () => ({
  readEnvironmentConnection: (environmentId: string) =>
    state.connected.has(environmentId) ? {} : null,
  subscribeEnvironmentConnections: () => () => undefined,
  updateEnvironmentServerSettings: state.updateEnvironmentServerSettings,
  useSavedEnvironmentRegistryStore: () => ({}),
  useSavedEnvironmentRuntimeStore: { getState: () => ({ byId: state.saved }) },
}));
vi.mock("../../hostedHub/capabilities", () => ({
  readHostedRpcCapability: (_method: string, environmentId: string) => ({
    allowed: state.hostedWritable.has(environmentId),
  }),
}));
vi.mock("../../hostedHub/state", () => ({
  useHostedHubStore: { getState: () => ({ nodes: [] }) },
}));
vi.mock("../../platform/desktopWorkspace", () => ({
  readDesktopWorkspaceState: () => ({ machines: state.machines }),
  useDesktopWorkspaceState: () => ({ machines: state.machines, localEnvironmentId: null }),
}));
vi.mock("../../rpc/serverState", () => ({ getServerConfig: () => null }));
vi.mock("@ryco/client-runtime/rpc", () => ({
  getWsConnectionStatusForEnvironment: (environmentId: string) => ({
    phase: state.connected.has(environmentId) ? "connected" : "disconnected",
  }),
  readEnvironmentServerConfig: (environmentId: string) => state.configs.get(environmentId) ?? null,
  subscribeEnvironmentServerConfigs: () => () => undefined,
}));

import { readNodeSettingsTarget } from "./nodeSettingsTargets";

function nodeConfig(input: { readonly keepsRule: boolean }) {
  return {
    environment: { capabilities: input.keepsRule ? { nodeAutoSettlement: true } : {} },
    settings: DEFAULT_SERVER_SETTINGS,
  };
}

/** A connected node that keeps the auto-settle rule. */
function connectNode(environmentId: string, config = nodeConfig({ keepsRule: true })) {
  state.configs.set(environmentId, config);
  state.connected.add(environmentId);
  return EnvironmentId.make(environmentId);
}

function ruleBlocker(environmentId: EnvironmentId) {
  return nodeSettingsBlocker(
    readNodeSettingsTarget({ environmentId, label: environmentId }),
    nodeOwnsAutoSettleRule,
  );
}

beforeEach(() => {
  state.hosted = false;
  state.primaryEnvironmentId = "primary";
  state.configs.clear();
  state.connected.clear();
  state.hostedWritable.clear();
  state.machines = [];
  state.saved = {};
  state.updateEnvironmentServerSettings.mockReset();
  state.updateEnvironmentServerSettings.mockResolvedValue(undefined);
});

describe("readNodeSettingsTarget", () => {
  it("lets a saved environment's owner write, and says why anyone else cannot", () => {
    const owned = connectNode("saved-owner");
    state.saved["saved-owner"] = { role: "owner" };
    const client = connectNode("saved-client");
    state.saved["saved-client"] = { role: "client" };
    const older = connectNode("saved-older", nodeConfig({ keepsRule: false }));
    state.saved["saved-older"] = { role: "owner" };
    state.saved["saved-away"] = { role: "owner" };
    const away = EnvironmentId.make("saved-away");

    expect([owned, client, older, away].map(ruleBlocker)).toEqual([
      null,
      "read-only",
      "unsupported",
      "disconnected",
    ]);
  });

  it("carries the node's own config, never another node's", () => {
    const studio = connectNode("studio");
    const laptopConfig = nodeConfig({ keepsRule: false });
    const laptop = connectNode("laptop", laptopConfig);
    expect(readNodeSettingsTarget({ environmentId: studio, label: "Studio" }).config).toBe(
      state.configs.get("studio"),
    );
    expect(readNodeSettingsTarget({ environmentId: laptop, label: "Laptop" }).config).toBe(
      laptopConfig,
    );
  });

  it("follows a Desktop workspace machine's own role", () => {
    const owned = connectNode("machine-owner");
    const viewed = connectNode("machine-viewer");
    state.machines = [
      { environmentId: "machine-owner", canConnect: true, effectiveRole: "owner" },
      { environmentId: "machine-viewer", canConnect: true, effectiveRole: "viewer" },
    ];
    expect(ruleBlocker(owned)).toBeNull();
    expect(ruleBlocker(viewed)).toBe("read-only");
  });

  it("asks each hosted node's own session whether it may change settings", () => {
    state.hosted = true;
    const writable = connectNode("hosted-writable");
    const refused = connectNode("hosted-refused");
    state.hostedWritable.add("hosted-writable");
    // A hosted role alone never opens the write: the node's own session decides.
    state.saved["hosted-refused"] = { role: "owner" };
    expect(ruleBlocker(writable)).toBeNull();
    expect(ruleBlocker(refused)).toBe("read-only");
  });
});

describe("applying a setting to every known node", () => {
  it("writes to every reachable node and names the ones it could not", async () => {
    const studio = connectNode("studio");
    state.saved.studio = { role: "owner" };
    state.saved.laptop = { role: "owner" };

    const result = await applyNodeSettingsPatch(
      [
        { environmentId: studio, label: "Studio" },
        { environmentId: EnvironmentId.make("laptop"), label: "Laptop" },
      ].map(readNodeSettingsTarget),
      nodeAutoSettleRulePatch(14),
      { supported: nodeOwnsAutoSettleRule },
    );
    expect(describeNodeSettingsApplyResult(result)).toBe(
      "Applied to Studio. Not changed: Laptop (not connected).",
    );
    expect(state.updateEnvironmentServerSettings).toHaveBeenCalledTimes(1);
    expect(state.updateEnvironmentServerSettings).toHaveBeenCalledWith(studio, {
      threadAutoSettleAfterDays: 14,
    });
  });

  it("never writes to a hosted node whose session refuses the settings write", async () => {
    state.hosted = true;
    const writable = connectNode("hosted-writable");
    const refused = connectNode("hosted-refused");
    state.hostedWritable.add("hosted-writable");

    const result = await applyNodeSettingsPatch(
      [
        { environmentId: writable, label: "Studio" },
        { environmentId: refused, label: "Laptop" },
      ].map(readNodeSettingsTarget),
      { pullRequestTemplates: false },
    );
    expect(describeNodeSettingsApplyResult(result)).toBe(
      "Applied to Studio. Not changed: Laptop (only its owner can change it).",
    );
    expect(state.updateEnvironmentServerSettings).toHaveBeenCalledTimes(1);
    expect(state.updateEnvironmentServerSettings).toHaveBeenCalledWith(writable, {
      pullRequestTemplates: false,
    });
  });
});
