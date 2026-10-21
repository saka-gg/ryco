import { buildUpdateEverythingPlan } from "@ryco/client-runtime/updates";
import { EnvironmentId, ProviderInstanceId } from "@ryco/contracts";
import { describe, expect, it } from "vitest";

import type { EnvironmentTurnActivity } from "../desktopRelaunchGuard.logic";
import {
  desktopUpdateState,
  nodeServerConfig,
  nodeUpdateState,
  updatableProvider,
} from "./testing/updateFixtures";
import {
  assembleUpdateEverythingInputs,
  sameUpdateEverythingPlan,
  selectUpdateEverythingEnvironments,
  selectUpdateEverythingLocalApp,
  UNNAMED_NODE_LABEL,
  type UpdateEverythingEnvironmentSource,
} from "./updateEverythingInputs";

const LOCAL = EnvironmentId.make("env-local");
const REMOTE = EnvironmentId.make("env-remote");
const CODEX = ProviderInstanceId.make("codex");

function source(
  environmentId: EnvironmentId,
  overrides: Partial<UpdateEverythingEnvironmentSource> = {},
): UpdateEverythingEnvironmentSource {
  return {
    environmentId,
    descriptorLabel: null,
    connectionLabel: null,
    config: nodeServerConfig({ environmentId, label: `Config ${environmentId}` }),
    live: true,
    canMutate: true,
    nodeUpdate: null,
    ...overrides,
  };
}

const busy: ReadonlyMap<EnvironmentId, EnvironmentTurnActivity> = new Map([
  [LOCAL, { runningChatCount: 2, busyProviderInstanceIds: [CODEX] }],
  [REMOTE, { runningChatCount: 1, busyProviderInstanceIds: [CODEX] }],
]);

describe("assembleUpdateEverythingInputs", () => {
  it("maps each connection's config, permissions, update state and running chats", () => {
    const codex = updatableProvider("codex");
    const state = nodeUpdateState();
    const [input] = assembleUpdateEverythingInputs({
      environments: [
        source(REMOTE, {
          descriptorLabel: "Build box",
          config: nodeServerConfig({
            environmentId: REMOTE,
            serverVersion: "0.1.30",
            nodeSelfUpdate: true,
            providers: [codex],
            continueThreadsAfterRestart: true,
          }),
          canMutate: false,
          nodeUpdate: state,
        }),
      ],
      activity: busy,
      primaryEnvironmentId: LOCAL,
      isElectron: true,
    });
    expect(input).toEqual({
      environmentId: REMOTE,
      label: "Build box",
      connected: true,
      canMutate: false,
      hostedByThisApp: false,
      serverVersion: "0.1.30",
      supportsNodeUpdate: true,
      nodeUpdate: state,
      providers: [codex],
      busyProviderInstanceIds: [CODEX],
      runningChatCount: 1,
      continueThreadsAfterRestart: true,
    });
  });

  it("labels a node by its descriptor, then its config, then its connection", () => {
    const labels = assembleUpdateEverythingInputs({
      environments: [
        source(EnvironmentId.make("a"), { descriptorLabel: " Laptop ", connectionLabel: "x" }),
        source(EnvironmentId.make("b"), { connectionLabel: "Connection" }),
        source(EnvironmentId.make("c"), {
          config: nodeServerConfig({ environmentId: "c", label: " " }),
          connectionLabel: "Connection",
        }),
        source(EnvironmentId.make("d"), {
          config: nodeServerConfig({ environmentId: "d", label: "" }),
        }),
      ],
      activity: new Map(),
      primaryEnvironmentId: null,
      isElectron: false,
    }).map((input) => input.label);
    expect(labels).toEqual(["Laptop", "Config b", "Connection", UNNAMED_NODE_LABEL]);
  });

  it("keeps one entry per environment and skips nodes that have reported no config", () => {
    const inputs = assembleUpdateEverythingInputs({
      environments: [
        source(REMOTE, { descriptorLabel: "First" }),
        source(REMOTE, { descriptorLabel: "Second" }),
        source(LOCAL, { config: null }),
      ],
      activity: busy,
      primaryEnvironmentId: LOCAL,
      isElectron: false,
    });
    expect(inputs.map((input) => input.label)).toEqual(["First"]);
  });

  it("marks only the primary environment as this app's own, and only inside the desktop app", () => {
    const read = (isElectron: boolean) =>
      assembleUpdateEverythingInputs({
        environments: [source(LOCAL), source(REMOTE)],
        activity: busy,
        primaryEnvironmentId: LOCAL,
        isElectron,
      }).map((input) => input.hostedByThisApp);
    expect(read(true)).toEqual([true, false]);
    expect(read(false)).toEqual([false, false]);
  });

  it("treats a node whose rows are not live as offline with nothing counted", () => {
    const [input] = assembleUpdateEverythingInputs({
      environments: [source(LOCAL, { live: false })],
      activity: busy,
      primaryEnvironmentId: LOCAL,
      isElectron: true,
    });
    expect(input).toMatchObject({
      connected: false,
      runningChatCount: 0,
      busyProviderInstanceIds: [],
    });
  });

  it("reads a node without the capability or the setting as unsupported and not continuing", () => {
    const [input] = assembleUpdateEverythingInputs({
      environments: [source(REMOTE)],
      activity: new Map(),
      primaryEnvironmentId: null,
      isElectron: false,
    });
    expect(input).toMatchObject({
      supportsNodeUpdate: false,
      continueThreadsAfterRestart: false,
      runningChatCount: 0,
      busyProviderInstanceIds: [],
    });
  });
});

describe("selectUpdateEverythingLocalApp", () => {
  it("is this desktop app's updater, and null in a browser or before it reported", () => {
    const state = desktopUpdateState({ status: "downloaded", downloadedVersion: "0.1.36" });
    expect(selectUpdateEverythingLocalApp(state, true)).toEqual({
      enabled: true,
      status: "downloaded",
      currentVersion: "0.1.35",
      availableVersion: "0.1.36",
      downloadedVersion: "0.1.36",
      downloadPercent: null,
    });
    expect(selectUpdateEverythingLocalApp(state, false)).toBeNull();
    expect(selectUpdateEverythingLocalApp(null, true)).toBeNull();
  });
});

describe("selectUpdateEverythingEnvironments", () => {
  it("keeps only the listed environments, or all without a list", () => {
    const inputs = assembleUpdateEverythingInputs({
      environments: [source(LOCAL), source(REMOTE)],
      activity: new Map(),
      primaryEnvironmentId: null,
      isElectron: false,
    });
    expect(selectUpdateEverythingEnvironments(inputs, undefined)).toBe(inputs);
    expect(
      selectUpdateEverythingEnvironments(inputs, [REMOTE]).map((input) => input.environmentId),
    ).toEqual([REMOTE]);
    expect(selectUpdateEverythingEnvironments(inputs, [])).toEqual([]);
  });
});

describe("sameUpdateEverythingPlan", () => {
  it("compares what the plan says, not its identity", () => {
    const environments = assembleUpdateEverythingInputs({
      environments: [
        source(REMOTE, {
          config: nodeServerConfig({ environmentId: REMOTE, nodeSelfUpdate: true }),
          nodeUpdate: nodeUpdateState(),
        }),
      ],
      activity: new Map(),
      primaryEnvironmentId: null,
      isElectron: false,
    });
    const plan = buildUpdateEverythingPlan({ environments, localApp: null });
    expect(
      sameUpdateEverythingPlan(plan, buildUpdateEverythingPlan({ environments, localApp: null })),
    ).toBe(true);
    expect(
      sameUpdateEverythingPlan(
        plan,
        buildUpdateEverythingPlan({ environments: [], localApp: null }),
      ),
    ).toBe(false);
  });
});
