import type { EnvironmentId } from "@ryco/contracts";
import { hostedBrowserRevalidated } from "@ryco/client-runtime/authorization";
import { useShallow } from "zustand/react/shallow";

import { useHostedHubStore, useMobileHostedConnectionsStore } from "../../hostedHub/state";
import { useStore } from "../../state/threadsRuntime";
import { useSavedEnvironments } from "../connection/useConnectionController";
import { selectShellCurrentByEnvironmentId } from "./homeEnvironmentModel";
import { workspaceEligibleEnvironmentIds } from "./nativeNodeEligibilityModel";
import { useAuthoritativeNodeTrust } from "./useAuthoritativeNodeTrust";

export interface HostedDemandCandidate {
  readonly environmentId: EnvironmentId;
  /** Not revoked, online in the directory, trusted, and not owned by the direct connection plane. */
  readonly eligible: boolean;
  /** Its own session is established and it accepted its own current shell snapshot. */
  readonly ready: boolean;
  readonly failed: boolean;
}

export interface HostedDemandCandidates {
  /** The account, session and Space the demand belongs to; null signed out. */
  readonly authority: string | null;
  /**
   * This lifecycle revalidated access and the directory is ready. It does not
   * wait for the selected machine: a browser that only synchronizes that one
   * is as current for every other machine (`hostedBrowserRevalidated`), so the
   * others connect beside it instead of after it.
   */
  readonly current: boolean;
  readonly candidates: ReadonlyArray<HostedDemandCandidate>;
}

/**
 * The Hub machines a background surface may ask the connection plane for
 * (Home's discovery, the Tasks surfaces): one eligibility rule for both, so
 * an offline, revoked, untrusted or directly paired node never takes a slot.
 */
export function useHostedDemandCandidates(): HostedDemandCandidates {
  const hosted = useHostedHubStore(
    useShallow((state) => ({
      authority:
        state.accountStatus === "authenticated" && state.account !== null
          ? JSON.stringify([state.account.id, state.session?.id, state.session?.activeSpaceId])
          : null,
      current: hostedBrowserRevalidated(state.browserStatus) && state.directoryStatus === "ready",
      nodes: state.nodes,
    })),
  );
  const connections = useMobileHostedConnectionsStore((state) => state.selectedNodes);
  const shellCurrent = useStore(useShallow(selectShellCurrentByEnvironmentId));
  const trust = useAuthoritativeNodeTrust(
    hosted.nodes.map((node) => ({ nodeId: node.id, environmentId: node.environmentId })),
  );
  const { rows: direct } = useSavedEnvironments();

  // The React Compiler memoizes this on its inputs, so the result keeps its identity between renders.
  const trusted = workspaceEligibleEnvironmentIds(trust);
  const directIds = new Set(direct.map((row) => row.record.environmentId));
  const sessions = new Map(connections.map((connection) => [connection.environmentId, connection]));
  return {
    authority: hosted.authority,
    current: hosted.current,
    candidates: hosted.nodes.map((node) => {
      const session = sessions.get(node.environmentId);
      return {
        environmentId: node.environmentId as EnvironmentId,
        eligible:
          node.revokedAt === null &&
          node.presence.online &&
          trusted.has(node.environmentId) &&
          !directIds.has(node.environmentId),
        ready:
          session?.sessionEstablished === true &&
          session.sessionStatus === "ready" &&
          shellCurrent[node.environmentId] === true,
        failed: session?.transportStatus === "terminal-failure",
      };
    }),
  };
}
