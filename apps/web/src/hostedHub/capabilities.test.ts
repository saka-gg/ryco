import { selectHostedSharedCapabilityState } from "@ryco/client-runtime/authorization/capabilities";
import {
  configureHostedEnvironmentSessions,
  getHostedEnvironmentSessions,
  resetHostedEnvironmentSessionsForTests,
} from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import { EnvironmentId, ORCHESTRATION_WS_METHODS, WS_METHODS } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { shallow } from "zustand/vanilla/shallow";

import {
  readHostedRpcCapability,
  readHostedSessionGeneration,
  useHostedRpcCapability,
} from "./capabilities";
import { hostedHubStore } from "./state";
import type { HostedHubNode, HostedHubState } from "./types";

const ENV_X = EnvironmentId.make("env_xxxxxxxxxxxxxxxxxxxxxx");
const ENV_Y = EnvironmentId.make("env_yyyyyyyyyyyyyyyyyyyyyy");
const ENV_Z = EnvironmentId.make("env_zzzzzzzzzzzzzzzzzzzzzz");

const STALE_REASON = "This action is unavailable while Hub authorization or the relay is stale.";
const SELECTED_NODE_ROLE_REASON = "This action is unavailable for your role on the selected node.";
const NODE_ROLE_REASON = "This action is unavailable for your role on this node.";

const dispatch = ORCHESTRATION_WS_METHODS.dispatchCommand;

function hubNode(
  environmentId: EnvironmentId,
  overrides: Partial<HostedHubNode> = {},
): HostedHubNode {
  const suffix = environmentId.slice(4);
  return {
    id: `node_${suffix}`,
    environmentId,
    label: `Node ${suffix.slice(0, 1)}`,
    platformOs: "linux",
    platformArch: "x64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 1,
    lastAuthenticatedAt: 1,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: `grant_${suffix}`, role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 1 },
    ...overrides,
  };
}

/** The hosted state of a browser whose selection (Y) is connected and ready. */
function hostedState(overrides: Partial<HostedHubState> = {}): HostedHubState {
  return {
    ...hostedHubStore.getInitialState(),
    accountStatus: "authenticated",
    directoryStatus: "ready",
    nodes: [hubNode(ENV_X), hubNode(ENV_Y)],
    selectedNode: hubNode(ENV_Y),
    selectionStatus: "online",
    effectiveRole: "operator",
    transportStatus: "online",
    sessionStatus: "ready",
    sessionEstablished: true,
    browserStatus: "current",
    generation: 7,
    ...overrides,
  };
}

function connect(environmentId: EnvironmentId, role: HostedHubNode["effectiveRole"] = "operator") {
  const sessions = getHostedEnvironmentSessions();
  const { generation } = sessions.ensureRecord(hubNode(environmentId, { effectiveRole: role }));
  sessions.markConnectRequested(environmentId, generation);
  sessions.transportStatus(environmentId, generation, "online");
  sessions.markSessionReady(environmentId, generation);
  return generation;
}

beforeEach(() => {
  vi.stubEnv("VITE_RYCO_CLIENT_MODE", "hosted-hub");
  configureHostedEnvironmentSessions({
    now: () => 0,
    setTimeout: () => null,
    clearTimeout: () => undefined,
  });
});

afterEach(() => {
  resetHostedEnvironmentSessionsForTests();
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
  vi.unstubAllEnvs();
});

describe("readHostedRpcCapability", () => {
  it("allows everything outside a hosted build", () => {
    vi.stubEnv("VITE_RYCO_CLIENT_MODE", "standard");
    expect(
      readHostedRpcCapability(dispatch, null, hostedState({ directoryStatus: "idle" })),
    ).toEqual({
      hosted: false,
      allowed: true,
      reason: null,
      kind: "ready",
    });
  });

  it("answers the selected environment for the routed null", () => {
    const state = hostedState();
    expect(readHostedRpcCapability(dispatch, null, state)).toMatchObject({
      allowed: true,
      kind: "ready",
    });
    const viewer = hostedState({ effectiveRole: "viewer" });
    expect(readHostedRpcCapability(dispatch, null, viewer)).toEqual({
      hosted: true,
      allowed: false,
      reason: SELECTED_NODE_ROLE_REASON,
      kind: "role",
    });
  });

  it("keeps the reasons existing callers see", () => {
    expect(
      readHostedRpcCapability(dispatch, null, hostedState({ directoryStatus: "stale" })),
    ).toMatchObject({ allowed: false, reason: STALE_REASON });
    expect(
      readHostedRpcCapability(dispatch, null, hostedState({ browserStatus: "offline" })),
    ).toMatchObject({ allowed: false, reason: STALE_REASON, kind: "stale" });
  });

  it("is establishing while a fresh selection connects without an error", () => {
    const connecting = hostedState({
      transportStatus: "connecting",
      sessionStatus: "synchronizing",
      sessionEstablished: false,
      browserStatus: "synchronizing",
    });
    expect(readHostedRpcCapability(dispatch, null, connecting)).toMatchObject({
      allowed: false,
      reason: STALE_REASON,
      kind: "establishing",
    });
    expect(
      readHostedRpcCapability(
        dispatch,
        null,
        hostedState({ ...connecting, errorMessage: "The relay closed the connection." }),
      ),
    ).toMatchObject({ allowed: false, kind: "stale" });
  });

  it("answers another environment from its own session", () => {
    const sessions = getHostedEnvironmentSessions();
    connect(ENV_X, "viewer");
    const state = hostedState({ transportStatus: "connecting", sessionStatus: "synchronizing" });
    // The selection (Y) is still connecting, X's own session is ready: only
    // its role limits it.
    expect(readHostedRpcCapability(dispatch, ENV_X, state, sessions.getSnapshot())).toEqual({
      hosted: true,
      allowed: false,
      reason: NODE_ROLE_REASON,
      kind: "role",
    });
    expect(
      readHostedRpcCapability(WS_METHODS.projectsList, ENV_X, state, sessions.getSnapshot()),
    ).toMatchObject({ allowed: true, kind: "ready" });
    expect(readHostedRpcCapability(dispatch, null, state)).toMatchObject({
      allowed: false,
      kind: "establishing",
    });
  });

  it("reads the registry's current snapshot unless one is given", () => {
    expect(readHostedRpcCapability(dispatch, ENV_X, hostedState())).toMatchObject({
      allowed: false,
      kind: "establishing",
    });
    connect(ENV_X);
    expect(readHostedRpcCapability(dispatch, ENV_X, hostedState())).toMatchObject({
      allowed: true,
      kind: "ready",
    });
  });

  it("is never allowed on an environment without a connection", () => {
    const unlisted = readHostedRpcCapability(dispatch, ENV_Z, hostedState());
    expect(unlisted).toEqual({
      hosted: true,
      allowed: false,
      reason: STALE_REASON,
      kind: "stale",
    });
    const offline = hostedState({
      nodes: [hubNode(ENV_X, { presence: { online: false, lastHeartbeatAt: 1 } }), hubNode(ENV_Y)],
    });
    expect(readHostedRpcCapability(dispatch, ENV_X, offline)).toMatchObject({
      allowed: false,
      kind: "stale",
    });
  });

  it("returns the identical object for identical inputs", () => {
    const state = hostedState();
    expect(readHostedRpcCapability(dispatch, null, state)).toBe(
      readHostedRpcCapability(dispatch, null, hostedState()),
    );
    expect(readHostedRpcCapability(dispatch, ENV_X, state)).toBe(
      readHostedRpcCapability(dispatch, ENV_X, hostedState({ generation: 9 })),
    );
  });
});

describe("the environment argument", () => {
  it("is required by both readers", () => {
    // Never called: each `@ts-expect-error` fails the typecheck if the call
    // above it compiles, so naming no environment cannot silently mean the
    // routed node.
    const neverCalled = () => {
      // @ts-expect-error the environment must be named; `null` is the routed node
      useHostedRpcCapability(dispatch);
      // @ts-expect-error the environment must be named; `null` is the routed node
      readHostedRpcCapability(dispatch);
    };
    expect(neverCalled).toBeTypeOf("function");
  });
});

describe("the hook's narrow subscription", () => {
  const select = (state: HostedHubState, environmentId?: EnvironmentId) =>
    selectHostedSharedCapabilityState(state, environmentId);

  it("stays shallow-equal across hosted changes the capability does not read", () => {
    const before = hostedState();
    const unrelated = [
      { nodes: [hubNode(ENV_X, { updatedAt: 2 }), hubNode(ENV_Y, { updatedAt: 2 })] },
      { selectedNode: hubNode(ENV_Y, { updatedAt: 2, lastAuthenticatedAt: 5 }) },
      { recoveryCodes: ["code"] },
      { generation: 8 },
      { bootstrapAvailable: true },
      { sessionEstablished: false },
    ] satisfies ReadonlyArray<Partial<HostedHubState>>;
    for (const patch of unrelated) {
      const after = { ...before, ...patch };
      expect(shallow(select(before), select(after))).toBe(true);
      expect(shallow(select(before, ENV_X), select(after, ENV_X))).toBe(true);
    }
  });

  it("changes when a field the capability reads changes", () => {
    const before = hostedState();
    const relevant = [
      { effectiveRole: "viewer" },
      { directoryStatus: "stale" },
      { transportStatus: "reconnecting" },
      { browserStatus: "synchronizing" },
      { sessionStatus: "synchronizing" },
      { sessionRecoveredAfterUnknown: true },
      { selectionStatus: "offline" },
      { accountStatus: "session-expired" },
      { errorMessage: "failed" },
      { selectedNode: hubNode(ENV_X) },
    ] satisfies ReadonlyArray<Partial<HostedHubState>>;
    for (const patch of relevant) {
      expect(shallow(select(before), select({ ...before, ...patch }))).toBe(false);
    }
    const offline = {
      ...before,
      nodes: [hubNode(ENV_X, { presence: { online: false, lastHeartbeatAt: 1 } })],
    };
    expect(shallow(select(before, ENV_X), select(offline, ENV_X))).toBe(false);
  });
});

describe("readHostedSessionGeneration", () => {
  it("is the environment's own record generation when it has one", () => {
    hostedHubStore.setState(hostedState({ generation: 7 }), true);
    const generation = connect(ENV_X);
    expect(generation).not.toBe(7);
    expect(readHostedSessionGeneration(ENV_X)).toBe(generation);
  });

  it("does not move when the cursor moves to another environment", () => {
    const generationX = connect(ENV_X);
    hostedHubStore.setState(hostedState({ selectedNode: hubNode(ENV_Y), generation: 7 }), true);
    expect(readHostedSessionGeneration(ENV_X)).toBe(generationX);
    hostedHubStore.setState({ selectedNode: hubNode(ENV_Z), generation: 8 });
    expect(readHostedSessionGeneration(ENV_X)).toBe(generationX);
  });

  it("moves when the environment's own session is renewed", () => {
    const generationX = connect(ENV_X);
    const renewed = getHostedEnvironmentSessions().renew(ENV_X)!;
    expect(renewed.generation).not.toBe(generationX);
    expect(readHostedSessionGeneration(ENV_X)).toBe(renewed.generation);
  });

  it("is the shared generation for the selected environment without a record", () => {
    hostedHubStore.setState(hostedState({ selectedNode: hubNode(ENV_Y), generation: 7 }), true);
    expect(readHostedSessionGeneration(ENV_Y)).toBe(7);
    hostedHubStore.setState({ generation: 9 });
    expect(readHostedSessionGeneration(ENV_Y)).toBe(9);
  });

  it("is unknown for an environment that is neither recorded nor selected", () => {
    hostedHubStore.setState(hostedState({ selectedNode: hubNode(ENV_Y) }), true);
    expect(readHostedSessionGeneration(ENV_Z)).toBeNull();
    hostedHubStore.setState({ selectedNode: null });
    expect(readHostedSessionGeneration(ENV_Y)).toBeNull();
  });
});
