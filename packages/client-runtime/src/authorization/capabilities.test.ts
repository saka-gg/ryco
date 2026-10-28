import { EnvironmentId, ORCHESTRATION_WS_METHODS, WS_METHODS } from "@ryco/contracts";
import { RPC_ACCESS_POLICY, rpcDeliveryEffectFor } from "@ryco/shared/rpcAccessPolicy";
import { describe, expect, it } from "vite-plus/test";

import {
  hostedAdmitsReadBeforeSnapshot,
  hostedSessionAdmits,
  isHostedConnectionEstablishing,
  resolveHostedEnvironmentRpcCapability,
  resolveHostedRpcCapability,
  selectHostedSharedCapabilityState,
  type HostedConnectionPhase,
  type HostedSharedCapabilityState,
} from "./capabilities.ts";
import { resolveHostedDeliveryNotice } from "./deliveryNotice.ts";
import {
  createHostedEnvironmentSessions,
  type HostedEnvironmentSessions,
} from "./hostedEnvironmentSessions.ts";
import {
  HOSTED_BROWSER_STATUSES,
  HOSTED_RELAY_TRANSPORT_STATUSES,
  HOSTED_RYCO_SESSION_STATUSES,
} from "./connectionStatus.ts";
import type {
  HostedBrowserStatus,
  HostedHubNode,
  HostedRelayTransportStatus,
  HostedRycoSessionStatus,
} from "./types.ts";

describe("hosted UI capabilities", () => {
  it("keeps standard direct and desktop behavior unchanged", () => {
    expect(
      resolveHostedRpcCapability({
        hosted: false,
        role: null,
        fresh: false,
        method: WS_METHODS.serverGetStatistics,
      }).allowed,
    ).toBe(true);
  });

  it("fails closed while role state is absent or stale", () => {
    expect(
      resolveHostedRpcCapability({
        hosted: true,
        role: "owner",
        fresh: false,
        method: WS_METHODS.projectsList,
      }),
    ).toMatchObject({ allowed: false, reason: expect.any(String) });
  });

  it("fails closed while the browser resume or Ryco session is stale", () => {
    expect(
      resolveHostedRpcCapability({
        hosted: true,
        role: "operator",
        fresh: true,
        browserCurrent: false,
        sessionReady: true,
        method: ORCHESTRATION_WS_METHODS.dispatchCommand,
      }).allowed,
    ).toBe(false);
    expect(
      resolveHostedRpcCapability({
        hosted: true,
        role: "operator",
        fresh: true,
        browserCurrent: true,
        sessionReady: false,
        method: ORCHESTRATION_WS_METHODS.dispatchCommand,
      }).allowed,
    ).toBe(false);
  });

  it("adapts viewer, operator, and owner actions from the server policy", () => {
    const allowed = (role: "viewer" | "operator" | "owner", method: string) =>
      resolveHostedRpcCapability({ hosted: true, role, fresh: true, method }).allowed;
    expect(allowed("viewer", WS_METHODS.projectsList)).toBe(true);
    expect(allowed("viewer", ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe(false);
    expect(allowed("operator", ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe(true);
    expect(allowed("operator", WS_METHODS.subscribeTerminalEvents)).toBe(true);
    expect(allowed("operator", WS_METHODS.serverGetStatistics)).toBe(false);
    expect(allowed("owner", WS_METHODS.serverGetStatistics)).toBe(true);
    expect(allowed("owner", WS_METHODS.subscribeAuthAccess)).toBe(false);
  });
});

describe("hosted session admission", () => {
  it("admits everything in a ready session", () => {
    const ready = { sessionStatus: "ready", sessionRecoveredAfterUnknown: false } as const;
    expect(hostedSessionAdmits(ready, WS_METHODS.terminalWrite)).toBe(true);
    expect(hostedSessionAdmits(ready, WS_METHODS.projectsReadFile)).toBe(true);
  });

  it("admits only reads after recovering with unconfirmed delivery", () => {
    const recovered = {
      sessionStatus: "delivery-unknown",
      sessionRecoveredAfterUnknown: true,
    } as const;
    expect(hostedSessionAdmits(recovered, WS_METHODS.projectsReadFile)).toBe(true);
    expect(hostedSessionAdmits(recovered, WS_METHODS.vcsReadLocalChanges)).toBe(true);
    expect(hostedSessionAdmits(recovered, ORCHESTRATION_WS_METHODS.getThreadWindow)).toBe(true);
    expect(hostedSessionAdmits(recovered, WS_METHODS.terminalWrite)).toBe(false);
    expect(hostedSessionAdmits(recovered, ORCHESTRATION_WS_METHODS.dispatchCommand)).toBe(false);
    expect(
      hostedSessionAdmits(
        { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false },
        WS_METHODS.projectsReadFile,
      ),
    ).toBe(false);
    expect(
      hostedSessionAdmits(
        { sessionStatus: "stale", sessionRecoveredAfterUnknown: false },
        WS_METHODS.projectsReadFile,
      ),
    ).toBe(false);
  });
});

/** Methods the delivery-effect policy calls reads, though they change or reach out. */
const READS_THAT_REACH_OUT = [
  WS_METHODS.authIssueLinkedDirectAccess,
  WS_METHODS.providerPrewarmSession,
  WS_METHODS.textGenerationGenerateBranchName,
  WS_METHODS.textGenerationGenerateIssueContent,
  WS_METHODS.vcsPrefetchWorktreeBase,
  WS_METHODS.vcsRefreshStatus,
  WS_METHODS.vcsListRefs,
  WS_METHODS.serverRefreshProviders,
  WS_METHODS.serverTestCliProxyHub,
  ORCHESTRATION_WS_METHODS.setThreadHistoryRecovery,
  WS_METHODS.threadPriorityEnsureCurrent,
] as const;

describe("hosted reads before the snapshot", () => {
  const catchingUp = {
    transportStatus: "online",
    browserStatus: "current",
    sessionStatus: "synchronizing",
  } as const;

  it("admits exactly the observe-only reads, each classified as a read", () => {
    const early = Object.keys(RPC_ACCESS_POLICY).filter((method) =>
      hostedAdmitsReadBeforeSnapshot(catchingUp, method),
    );
    expect(early.toSorted()).toEqual(
      [
        WS_METHODS.projectsList,
        WS_METHODS.projectsListEntries,
        WS_METHODS.projectsSearchEntries,
        WS_METHODS.projectsSearchContent,
        WS_METHODS.projectsReadFile,
        WS_METHODS.projectsReadIcon,
        WS_METHODS.vcsReadLocalChanges,
        WS_METHODS.vcsReadComparison,
        WS_METHODS.vcsReadLineBlame,
        ORCHESTRATION_WS_METHODS.getThreadWindow,
        ORCHESTRATION_WS_METHODS.getThreadHistoryPage,
        ORCHESTRATION_WS_METHODS.getTurnDiff,
        ORCHESTRATION_WS_METHODS.getFullThreadDiff,
        WS_METHODS.serverGetConfig,
        WS_METHODS.serverGetSettings,
      ].toSorted(),
    );
    for (const method of early) expect(rpcDeliveryEffectFor(method)).toBe("read");
  });

  it("admits a read only on an online channel whose revalidated session is catching up", () => {
    for (const transportStatus of HOSTED_RELAY_TRANSPORT_STATUSES) {
      for (const browserStatus of HOSTED_BROWSER_STATUSES) {
        for (const sessionStatus of HOSTED_RYCO_SESSION_STATUSES) {
          const state = { transportStatus, browserStatus, sessionStatus };
          expect(hostedAdmitsReadBeforeSnapshot(state, WS_METHODS.projectsReadFile)).toBe(
            transportStatus === "online" &&
              (browserStatus === "current" || browserStatus === "synchronizing") &&
              (sessionStatus === "synchronizing" || sessionStatus === "replaying"),
          );
          for (const method of [
            ...READS_THAT_REACH_OUT,
            ORCHESTRATION_WS_METHODS.dispatchCommand,
          ]) {
            expect(hostedAdmitsReadBeforeSnapshot(state, method)).toBe(false);
          }
        }
      }
    }
  });

  it("never admits a read that changes or reaches out, though it is classified as a read", () => {
    for (const method of READS_THAT_REACH_OUT) {
      expect(rpcDeliveryEffectFor(method)).toBe("read");
      expect(hostedAdmitsReadBeforeSnapshot(catchingUp, method)).toBe(false);
    }
  });
});

describe("hosted delivery notice", () => {
  it("is absent unless delivery is unconfirmed", () => {
    expect(
      resolveHostedDeliveryNotice({ sessionStatus: "ready", sessionRecoveredAfterUnknown: false }),
    ).toBeNull();
    expect(
      resolveHostedDeliveryNotice({ sessionStatus: "stale", sessionRecoveredAfterUnknown: false }),
    ).toBeNull();
  });

  it("waits for the replacement session before offering to continue", () => {
    expect(
      resolveHostedDeliveryNotice(
        { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: false },
        "Studio Mac",
      ),
    ).toMatchObject({ canAcknowledge: false, actionLabel: "Synchronizing…" });
    const recovered = resolveHostedDeliveryNotice(
      { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: true },
      "Studio Mac",
    );
    expect(recovered).toMatchObject({ canAcknowledge: true, actionLabel: "Continue" });
    expect(recovered?.description).toContain("Studio Mac");
    expect(
      resolveHostedDeliveryNotice(
        { sessionStatus: "delivery-unknown", sessionRecoveredAfterUnknown: true },
        "  ",
      )?.description,
    ).toContain("this machine");
  });
});

const STALE_REASON = "This action is unavailable while Hub authorization or the relay is stale.";
const SELECTED_NODE_ROLE_REASON = "This action is unavailable for your role on the selected node.";
const NODE_ROLE_REASON = "This action is unavailable for your role on this node.";

function phase(overrides: Partial<HostedConnectionPhase> = {}): HostedConnectionPhase {
  return {
    accountAuthenticated: true,
    directoryReady: true,
    browserStatus: "current",
    selectionStatus: "online",
    transportStatus: "online",
    sessionStatus: "ready",
    quiet: true,
    ...overrides,
  };
}

describe("hosted capability kind", () => {
  const dispatch = ORCHESTRATION_WS_METHODS.dispatchCommand;
  const resolveWith = (
    overrides: Partial<HostedConnectionPhase>,
    role: "viewer" | "operator" = "operator",
  ) => {
    const current = phase(overrides);
    return resolveHostedRpcCapability({
      hosted: true,
      role,
      fresh: current.directoryReady && current.transportStatus === "online",
      browserCurrent: current.browserStatus === "current",
      sessionReady: current.sessionStatus === "ready",
      method: dispatch,
      phase: current,
    });
  };

  it("is ready when the action is allowed, hosted or not", () => {
    expect(resolveWith({})).toEqual({
      hosted: true,
      allowed: true,
      reason: null,
      kind: "ready",
    });
    expect(
      resolveHostedRpcCapability({ hosted: false, role: null, fresh: false, method: dispatch }),
    ).toEqual({ hosted: false, allowed: true, reason: null, kind: "ready" });
  });

  it("separates a role refusal from a connection that is not current", () => {
    expect(resolveWith({}, "viewer")).toEqual({
      hosted: true,
      allowed: false,
      reason: SELECTED_NODE_ROLE_REASON,
      kind: "role",
    });
    expect(resolveWith({ directoryReady: false })).toMatchObject({
      allowed: false,
      reason: STALE_REASON,
      kind: "stale",
    });
  });

  it("reports an unconfirmed delivery ahead of a connection that is still being established", () => {
    expect(resolveWith({ sessionStatus: "delivery-unknown" })).toMatchObject({
      allowed: false,
      reason: STALE_REASON,
      kind: "delivery-unknown",
    });
    expect(
      resolveWith({ sessionStatus: "delivery-unknown", transportStatus: "reconnecting" }),
    ).toMatchObject({ kind: "delivery-unknown" });
  });

  it.each([
    "idle",
    "requesting-ticket",
    "connecting",
    "authenticating",
    "opening-channel",
    "reconnecting",
  ] as const)("is establishing while the transport is %s and nothing is wrong", (transport) => {
    expect(resolveWith({ transportStatus: transport, sessionStatus: "synchronizing" })).toEqual({
      hosted: true,
      allowed: false,
      reason: STALE_REASON,
      kind: "establishing",
    });
  });

  it.each(["synchronizing", "replaying"] as const)(
    "is establishing while an online transport's session is %s",
    (sessionStatus) => {
      expect(resolveWith({ sessionStatus })).toMatchObject({
        allowed: false,
        kind: "establishing",
      });
    },
  );

  it("is establishing while the browser only waits for the selected node", () => {
    expect(
      resolveWith({ browserStatus: "synchronizing", transportStatus: "connecting" }),
    ).toMatchObject({ kind: "establishing" });
  });

  it.each([
    ["an error to show", { quiet: false, transportStatus: "reconnecting" }],
    ["a signed-out account", { accountAuthenticated: false, transportStatus: "connecting" }],
    ["a directory that is not ready", { directoryReady: false, transportStatus: "connecting" }],
    ["an offline node", { selectionStatus: "offline", transportStatus: "connecting" }],
    ["a revoked node", { selectionStatus: "revoked", transportStatus: "connecting" }],
    ["no selection", { selectionStatus: "none", transportStatus: "connecting" }],
    ["a draining transport", { transportStatus: "draining" }],
    ["a failed transport", { transportStatus: "terminal-failure" }],
    ["a closed session on an online transport", { sessionStatus: "closed" }],
    ["a stale session on an online transport", { sessionStatus: "stale" }],
  ] satisfies ReadonlyArray<[string, Partial<HostedConnectionPhase>]>)(
    "stays stale with %s",
    (_name, overrides) => {
      expect(resolveWith(overrides)).toMatchObject({ allowed: false, kind: "stale" });
    },
  );

  it.each(["offline", "checking-access", "suspended", "stale"] as const)(
    "stays stale while the browser is %s",
    (browserStatus) => {
      expect(resolveWith({ browserStatus, transportStatus: "connecting" })).toMatchObject({
        allowed: false,
        kind: "stale",
      });
    },
  );

  it("is stale without a phase to describe", () => {
    expect(
      resolveHostedRpcCapability({ hosted: true, role: "owner", fresh: false, method: dispatch }),
    ).toEqual({ hosted: true, allowed: false, reason: STALE_REASON, kind: "stale" });
  });

  it("answers the same input with the identical object", () => {
    expect(resolveWith({})).toBe(resolveWith({}));
    expect(resolveWith({ transportStatus: "connecting", sessionStatus: "synchronizing" })).toBe(
      resolveWith({ transportStatus: "idle", sessionStatus: "closed" }),
    );
    expect(Object.isFrozen(resolveWith({}))).toBe(true);
  });

  it("covers every transport status either as establishing or not", () => {
    const establishing = HOSTED_RELAY_TRANSPORT_STATUSES.filter((transportStatus) =>
      isHostedConnectionEstablishing(phase({ transportStatus, sessionStatus: "synchronizing" })),
    );
    expect(establishing.toSorted()).toEqual(
      [
        "authenticating",
        "connecting",
        "idle",
        "online",
        "opening-channel",
        "reconnecting",
        "requesting-ticket",
      ].toSorted(),
    );
  });
});

const ENV_X = EnvironmentId.make("env_xxxxxxxxxxxxxxxxxxxxxx");
const ENV_Y = EnvironmentId.make("env_yyyyyyyyyyyyyyyyyyyyyy");
const ENV_Z = EnvironmentId.make("env_zzzzzzzzzzzzzzzzzzzzzz");

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

function createSessions(): HostedEnvironmentSessions {
  return createHostedEnvironmentSessions({
    now: () => 0,
    setTimeout: () => null,
    clearTimeout: () => undefined,
  });
}

/** A record whose own relay attempt reached `transport` and `session`. */
function connect(
  sessions: HostedEnvironmentSessions,
  environmentId: EnvironmentId,
  options: {
    readonly role?: HostedHubNode["effectiveRole"];
    readonly transport?: HostedRelayTransportStatus;
    readonly session?: HostedRycoSessionStatus;
  } = {},
) {
  const { generation } = sessions.ensureRecord(
    hubNode(environmentId, { effectiveRole: options.role ?? "operator" }),
  );
  sessions.markConnectRequested(environmentId, generation);
  sessions.transportStatus(environmentId, generation, options.transport ?? "online");
  const session = options.session ?? "ready";
  if (session === "ready") sessions.markSessionReady(environmentId, generation);
  else sessions.sessionStatus(environmentId, generation, session);
  return generation;
}

function sharedState(
  overrides: Partial<HostedSharedCapabilityState> = {},
): HostedSharedCapabilityState {
  return {
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
    selectionStatus: "online",
    effectiveRole: "operator",
    transportStatus: "online",
    sessionStatus: "ready",
    sessionRecoveredAfterUnknown: false,
    errorMessage: null,
    selectedEnvironmentId: ENV_Y,
    nodeOnline: true,
    ...overrides,
  };
}

describe("per-environment hosted capability", () => {
  const dispatch = ORCHESTRATION_WS_METHODS.dispatchCommand;
  const resolve = (
    sessions: HostedEnvironmentSessions,
    environmentId: EnvironmentId | null | undefined,
    shared = sharedState(),
  ) =>
    resolveHostedEnvironmentRpcCapability({
      hosted: true,
      method: dispatch,
      shared,
      record: environmentId == null ? undefined : sessions.read(environmentId),
      environmentId,
    });

  it("answers an unspecified or the selected environment from the shared state", () => {
    const sessions = createSessions();
    // A record for the selected environment is not consulted: the shared
    // state is its projection.
    connect(sessions, ENV_Y, { role: "viewer", session: "synchronizing" });
    for (const environmentId of [undefined, null, ENV_Y]) {
      expect(resolve(sessions, environmentId)).toBe(
        resolveHostedRpcCapability({
          hosted: true,
          role: "operator",
          fresh: true,
          browserCurrent: true,
          sessionReady: true,
          method: dispatch,
        }),
      );
    }
    expect(resolve(sessions, ENV_Y, sharedState({ effectiveRole: "viewer" }))).toMatchObject({
      allowed: false,
      reason: SELECTED_NODE_ROLE_REASON,
      kind: "role",
    });
  });

  it("gates a synchronizing environment on its own session while the selection is ready", () => {
    const sessions = createSessions();
    connect(sessions, ENV_X, { session: "synchronizing" });
    connect(sessions, ENV_Y);
    expect(resolve(sessions, ENV_X)).toEqual({
      hosted: true,
      allowed: false,
      reason: STALE_REASON,
      kind: "establishing",
    });
    expect(resolve(sessions, ENV_Y)).toMatchObject({ allowed: true, kind: "ready" });
  });

  it("admits an established environment while the selection is still synchronizing", () => {
    const sessions = createSessions();
    connect(sessions, ENV_X);
    connect(sessions, ENV_Y, { session: "synchronizing" });
    const selectionSynchronizing = sharedState({
      browserStatus: "synchronizing",
      sessionStatus: "synchronizing",
    });
    expect(resolve(sessions, ENV_X, selectionSynchronizing)).toMatchObject({
      allowed: true,
      kind: "ready",
    });
    expect(resolve(sessions, ENV_Y, selectionSynchronizing)).toMatchObject({
      allowed: false,
      kind: "establishing",
    });
  });

  it.each(["checking-access", "offline", "suspended", "stale"] as const)(
    "refuses an established environment while the browser is %s",
    (browserStatus: HostedBrowserStatus) => {
      const sessions = createSessions();
      connect(sessions, ENV_X);
      expect(resolve(sessions, ENV_X, sharedState({ browserStatus }))).toMatchObject({
        allowed: false,
        kind: "stale",
      });
    },
  );

  it("refuses an environment while the directory is not ready", () => {
    const sessions = createSessions();
    connect(sessions, ENV_X);
    expect(resolve(sessions, ENV_X, sharedState({ directoryStatus: "loading" }))).toMatchObject({
      allowed: false,
      kind: "stale",
    });
  });

  it("applies each environment's own role", () => {
    const sessions = createSessions();
    connect(sessions, ENV_X, { role: "viewer" });
    connect(sessions, ENV_Y);
    expect(resolve(sessions, ENV_X)).toEqual({
      hosted: true,
      allowed: false,
      reason: NODE_ROLE_REASON,
      kind: "role",
    });
    expect(resolve(sessions, ENV_Y)).toMatchObject({ allowed: true });
    // Reads stay open to the viewer.
    expect(
      resolveHostedEnvironmentRpcCapability({
        hosted: true,
        method: WS_METHODS.projectsList,
        shared: sharedState(),
        record: sessions.read(ENV_X),
        environmentId: ENV_X,
      }),
    ).toMatchObject({ allowed: true });
  });

  it("applies each environment's own transport", () => {
    const sessions = createSessions();
    connect(sessions, ENV_X, { transport: "reconnecting", session: "stale" });
    expect(resolve(sessions, ENV_X)).toMatchObject({ allowed: false, kind: "establishing" });
    const generation = sessions.read(ENV_X)!.generation;
    sessions.failure(ENV_X, generation, { kind: "network", retryable: true });
    expect(resolve(sessions, ENV_X)).toMatchObject({ allowed: false, kind: "stale" });
  });

  it("reports an environment's own unconfirmed delivery, and admits reads once it recovers", () => {
    const sessions = createSessions();
    const generation = connect(sessions, ENV_X);
    sessions.markDeliveryUnknown(ENV_X, generation);
    expect(resolve(sessions, ENV_X)).toMatchObject({ allowed: false, kind: "delivery-unknown" });
    sessions.markSessionReady(ENV_X, generation);
    const read = (environmentId: EnvironmentId) =>
      resolveHostedEnvironmentRpcCapability({
        hosted: true,
        method: WS_METHODS.projectsReadFile,
        shared: sharedState(),
        record: sessions.read(environmentId),
        environmentId,
      });
    expect(read(ENV_X)).toMatchObject({ allowed: true });
    expect(resolve(sessions, ENV_X)).toMatchObject({ allowed: false, kind: "delivery-unknown" });
  });

  it("does not treat a node the directory reports offline as connecting", () => {
    const sessions = createSessions();
    connect(sessions, ENV_X, { transport: "connecting", session: "synchronizing" });
    expect(resolve(sessions, ENV_X)).toMatchObject({ kind: "establishing" });
    expect(resolve(sessions, ENV_X, sharedState({ nodeOnline: false }))).toMatchObject({
      allowed: false,
      kind: "stale",
    });
  });

  it("is never allowed without a record, and is establishing only for a reachable node", () => {
    const sessions = createSessions();
    expect(resolve(sessions, ENV_Z)).toEqual({
      hosted: true,
      allowed: false,
      reason: STALE_REASON,
      kind: "establishing",
    });
    for (const overrides of [
      { nodeOnline: null },
      { nodeOnline: false },
      { accountStatus: "session-expired" },
      { directoryStatus: "stale" },
      { browserStatus: "offline" },
      { browserStatus: "checking-access" },
    ] satisfies ReadonlyArray<Partial<HostedSharedCapabilityState>>) {
      expect(resolve(sessions, ENV_Z, sharedState(overrides))).toMatchObject({
        allowed: false,
        reason: STALE_REASON,
        kind: "stale",
      });
    }
    expect(resolve(sessions, ENV_Z, sharedState({ browserStatus: "synchronizing" }))).toMatchObject(
      { allowed: false, kind: "establishing" },
    );
  });

  it("allows everything outside a hosted build", () => {
    expect(
      resolveHostedEnvironmentRpcCapability({
        hosted: false,
        method: dispatch,
        shared: sharedState({ directoryStatus: "idle" }),
        record: undefined,
        environmentId: ENV_X,
      }),
    ).toEqual({ hosted: false, allowed: true, reason: null, kind: "ready" });
  });

  it("answers the same environment state with the identical object", () => {
    const sessions = createSessions();
    connect(sessions, ENV_X);
    expect(resolve(sessions, ENV_X)).toBe(resolve(sessions, ENV_X));
    expect(resolve(sessions, ENV_X)).toBe(
      resolve(sessions, ENV_X, sharedState({ nodeOnline: null })),
    );
  });

  describe("observe-only reads before the snapshot", () => {
    const resolveMethod = (
      method: string,
      sessions: HostedEnvironmentSessions,
      environmentId: EnvironmentId | null | undefined,
      shared: HostedSharedCapabilityState,
      requireSnapshot?: boolean,
    ) =>
      resolveHostedEnvironmentRpcCapability({
        hosted: true,
        method,
        shared,
        record: environmentId == null ? undefined : sessions.read(environmentId),
        environmentId,
        ...(requireSnapshot === undefined ? {} : { requireSnapshot }),
      });
    const ready = resolveHostedRpcCapability({
      hosted: true,
      role: "operator",
      fresh: true,
      method: dispatch,
    });
    const read = WS_METHODS.projectsReadFile;

    it.each([
      ["current", "synchronizing"],
      ["current", "replaying"],
      ["synchronizing", "synchronizing"],
    ] as const)(
      "admits a read on the selection while the browser is %s and the session %s",
      (browserStatus, sessionStatus) => {
        const sessions = createSessions();
        const shared = sharedState({ browserStatus, sessionStatus });
        for (const environmentId of [undefined, null, ENV_Y]) {
          expect(resolveMethod(read, sessions, environmentId, shared)).toBe(ready);
          expect(resolveMethod(read, sessions, environmentId, shared, true)).toEqual({
            hosted: true,
            allowed: false,
            reason: STALE_REASON,
            kind: "establishing",
          });
          expect(resolveMethod(dispatch, sessions, environmentId, shared)).toMatchObject({
            allowed: false,
            kind: "establishing",
          });
        }
      },
    );

    it.each([
      ["current", "synchronizing"],
      ["current", "replaying"],
      ["synchronizing", "synchronizing"],
    ] as const)(
      "admits a read on another environment while the browser is %s and its session %s",
      (browserStatus, session) => {
        const sessions = createSessions();
        connect(sessions, ENV_X, { session });
        const shared = sharedState({ browserStatus, sessionStatus: "synchronizing" });
        expect(resolveMethod(read, sessions, ENV_X, shared)).toBe(ready);
        expect(resolveMethod(read, sessions, ENV_X, shared, true)).toEqual({
          hosted: true,
          allowed: false,
          reason: STALE_REASON,
          kind: "establishing",
        });
        expect(resolveMethod(dispatch, sessions, ENV_X, shared)).toMatchObject({
          allowed: false,
          kind: "establishing",
        });
      },
    );

    it("keeps a read that changes or reaches out waiting for the snapshot", () => {
      const sessions = createSessions();
      connect(sessions, ENV_X, { session: "synchronizing" });
      const shared = sharedState({ sessionStatus: "synchronizing" });
      for (const method of [WS_METHODS.providerPrewarmSession, WS_METHODS.vcsListRefs]) {
        expect(resolveMethod(method, sessions, ENV_X, shared)).toMatchObject({
          allowed: false,
          kind: "establishing",
        });
        expect(resolveMethod(method, sessions, ENV_Y, shared)).toMatchObject({
          allowed: false,
          kind: "establishing",
        });
      }
    });

    it("still applies the role the read requires", () => {
      const sessions = createSessions();
      connect(sessions, ENV_X, { role: "viewer", session: "synchronizing" });
      const shared = sharedState({ effectiveRole: "viewer", sessionStatus: "synchronizing" });
      expect(resolveMethod(read, sessions, ENV_X, shared)).toEqual({
        hosted: true,
        allowed: false,
        reason: NODE_ROLE_REASON,
        kind: "role",
      });
      expect(resolveMethod(read, sessions, ENV_Y, shared)).toEqual({
        hosted: true,
        allowed: false,
        reason: SELECTED_NODE_ROLE_REASON,
        kind: "role",
      });
      // A viewer-tier read is open to the viewer.
      expect(resolveMethod(WS_METHODS.projectsList, sessions, ENV_X, shared)).toBe(ready);
    });

    it("admits nothing early to a session that is not catching up on an online channel", () => {
      const sessions = createSessions();
      const generation = connect(sessions, ENV_X, { session: "synchronizing" });
      sessions.markDeliveryUnknown(ENV_X, generation);
      expect(resolveMethod(read, sessions, ENV_X, sharedState())).toMatchObject({
        allowed: false,
        kind: "delivery-unknown",
      });
      connect(sessions, ENV_Z, { transport: "opening-channel", session: "synchronizing" });
      expect(resolveMethod(read, sessions, ENV_Z, sharedState())).toMatchObject({
        allowed: false,
        kind: "establishing",
      });
      for (const shared of [
        sharedState({ sessionStatus: "delivery-unknown" }),
        sharedState({ sessionStatus: "stale" }),
        sharedState({ transportStatus: "reconnecting", sessionStatus: "stale" }),
        sharedState({ browserStatus: "checking-access", sessionStatus: "synchronizing" }),
        sharedState({ directoryStatus: "loading", sessionStatus: "synchronizing" }),
      ]) {
        expect(resolveMethod(read, sessions, ENV_Y, shared).allowed).toBe(false);
      }
    });
  });
});

describe("selectHostedSharedCapabilityState", () => {
  const state = {
    accountStatus: "authenticated",
    directoryStatus: "ready",
    browserStatus: "current",
    selectionStatus: "online",
    effectiveRole: "operator",
    transportStatus: "online",
    sessionStatus: "ready",
    sessionRecoveredAfterUnknown: false,
    errorMessage: null,
    selectedNode: hubNode(ENV_Y),
    nodes: [hubNode(ENV_X, { presence: { online: false, lastHeartbeatAt: 1 } }), hubNode(ENV_Y)],
  } as const;

  it("reads the directory presence only for another environment", () => {
    expect(selectHostedSharedCapabilityState(state)).toMatchObject({
      selectedEnvironmentId: ENV_Y,
      nodeOnline: null,
    });
    expect(selectHostedSharedCapabilityState(state, null).nodeOnline).toBeNull();
    expect(selectHostedSharedCapabilityState(state, ENV_Y).nodeOnline).toBeNull();
    expect(selectHostedSharedCapabilityState(state, ENV_X).nodeOnline).toBe(false);
    expect(selectHostedSharedCapabilityState(state, ENV_Z).nodeOnline).toBeNull();
  });

  it("changes nothing for a directory refresh that leaves the capability inputs alone", () => {
    const before = selectHostedSharedCapabilityState(state, ENV_X);
    const refreshed = selectHostedSharedCapabilityState(
      { ...state, nodes: state.nodes.map((node) => ({ ...node, updatedAt: 2 })) },
      ENV_X,
    );
    expect(refreshed).toEqual(before);
  });

  it("tolerates a state without a selection", () => {
    expect(
      selectHostedSharedCapabilityState({ ...state, selectedNode: null, nodes: [] }),
    ).toMatchObject({ selectedEnvironmentId: null, nodeOnline: null });
  });
});
