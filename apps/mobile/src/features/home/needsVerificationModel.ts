import type { HostedHubNode } from "@ryco/client-runtime/authorization";
import type { WorkspaceNativeTrustState } from "@ryco/client-runtime/state/workspace";

import { exactNodeRouteParams } from "../e2ee/exactNodeRouteModel";

export interface NeedsVerificationRow {
  readonly nodeId: string;
  readonly environmentId: string;
  readonly label: string;
  readonly detail: string;
  readonly route: { readonly nodeId: string; readonly environmentId: string };
  readonly lockedHistory: boolean;
}

const ROLE_LABELS = { viewer: "Viewer", operator: "Operator", owner: "Owner" } as const;

function trustLabel(trust: WorkspaceNativeTrustState): string {
  switch (trust) {
    case "identity-conflict":
      return "Identity changed";
    case "unknown":
      return "Verification unavailable";
    case "unverified":
      return "Not verified";
    case "account-trusted":
      return "Encrypted · Account trusted";
    case "verified":
    case "not-required":
      return "Verified";
  }
}

export function buildNeedsVerificationRows(input: {
  readonly nodes: ReadonlyArray<HostedHubNode>;
  readonly trustByEnvironmentId: ReadonlyMap<string, WorkspaceNativeTrustState>;
}): ReadonlyArray<NeedsVerificationRow> {
  return input.nodes
    .filter((node) => {
      const trust = input.trustByEnvironmentId.get(node.environmentId) ?? "unknown";
      // Account-trusted nodes are already usable. Independent verification stays
      // available in node security; the home warning is for trust that blocks work.
      return (
        node.revokedAt === null &&
        trust !== "verified" &&
        trust !== "not-required" &&
        trust !== "account-trusted"
      );
    })
    .map((node) => {
      const trust = input.trustByEnvironmentId.get(node.environmentId) ?? "unknown";
      return {
        nodeId: node.id,
        environmentId: node.environmentId,
        label: node.label,
        detail: `${trustLabel(trust)} · ${node.presence.online ? "Online" : "Offline"} · ${ROLE_LABELS[node.effectiveRole]}`,
        route: exactNodeRouteParams(node),
        lockedHistory: trust === "identity-conflict",
      };
    })
    .toSorted(
      (left, right) =>
        left.label.localeCompare(right.label) ||
        left.environmentId.localeCompare(right.environmentId),
    );
}
