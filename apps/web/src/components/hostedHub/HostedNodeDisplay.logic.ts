// Pure presentation logic for the hosted node directory and the node detail
// sheet.
//
// Free of React and of the runtime stores so the parts whose failure modes are
// *claims about a machine* can be exercised directly: the ordering, the
// platform mapping, and above all the two nullable timestamps, whose null
// meanings are asymmetric and whose confusion prints a false negative about a
// live node.

import type { HostedHubNode } from "../../hostedHub/types";

const timestampFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** An absolute timestamp, or `null` when the Hub reported none. */
export function formatEpoch(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  return timestampFormatter.format(new Date(value));
}

/**
 * The platform token as a word, mapped exhaustively over the closed union.
 *
 * A mapping, never an inference: `platformArch` is rendered raw beside it
 * precisely because "Apple silicon" is a claim the Hub never made and is wrong
 * for an arm64 Linux box.
 */
export function platformLabel(platformOs: HostedHubNode["platformOs"]): string {
  switch (platformOs) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "windows":
      return "Windows";
    case "unknown":
      return "Unknown platform";
  }
}

function capitalize(value: string): string {
  return value.length === 0 ? value : value[0]!.toUpperCase() + value.slice(1);
}

/** The role in effect for this account on this node, as a word. */
export function roleLabel(role: string): string {
  return capitalize(role);
}

/**
 * Relative time at minute granularity or coarser.
 *
 * `listNodes` polls every 20 seconds and pauses while the tab is backgrounded,
 * so "3 seconds ago" claims a precision the poll cannot support. A future
 * timestamp — clock skew between the node, the Hub, and this browser is
 * ordinary — falls back to the absolute form rather than rendering "in 3
 * minutes", which reads as a bug.
 */
export function relativeTime(value: number, nowMs: number): string {
  if (!Number.isFinite(value)) return "unknown";
  const elapsedMs = nowMs - value;
  if (elapsedMs < 0) return formatEpoch(value) ?? "unknown";
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 2) return "just now";
  if (minutes < 60) return `${String(minutes)} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${String(hours)} h ago`;
  return formatEpoch(value) ?? "unknown";
}

/**
 * What the directory can honestly say about when a node was last there.
 *
 * A null must never render as a bare "Never": `presence.online === true` means
 * the answer is "now", and `lastHeartbeatAt === null` does **not** mean the node
 * never sent a heartbeat — the contract permits null while online. Only
 * `lastAuthenticatedAt === null` genuinely means "never".
 */
export function lastSeenLabel(node: HostedHubNode, nowMs: number): string | null {
  if (node.presence.online) return null;
  if (node.presence.lastHeartbeatAt !== null) {
    return `Last seen ${relativeTime(node.presence.lastHeartbeatAt, nowMs)}`;
  }
  if (node.lastAuthenticatedAt !== null) {
    return `Last authenticated ${relativeTime(node.lastAuthenticatedAt, nowMs)}`;
  }
  return "No connection recorded";
}

/**
 * The single muted line under a node's label.
 *
 * Revocation is named here as the *reason*; that the node is revoked at all is
 * said once, by `NodePresence`, in the row's trailing slot.
 */
export function nodeMetaLine(node: HostedHubNode): string {
  const platform = `${platformLabel(node.platformOs)} · ${node.platformArch}`;
  if (node.revokedAt !== null) {
    return node.revocationReasonCode
      ? `${platform} · Access revoked — ${node.revocationReasonCode}`
      : `${platform} · Access revoked`;
  }
  return `${platform} · ${roleLabel(node.effectiveRole)}`;
}

/**
 * Directory order: revoked last, then label ascending.
 *
 * Presence is deliberately **not** a sort key. It is polled at 20 seconds and
 * pauses and resumes with tab visibility, so an online-first order reorders the
 * list under the user's pointer on a cadence they cannot predict — a misclick
 * generator on a surface whose whole job is one click onto the right machine.
 * Revoked-last is safe because revocation is monotonic.
 *
 * `toSorted` rather than `sort`: the array is the runtime store's own, and
 * sorting it in place would reorder state a render is reading.
 */
export function sortNodes(nodes: ReadonlyArray<HostedHubNode>): ReadonlyArray<HostedHubNode> {
  return nodes.toSorted((left, right) => {
    const leftRevoked = left.revokedAt !== null ? 1 : 0;
    const rightRevoked = right.revokedAt !== null ? 1 : 0;
    if (leftRevoked !== rightRevoked) return leftRevoked - rightRevoked;
    return left.label.localeCompare(right.label, undefined, {
      numeric: true,
      sensitivity: "base",
    });
  });
}

/** Nodes this account is still authorized on, for the header's count line. */
export function authorizedNodeCount(nodes: ReadonlyArray<HostedHubNode>): number {
  return nodes.filter((node) => node.revokedAt === null).length;
}

/** Nodes that are online and still authorized, for the header's count line. */
export function onlineNodeCount(nodes: ReadonlyArray<HostedHubNode>): number {
  return nodes.filter((node) => node.revokedAt === null && node.presence.online).length;
}

/**
 * `{n} authorized · {m} online`, plus `· {k} revoked` when any are.
 *
 * Both counts read the same set. "Authorized" used to be `nodes.length`, which
 * counted revoked nodes — a machine this account cannot connect to and that the
 * rows two lines below label "Access revoked" — while "online" excluded them, so
 * one sentence used two definitions of its own subject and overstated the user's
 * reach by exactly the revoked nodes.
 *
 * The revoked segment exists so the header still accounts for every row the list
 * renders: revoked nodes are shown (last), and dropping them from the count
 * without saying so would trade an overstatement for an unexplained gap between
 * "2 authorized" and three visible rows.
 */
export function directoryCountLine(nodes: ReadonlyArray<HostedHubNode>): string {
  const authorized = authorizedNodeCount(nodes);
  const online = onlineNodeCount(nodes);
  const revoked = nodes.length - authorized;
  const head = `${String(authorized)} authorized · ${online === 0 ? "none online" : `${String(online)} online`}`;
  return revoked === 0 ? head : `${head} · ${String(revoked)} revoked`;
}

/**
 * The nodes a hosted page may offer as choices: still authorized, and open to
 * this browser rather than only to the native clients. Whether a choice can be
 * made right now is `nodeSelectionBlocked`'s answer.
 */
export function selectableNodes(nodes: ReadonlyArray<HostedHubNode>): ReadonlyArray<HostedHubNode> {
  return nodes.filter(
    (node) => node.revokedAt === null && node.capabilities?.nativeClientRequired !== true,
  );
}

/**
 * Whether the directory may start a relay session for this node — the exact
 * predicate the row's connect control and the detail sheet's Connect share, so
 * the two can never disagree about what is reachable.
 */
export function nodeSelectionBlocked(input: {
  readonly directoryStatus: string;
  readonly browserStatus: string;
  readonly node: HostedHubNode;
}): boolean {
  return (
    input.directoryStatus !== "ready" ||
    input.browserStatus !== "current" ||
    input.node.revokedAt !== null ||
    input.node.capabilities?.nativeClientRequired === true
  );
}

/**
 * Why connecting is unavailable, reusing the bounded strings the connection
 * sheet already ships. No new failure vocabulary is invented here.
 */
export function nodeSelectionBlockedReason(input: {
  readonly directoryStatus: string;
  readonly browserStatus: string;
  readonly node: HostedHubNode;
}): string | null {
  if (input.node.capabilities?.nativeClientRequired === true) {
    return "Open this node in Desktop/Mobile.";
  }
  if (input.node.revokedAt !== null) return "Access to this node was revoked.";
  if (input.directoryStatus !== "ready" || input.browserStatus !== "current") {
    return "Node switching is unavailable until the directory and this browser are current.";
  }
  return null;
}
