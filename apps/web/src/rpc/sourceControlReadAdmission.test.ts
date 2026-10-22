import { hostedHubStore } from "@ryco/client-runtime/authorization";
import {
  configureHostedEnvironmentSessions,
  getHostedEnvironmentSessions,
  resetHostedEnvironmentSessionsForTests,
} from "@ryco/client-runtime/authorization/hostedEnvironmentSessions";
import { EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { HostedHubNode, HostedHubState } from "../hostedHub/types";

const mode = vi.hoisted(() => ({ hosted: true }));
vi.mock("~/env", () => ({ isHostedHubMode: () => mode.hosted }));

import {
  sourceControlReadAdmission,
  subscribeSourceControlReadAdmission,
} from "./sourceControlReadAdmission";

const ENV_X = EnvironmentId.make("env_xxxxxxxxxxxxxxxxxxxxxx");
const ENV_Y = EnvironmentId.make("env_yyyyyyyyyyyyyyyyyyyyyy");

const SHARED_GENERATION = 41;

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

/** A signed-in browser whose selection (Y) is connected and ready, with X listed beside it. */
function hostedState(overrides: Partial<HostedHubState> = {}): HostedHubState {
  return {
    ...hostedHubStore.getInitialState(),
    account: { id: "account-a" } as never,
    session: { id: "session-a", activeSpaceId: "space-a" } as never,
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
    generation: SHARED_GENERATION,
    ...overrides,
  };
}

function publish(overrides: Partial<HostedHubState> = {}) {
  hostedHubStore.setState(hostedState(overrides), true);
}

/** Opens a record for the environment and walks it to a ready session. */
function connect(
  environmentId: EnvironmentId,
  role: HostedHubNode["effectiveRole"] = "operator",
): number {
  const sessions = getHostedEnvironmentSessions();
  const { generation } = sessions.ensureRecord(hubNode(environmentId, { effectiveRole: role }));
  sessions.markConnectRequested(environmentId, generation);
  sessions.transportStatus(environmentId, generation, "online");
  sessions.markSessionReady(environmentId, generation);
  return generation;
}

function scopeOf(environmentId: EnvironmentId) {
  return JSON.stringify(["account-a", "session-a", "space-a", environmentId]);
}

beforeEach(() => {
  mode.hosted = true;
  configureHostedEnvironmentSessions({
    now: () => 0,
    setTimeout: () => null,
    clearTimeout: () => undefined,
  });
});

afterEach(() => {
  resetHostedEnvironmentSessionsForTests();
  hostedHubStore.setState(hostedHubStore.getInitialState(), true);
});

describe("sourceControlReadAdmission", () => {
  it("admits everything outside a hosted build", () => {
    mode.hosted = false;
    expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: "direct", scope: "direct" });
  });

  describe("the selected environment", () => {
    it("is keyed by the shared generation and role", () => {
      publish();
      expect(sourceControlReadAdmission(ENV_Y)).toEqual({
        key: JSON.stringify([scopeOf(ENV_Y), SHARED_GENERATION, "operator"]),
        scope: scopeOf(ENV_Y),
      });
    });

    it("re-keys when the shared session starts over", () => {
      publish();
      const before = sourceControlReadAdmission(ENV_Y);
      publish({ generation: SHARED_GENERATION + 1 });
      const after = sourceControlReadAdmission(ENV_Y);
      expect(after.scope).toBe(before.scope);
      expect(after.key).not.toBeNull();
      expect(after.key).not.toBe(before.key);
    });

    it("pauses while its own connection is not ready", () => {
      publish({ transportStatus: "reconnecting", sessionStatus: "stale" });
      expect(sourceControlReadAdmission(ENV_Y)).toEqual({ key: null, scope: scopeOf(ENV_Y) });
    });

    it("pauses while the Hub lists its node as offline", () => {
      publish({
        selectedNode: hubNode(ENV_Y, { presence: { online: false, lastHeartbeatAt: 1 } }),
      });
      expect(sourceControlReadAdmission(ENV_Y)).toEqual({ key: null, scope: scopeOf(ENV_Y) });
    });

    it.each(["revoked", "authorization-removed"] as const)(
      "forbids retained data once %s",
      (status) => {
        publish({ selectionStatus: status, effectiveRole: null });
        expect(sourceControlReadAdmission(ENV_Y)).toEqual({ key: null, scope: null });
      },
    );

    it("is not borrowed by another environment", () => {
      publish();
      // Y's ready connection says nothing about X: it has no session of its own yet.
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: scopeOf(ENV_X) });
    });
  });

  describe("an environment the cursor is not on", () => {
    it("is admitted once its own session is ready, keyed by that session's generation", () => {
      publish();
      const generation = connect(ENV_X);
      expect(generation).not.toBe(SHARED_GENERATION);
      expect(sourceControlReadAdmission(ENV_X)).toEqual({
        key: JSON.stringify([scopeOf(ENV_X), generation, "operator"]),
        scope: scopeOf(ENV_X),
      });
    });

    it("is admitted while the shared browser is still synchronizing the selection", () => {
      publish({ browserStatus: "synchronizing", sessionStatus: "synchronizing" });
      const generation = connect(ENV_X);
      expect(sourceControlReadAdmission(ENV_X).key).toBe(
        JSON.stringify([scopeOf(ENV_X), generation, "operator"]),
      );
    });

    it("re-keys when its session starts over", () => {
      publish();
      connect(ENV_X);
      const before = sourceControlReadAdmission(ENV_X);
      const renewed = getHostedEnvironmentSessions().renew(ENV_X);
      // The new session is only establishing, so reads pause until it is ready again.
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: before.scope });
      const sessions = getHostedEnvironmentSessions();
      sessions.markConnectRequested(ENV_X, renewed!.generation);
      sessions.transportStatus(ENV_X, renewed!.generation, "online");
      sessions.markSessionReady(ENV_X, renewed!.generation);
      const after = sourceControlReadAdmission(ENV_X);
      expect(after.key).toBe(JSON.stringify([scopeOf(ENV_X), renewed!.generation, "operator"]));
      expect(after.key).not.toBe(before.key);
    });

    it("pauses while its session is establishing", () => {
      publish();
      const sessions = getHostedEnvironmentSessions();
      const { generation } = sessions.ensureRecord(hubNode(ENV_X));
      sessions.markConnectRequested(ENV_X, generation);
      sessions.transportStatus(ENV_X, generation, "connecting");
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: scopeOf(ENV_X) });
    });

    it("pauses while the Hub lists its node as offline", () => {
      publish({
        nodes: [
          hubNode(ENV_X, { presence: { online: false, lastHeartbeatAt: 1 } }),
          hubNode(ENV_Y),
        ],
      });
      connect(ENV_X);
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: scopeOf(ENV_X) });
    });

    it("pauses while the shared account or directory is not current", () => {
      publish({ directoryStatus: "stale" });
      connect(ENV_X);
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: scopeOf(ENV_X) });
      publish({ accountStatus: "unavailable" });
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: scopeOf(ENV_X) });
    });

    it("pauses when its browser lifecycle is not revalidated", () => {
      publish({ browserStatus: "checking-access" });
      connect(ENV_X);
      expect(sourceControlReadAdmission(ENV_X).key).toBeNull();
    });

    it("forbids retained data once its node is revoked", () => {
      publish({ nodes: [hubNode(ENV_X, { revokedAt: 5 }), hubNode(ENV_Y)] });
      connect(ENV_X);
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: null });
    });

    it.each(["revoked", "authorization-removed"] as const)(
      "forbids retained data once its relay closes as %s",
      (kind) => {
        publish();
        const generation = connect(ENV_X);
        expect(sourceControlReadAdmission(ENV_X).key).not.toBeNull();
        getHostedEnvironmentSessions().failure(ENV_X, generation, { kind, retryable: false });
        expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: null });
        // The selected environment is unaffected by another one's failure.
        expect(sourceControlReadAdmission(ENV_Y).scope).toBe(scopeOf(ENV_Y));
      },
    );

    it("keeps its scope through a failure that is not a revocation", () => {
      publish();
      const generation = connect(ENV_X);
      getHostedEnvironmentSessions().failure(ENV_X, generation, {
        kind: "network",
        retryable: true,
      });
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: scopeOf(ENV_X) });
    });

    it("forbids retained data when its node is no longer listed", () => {
      publish({ nodes: [hubNode(ENV_Y)] });
      connect(ENV_X);
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: null });
    });

    it("is refused for a viewer on that node whatever the selected node's role", () => {
      publish({ effectiveRole: "operator" });
      connect(ENV_X, "viewer");
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: null });
    });

    it("is admitted for an operator on that node whatever the selected node's role", () => {
      publish({
        effectiveRole: "viewer",
        nodes: [hubNode(ENV_X), hubNode(ENV_Y, { effectiveRole: "viewer" })],
      });
      const generation = connect(ENV_X);
      expect(sourceControlReadAdmission(ENV_X).key).toBe(
        JSON.stringify([scopeOf(ENV_X), generation, "operator"]),
      );
      expect(sourceControlReadAdmission(ENV_Y)).toEqual({ key: null, scope: null });
    });

    it("forbids retained data after sign-out", () => {
      publish({ accountStatus: "signing-out" });
      connect(ENV_X);
      expect(sourceControlReadAdmission(ENV_X)).toEqual({ key: null, scope: null });
    });

    it("keeps its scope apart from another account's", () => {
      publish();
      connect(ENV_X);
      const before = sourceControlReadAdmission(ENV_X);
      publish({ account: { id: "account-b" } as never });
      const after = sourceControlReadAdmission(ENV_X);
      expect(after.scope).not.toBe(before.scope);
    });
  });
});

describe("subscribeSourceControlReadAdmission", () => {
  it("wakes for shared hosted changes and for any environment's session changes", () => {
    publish();
    const listener = vi.fn();
    const unsubscribe = subscribeSourceControlReadAdmission(listener);
    try {
      publish({ generation: SHARED_GENERATION + 1 });
      expect(listener).toHaveBeenCalledTimes(1);
      listener.mockClear();
      connect(ENV_X);
      expect(listener).toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
    listener.mockClear();
    publish({ generation: SHARED_GENERATION + 2 });
    getHostedEnvironmentSessions().renew(ENV_X);
    expect(listener).not.toHaveBeenCalled();
  });
});
