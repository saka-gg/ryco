import type { EnvironmentId } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { hostedState } from "../features/home/homeEnvironmentModel";
import {
  deriveWorkspaceShellSummary,
  hostedWorkspacePhase,
  mergeWorkspaceEnvironments,
  projectWorkspaceState,
  type WorkspaceEnvironment,
} from "./workspaceModel";
import {
  shouldShowWorkspaceConnectionStatus,
  workspaceConnectionStatusLabel,
} from "../features/home/workspace-connection-status";

const NODE = "env-hosted" as EnvironmentId;
const DIRECT = "env-direct" as EnvironmentId;

function environment(
  environmentId: EnvironmentId,
  connectionState: WorkspaceEnvironment["connectionState"],
): WorkspaceEnvironment {
  return {
    environmentId,
    environmentLabel: String(environmentId),
    connectionState,
    connectionError: null,
  };
}

describe("hostedWorkspacePhase", () => {
  it("treats a live relay as connected", () => {
    expect(hostedWorkspacePhase("connected")).toBe("connected");
  });

  it("treats read-only as connected — the banner asks whether a node is reachable", () => {
    // A viewer-role device that can see its threads IS connected. Reporting it
    // as not-connected is the same lie in a narrower case.
    expect(hostedWorkspacePhase("read-only")).toBe("connected");
  });

  it("passes reconnecting and offline through", () => {
    expect(hostedWorkspacePhase("reconnecting")).toBe("reconnecting");
    expect(hostedWorkspacePhase("offline")).toBe("offline");
  });
});

describe("mergeWorkspaceEnvironments", () => {
  it("returns the direct list untouched when no hosted node is selected", () => {
    const direct = [environment(DIRECT, "connected")];
    expect(mergeWorkspaceEnvironments(direct, [])).toBe(direct);
  });

  it("adds the hosted node when it is not already a direct one", () => {
    const merged = mergeWorkspaceEnvironments(
      [environment(DIRECT, "offline")],
      [environment(NODE, "connected")],
    );
    expect(merged.map((e) => e.environmentId)).toEqual([DIRECT, NODE]);
  });

  it("lets hosted win when the same node is reachable on both planes", () => {
    // A node can be paired directly AND enrolled in the Hub, reusing the same
    // environment id. buildHomeEnvironments resolves this the same way, so the
    // two derivations cannot disagree about one node.
    const merged = mergeWorkspaceEnvironments(
      [environment(NODE, "offline")],
      [environment(NODE, "connected")],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.connectionState).toBe("connected");
  });
});

describe("deriveWorkspaceShellSummary", () => {
  it("keeps readiness scoped when another environment is active and settled", () => {
    const environments = [environment(DIRECT, "connected"), environment(NODE, "connected")];
    const complete = new Set<EnvironmentId>([NODE]);

    expect(
      deriveWorkspaceShellSummary(environments, (environmentId) => complete.has(environmentId)),
    ).toEqual({
      hasSnapshot: true,
      hasSynchronizingShell: true,
      firstError: null,
      latestSnapshotUpdatedAt: null,
    });
  });
});

describe("the Not-connected regression", () => {
  // The bug: useWorkspaceState built its environment list only from the direct
  // plane's catalog, which the hosted plane never writes to. With a
  // Hub-relay-only node serving real threads, the workspace saw ZERO
  // environments and the Inbox header read "Not connected" while the thread it
  // linked to read "Ready".
  const liveRelay = {
    environmentId: NODE,
    label: "MacBook Pro",
    transportStatus: "online" as const,
    sessionStatus: "ready" as const,
    role: "owner" as const,
  };

  it("reports a saved view when the hosted node is dropped", () => {
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments: [],
      shellSummary: {
        hasSnapshot: true,
        hasSynchronizingShell: false,
        firstError: null,
        latestSnapshotUpdatedAt: null,
      },
    });
    expect(workspaceConnectionStatusLabel(state)).toBe("Saved view · Machines unavailable");
    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
  });

  it("goes quiet once the live relay is projected in", () => {
    const hosted = environment(NODE, hostedWorkspacePhase(hostedState(liveRelay)));
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments: mergeWorkspaceEnvironments([], [hosted]),
      shellSummary: {
        hasSnapshot: true,
        hasSynchronizingShell: false,
        firstError: null,
        latestSnapshotUpdatedAt: null,
      },
    });
    expect(state.hasReadyEnvironment).toBe(true);
    // Nothing to say: the banner only appears when something is wrong.
    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(false);
  });

  it("does NOT go quiet while the relay is genuinely reconnecting", () => {
    // The inverse failure matters just as much: this must not paper over a real
    // connection problem.
    const hosted = environment(
      NODE,
      hostedWorkspacePhase(hostedState({ ...liveRelay, transportStatus: "reconnecting" })),
    );
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments: mergeWorkspaceEnvironments([], [hosted]),
      shellSummary: {
        hasSnapshot: true,
        hasSynchronizingShell: false,
        firstError: null,
        latestSnapshotUpdatedAt: null,
      },
    });
    expect(state.hasReadyEnvironment).toBe(false);
    expect(shouldShowWorkspaceConnectionStatus(state)).toBe(true);
    expect(workspaceConnectionStatusLabel(state)).toBe("Saved view · Machines unavailable");
  });

  it("still reports offline when the device has no network, relay or not", () => {
    const hosted = environment(NODE, hostedWorkspacePhase(hostedState(liveRelay)));
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "offline",
      environments: mergeWorkspaceEnvironments([], [hosted]),
      shellSummary: {
        hasSnapshot: true,
        hasSynchronizingShell: false,
        firstError: null,
        latestSnapshotUpdatedAt: null,
      },
    });
    expect(workspaceConnectionStatusLabel(state)).toBe("You are offline");
  });
});
