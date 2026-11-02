import { EnvironmentId, ProjectId } from "@ryco/contracts";
import {
  type CarriedForkTargetCandidate,
  listCarriedForkTargets,
} from "@ryco/client-runtime/state/threads/carriedFork";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  hosted: false,
  phases: new Map<string, string>(),
  hostedAllowed: new Set<string>(),
  saved: {} as Record<string, { role: string | null }>,
}));

vi.mock("../../env", () => ({ isElectron: false, isHostedHubMode: () => state.hosted }));
vi.mock("../../environments/primary", () => ({
  fetchSessionState: () => new Promise(() => undefined),
  getPrimaryKnownEnvironment: () => ({ environmentId: "primary" }),
}));
vi.mock("../../environments/runtime", () => ({
  useSavedEnvironmentRuntimeStore: {
    getState: () => ({ byId: state.saved }),
    subscribe: () => () => undefined,
  },
}));
vi.mock("../../hostedHub/capabilities", () => ({
  readHostedRpcCapability: (_method: string, environmentId: string) => ({
    allowed: state.hostedAllowed.has(environmentId),
  }),
  subscribeHostedRpcCapabilities: () => () => undefined,
}));
vi.mock("../../hostedHub/state", () => ({
  useHostedHubStore: { getState: () => ({ nodes: [] }), subscribe: () => () => undefined },
}));
vi.mock("../../platform/desktopWorkspace", () => ({
  readDesktopWorkspaceState: () => ({ machines: [] }),
  subscribeDesktopWorkspaceState: () => () => undefined,
}));
vi.mock("@ryco/client-runtime/rpc", () => ({
  appAtomRegistry: { subscribe: () => () => undefined },
  getWsConnectionStatusForEnvironment: (environmentId: string) => ({
    phase: state.phases.get(environmentId) ?? "idle",
  }),
  wsConnectionStatusForEnvironmentAtom: (environmentId: string) => environmentId,
}));

import {
  readCarriedForkTargetAccess,
  readCarriedForkTargetsAccess,
} from "./carriedForkTargetAccess";

const SOURCE = EnvironmentId.make("source");

function candidate(environmentId: EnvironmentId): CarriedForkTargetCandidate {
  return {
    environmentId,
    label: environmentId,
    access: readCarriedForkTargetAccess(environmentId),
    supported: true,
    chatsAvailable: true,
    providers: [{ instanceId: "codex", driver: "codex", enabled: true }],
    projects: [],
  };
}

const listed = (environmentIds: ReadonlyArray<EnvironmentId>) =>
  listCarriedForkTargets({
    sourceEnvironmentId: SOURCE,
    source: { isChat: true },
    driver: "codex",
    candidates: environmentIds.map(candidate),
  }).map((target) => target.environmentId);

beforeEach(() => {
  state.hosted = false;
  state.phases.clear();
  state.hostedAllowed.clear();
  state.saved = {};
});

describe("carried fork target access", () => {
  it("leaves out a saved machine this device is not the owner of, or not connected to", () => {
    const owner = EnvironmentId.make("owner-connected");
    const client = EnvironmentId.make("client-connected");
    const offline = EnvironmentId.make("owner-offline");
    state.saved = {
      [owner]: { role: "owner" },
      [client]: { role: "client" },
      [offline]: { role: "owner" },
    };
    state.phases.set(owner, "connected");
    state.phases.set(client, "connected");
    state.phases.set(offline, "disconnected");
    expect(readCarriedForkTargetAccess(client)).toEqual({
      hosted: false,
      role: "viewer",
      phase: "connected",
    });
    expect(listed([owner, client, offline])).toEqual([owner]);
  });

  it("follows the shared hosted capability policy on a hosted connection", () => {
    state.hosted = true;
    const ready = EnvironmentId.make("hosted-ready");
    const establishing = EnvironmentId.make("hosted-establishing");
    state.hostedAllowed.add(ready);
    expect(listed([ready, establishing])).toEqual([ready]);
  });

  it("keeps one answer while nothing changed", () => {
    const owner = EnvironmentId.make("owner-connected");
    state.saved = { [owner]: { role: "owner" } };
    state.phases.set(owner, "connected");
    const first = readCarriedForkTargetsAccess([owner]);
    expect(readCarriedForkTargetsAccess([owner])).toBe(first);
    state.phases.set(owner, "connecting");
    expect(readCarriedForkTargetsAccess([owner])).not.toBe(first);
  });
});
