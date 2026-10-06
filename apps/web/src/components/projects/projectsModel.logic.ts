import type { EnvironmentId, RepositoryIdentity } from "@ryco/contracts";
import { deriveThreadActivityStatus } from "@ryco/client-runtime/state/threads";

import type {
  SidebarProjectGroupMember,
  SidebarProjectSnapshot,
} from "../../sidebarProjectGrouping";
import type { SidebarThreadSummary } from "../../types";

/** One device a logical project is checked out on (members deduped by environment). */
export interface ProjectDevicePresence {
  readonly environmentId: EnvironmentId;
  /** Null for the primary environment (the UI names it "This device"). */
  readonly label: string | null;
}

/** A row in the projects list: one logical project. */
export interface ProjectListRow {
  /** The logical project key (stable across checkouts). */
  readonly key: string;
  readonly snapshot: SidebarProjectSnapshot;
  readonly name: string;
  /** `owner/name` when the project has a remote (and the name is not already it), else the path tail. */
  readonly subtitle: string;
  readonly devices: readonly ProjectDevicePresence[];
  /** Latest thread activity in ms, or null when the project has no threads. */
  readonly lastActivityAt: number | null;
  /** Some thread in the project is working right now. */
  readonly running: boolean;
  /** Lower-cased haystack for the list filter. */
  readonly searchText: string;
}

type ThreadActivityInput = Pick<
  SidebarThreadSummary,
  | "environmentId"
  | "projectId"
  | "archivedAt"
  | "updatedAt"
  | "latestUserMessageAt"
  | "hasActionableProposedPlan"
  | "hasPendingApprovals"
  | "hasPendingUserInput"
  | "interactionMode"
  | "latestTurn"
  | "session"
  | "backgroundLiveness"
>;

/** `owner/name` for a repository identity, when it names one. */
export function projectRepositoryLabel(
  identity: RepositoryIdentity | null | undefined,
): string | null {
  if (!identity) return null;
  if (identity.owner && identity.name) return `${identity.owner}/${identity.name}`;
  const primary = (identity.remotes ?? []).find(
    (remote) => remote.name === identity.locator.remoteName,
  );
  return primary?.ownerRepo ?? identity.displayName ?? null;
}

/**
 * The path as people read it: the home directory as `~`, otherwise the full
 * path. Works for POSIX and Windows separators.
 */
export function formatProjectPath(cwd: string, homeDir: string | null | undefined): string {
  if (homeDir && homeDir.length > 1) {
    const home = homeDir.replace(/[\\/]+$/u, "");
    if (cwd === home) return "~";
    if (cwd.startsWith(`${home}/`) || cwd.startsWith(`${home}\\`)) {
      return `~${cwd.slice(home.length)}`;
    }
  }
  return cwd;
}

/**
 * The home directory a path sits under, inferred from the usual layouts
 * (`/Users/<name>`, `/home/<name>`, `C:\\Users\\<name>`); servers do not report it.
 */
export function inferHomeDirectory(cwd: string): string | null {
  const match = /^(\/Users\/[^/]+|\/home\/[^/]+|[A-Za-z]:\\Users\\[^\\]+)(?=$|[\\/])/u.exec(cwd);
  return match?.[1] ?? null;
}

/** The last two path segments (`Code/ryco`), for one-line subtitles. */
export function projectPathTail(cwd: string): string {
  const parts = cwd.split(/[\\/]+/u).filter(Boolean);
  return parts.slice(-2).join("/") || cwd;
}

/** One entry per environment, primary first, in member order otherwise. */
export function deriveProjectDevices(
  members: readonly SidebarProjectGroupMember[],
  primaryEnvironmentId: EnvironmentId | null,
): ProjectDevicePresence[] {
  const seen = new Set<string>();
  const devices: ProjectDevicePresence[] = [];
  const ordered = members.toSorted(
    (left, right) =>
      Number(right.environmentId === primaryEnvironmentId) -
      Number(left.environmentId === primaryEnvironmentId),
  );
  for (const member of ordered) {
    if (seen.has(member.environmentId)) continue;
    seen.add(member.environmentId);
    devices.push({
      environmentId: member.environmentId,
      label: member.environmentId === primaryEnvironmentId ? null : member.environmentLabel,
    });
  }
  return devices;
}

export function threadActivityTimestamp(
  thread: Pick<SidebarThreadSummary, "updatedAt" | "latestUserMessageAt">,
): number {
  return Math.max(
    Date.parse(thread.latestUserMessageAt ?? "") || 0,
    Date.parse(thread.updatedAt ?? "") || 0,
  );
}

const RUNNING_STATUSES = new Set(["working", "connecting", "monitoring"]);

export function isThreadRunning(thread: Parameters<typeof deriveThreadActivityStatus>[0]): boolean {
  return RUNNING_STATUSES.has(deriveThreadActivityStatus(thread));
}

function checkoutKey(environmentId: string, projectId: string): string {
  return `${environmentId}\0${projectId}`;
}

/** List rows in sidebar order, with activity folded in from the thread summaries. */
export function buildProjectListRows(input: {
  readonly snapshots: readonly SidebarProjectSnapshot[];
  readonly threads: readonly ThreadActivityInput[];
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ProjectListRow[] {
  const activityByCheckout = new Map<string, { at: number; running: boolean }>();
  for (const thread of input.threads) {
    if (thread.archivedAt) continue;
    const key = checkoutKey(thread.environmentId, thread.projectId);
    const current = activityByCheckout.get(key) ?? { at: 0, running: false };
    activityByCheckout.set(key, {
      at: Math.max(current.at, threadActivityTimestamp(thread)),
      running: current.running || isThreadRunning(thread),
    });
  }
  return input.snapshots.map((snapshot) => {
    let at = 0;
    let running = false;
    for (const member of snapshot.memberProjects) {
      const activity = activityByCheckout.get(checkoutKey(member.environmentId, member.id));
      if (!activity) continue;
      at = Math.max(at, activity.at);
      running ||= activity.running;
    }
    const repository = projectRepositoryLabel(snapshot.repositoryIdentity);
    const devices = deriveProjectDevices(snapshot.memberProjects, input.primaryEnvironmentId);
    // One fact once: when the name already is the repository, show where it lives.
    const subtitle =
      repository && repository !== snapshot.displayName
        ? repository
        : projectPathTail(snapshot.cwd);
    return {
      key: snapshot.projectKey,
      snapshot,
      name: snapshot.displayName,
      subtitle,
      devices,
      lastActivityAt: at > 0 ? at : null,
      running,
      searchText: [
        snapshot.displayName,
        repository ?? "",
        ...snapshot.memberProjects.flatMap((member) => [member.cwd, member.environmentLabel ?? ""]),
      ]
        .join("\n")
        .toLowerCase(),
    };
  });
}

/** Every whitespace-separated term must appear somewhere in the row. */
export function filterProjectListRows(
  rows: readonly ProjectListRow[],
  query: string,
): readonly ProjectListRow[] {
  const terms = query.trim().toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return rows;
  return rows.filter((row) => terms.every((term) => row.searchText.includes(term)));
}

/** The logical project and member a checkout belongs to. */
export function findProjectCheckout(
  snapshots: readonly SidebarProjectSnapshot[],
  environmentId: string,
  projectId: string,
): {
  readonly snapshot: SidebarProjectSnapshot;
  readonly member: SidebarProjectGroupMember;
} | null {
  for (const snapshot of snapshots) {
    const member = snapshot.memberProjects.find(
      (candidate) => candidate.environmentId === environmentId && candidate.id === projectId,
    );
    if (member) return { snapshot, member };
  }
  return null;
}

/**
 * Devices this client knows that do not have the project, by label, so the
 * page can say where it is missing. The primary device reads "This device".
 */
export function devicesWithoutProject(input: {
  readonly knownDevices: ReadonlyArray<{ readonly environmentId: string; readonly label: string }>;
  readonly projectEnvironmentIds: ReadonlySet<string>;
}): string[] {
  const seen = new Set<string>();
  const labels: string[] = [];
  for (const device of input.knownDevices) {
    if (input.projectEnvironmentIds.has(device.environmentId) || seen.has(device.environmentId)) {
      continue;
    }
    seen.add(device.environmentId);
    labels.push(device.label);
  }
  return labels;
}

/** Direction of travel between two list positions: -1 up, 1 down, 0 none. */
export function projectMotionDirection(previousIndex: number, nextIndex: number): -1 | 0 | 1 {
  if (previousIndex < 0 || nextIndex < 0 || previousIndex === nextIndex) return 0;
  return nextIndex > previousIndex ? 1 : -1;
}

/**
 * How reachable an environment is right now, from this client:
 * - "online": its live snapshot is in;
 * - "connecting": a connection is starting or retrying;
 * - "cached": only a cached copy (Hub metadata) is shown — read-only;
 * - "offline": its connection dropped or failed.
 */
export type EnvironmentPresenceStatus = "online" | "connecting" | "cached" | "offline";

export function classifyEnvironmentPresence(input: {
  readonly isPrimary: boolean;
  /** The environment's live shell snapshot has arrived. */
  readonly bootstrapComplete: boolean;
  /** Its rows came from a cache (Hub metadata) rather than a live snapshot. */
  readonly hydratedFromCache: boolean;
  /** Saved-environment / Hub machine connection state; null when none applies. */
  readonly connectionState: string | null;
  /** Set once a connection was made and lost (or the machine is known offline). */
  readonly disconnectedAt: string | null;
}): EnvironmentPresenceStatus {
  const live = input.isPrimary || input.connectionState === "connected";
  if (live) return input.bootstrapComplete ? "online" : "connecting";
  if (input.connectionState === "connecting") return "connecting";
  const lost =
    input.connectionState === "error" ||
    (input.connectionState === "disconnected" && input.disconnectedAt !== null);
  if (lost || input.hydratedFromCache) return input.hydratedFromCache ? "cached" : "offline";
  return input.bootstrapComplete ? "online" : "connecting";
}
