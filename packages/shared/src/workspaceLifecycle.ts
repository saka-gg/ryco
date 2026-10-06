import type {
  LifecycleSuggestionPolicy,
  ServerSettings,
  WorkspaceLifecycleAction,
  WorkspaceLifecycleEffects,
} from "@ryco/contracts";
import { DEFAULT_LIFECYCLE_SUGGESTION_POLICY } from "@ryco/contracts";

const DAY_MS = 86_400_000;

export function resolveLifecycleSuggestionPolicy(
  settings: Partial<Pick<ServerSettings, "lifecycleSuggestions" | "projectLifecycleSuggestions">>,
  projectId: string | null,
): LifecycleSuggestionPolicy {
  return (
    (projectId ? settings.projectLifecycleSuggestions?.[projectId] : null) ??
    settings.lifecycleSuggestions ??
    DEFAULT_LIFECYCLE_SUGGESTION_POLICY
  );
}

/**
 * Directories whose whole content a package manager, compiler or test runner
 * regenerates. Everything else that Git ignores is protected: credentials, local
 * databases, user outputs and unknown content are never discarded implicitly.
 */
const REGENERABLE_DIRECTORIES: ReadonlySet<string> = new Set([
  "node_modules",
  ".turbo",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".parcel-cache",
  ".vite",
  ".angular",
  ".expo",
  ".cache",
  ".eslintcache",
  "dist",
  "build",
  "target",
  "coverage",
  ".nyc_output",
  "storybook-static",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  ".gradle",
  ".dart_tool",
  "DerivedData",
]);

const REGENERABLE_FILES = [/\.tsbuildinfo$/, /\.py[cod]$/, /^\.DS_Store$/, /^\.eslintcache$/];

/** Never regenerable, even inside a cache directory. */
const SENSITIVE_FILES = [
  /^\.env(\..*)?$/i,
  /\.(pem|key|p12|pfx|keystore|jks|kdbx)$/i,
  /\.(sqlite3?|db|db3)(-wal|-shm|-journal)?$/i,
  /^id_(rsa|ed25519|ecdsa|dsa)(\.pub)?$/i,
  /^(credentials|secrets?)(\..*)?$/i,
  /^\.(npmrc|pypirc|netrc|git-credentials)$/i,
];

export type IgnoredPathClass = "regenerable" | "protected";

/** Classifies one `git status --ignored` entry (directories end with `/`). */
export function classifyIgnoredPath(entry: string): IgnoredPathClass {
  const normalized = entry.replace(/\\/g, "/");
  const isDirectory = normalized.endsWith("/");
  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0 || segments.some((segment) => segment === "..")) return "protected";
  const leaf = segments.at(-1)!;
  if (!isDirectory && SENSITIVE_FILES.some((pattern) => pattern.test(leaf))) return "protected";
  if (segments.some((segment) => REGENERABLE_DIRECTORIES.has(segment))) return "regenerable";
  if (!isDirectory && REGENERABLE_FILES.some((pattern) => pattern.test(leaf))) return "regenerable";
  return "protected";
}

export interface ParsedWorktreeStatus {
  readonly modified: number;
  readonly untracked: number;
  readonly protectedIgnored: readonly string[];
  readonly regenerableIgnored: readonly string[];
}

/** Parses `git status --porcelain=v1 -z --ignored` output. */
export function parseWorktreeStatus(output: string): ParsedWorktreeStatus {
  const fields = output.split("\0");
  let modified = 0;
  let untracked = 0;
  const protectedIgnored: string[] = [];
  const regenerableIgnored: string[] = [];
  for (let index = 0; index < fields.length; index++) {
    const field = fields[index]!;
    if (field.length < 4) continue;
    const code = field.slice(0, 2);
    const entry = field.slice(3);
    if (code === "??") untracked++;
    else if (code === "!!") {
      (classifyIgnoredPath(entry) === "regenerable" ? regenerableIgnored : protectedIgnored).push(
        entry,
      );
    } else {
      modified++;
      // Renames and copies carry their source path in the next field.
      if (code[0] === "R" || code[0] === "C") index++;
    }
  }
  return { modified, untracked, protectedIgnored, regenerableIgnored };
}

/** Structural shape shared by server read models and client shells. */
export interface LifecycleThreadLike {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt?: string | null | undefined;
  readonly worktreeId?: string | null | undefined;
  readonly worktreePath: string | null;
  readonly latestUserMessageAt?: string | null | undefined;
  readonly session: {
    readonly status: string;
    readonly activeTurnId?: string | null | undefined;
  } | null;
  readonly latestTurn: {
    readonly state: string;
    readonly completedAt?: string | null | undefined;
  } | null;
  readonly backgroundLiveness?: string | null | undefined;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly hasActionableProposedPlan?: boolean | undefined;
  readonly goal?: { readonly status: string } | null | undefined;
  readonly snoozedUntil?: string | null | undefined;
  readonly usageLimit?: unknown;
}

/**
 * Work that makes a conversation unsafe to archive automatically or to lose its
 * checkout: running or queued turns, background work, requests waiting on the
 * user, deferred work and unfinished goals.
 */
export function threadPendingWork(thread: LifecycleThreadLike, nowMs: number): string[] {
  const reasons: string[] = [];
  const status = thread.session?.status;
  if (status === "running" || status === "starting" || thread.session?.activeTurnId != null)
    reasons.push("a turn is running");
  else if (thread.latestTurn?.state === "running") reasons.push("a turn is still settling");
  if (thread.backgroundLiveness) reasons.push("background work is still running");
  if (thread.hasPendingApprovals) reasons.push("an approval is pending");
  if (thread.hasPendingUserInput) reasons.push("a question is waiting for an answer");
  if (thread.hasActionableProposedPlan) reasons.push("a proposed plan is waiting");
  if (thread.goal && thread.goal.status !== "complete") reasons.push("its goal is unfinished");
  if (Date.parse(thread.snoozedUntil ?? "") > nowMs) reasons.push("it is snoozed");
  if (thread.usageLimit != null) reasons.push("it is waiting for a usage limit to reset");
  return reasons;
}

function latestActivityAt(thread: LifecycleThreadLike): string {
  let latest = thread.updatedAt;
  for (const candidate of [thread.latestUserMessageAt, thread.latestTurn?.completedAt]) {
    if (candidate && Date.parse(candidate) > Date.parse(latest)) latest = candidate;
  }
  return latest;
}

export interface LifecycleWorktreeLike {
  readonly worktreeId: string;
  readonly projectId: string;
  readonly title?: string | null | undefined;
  readonly branch: string;
  readonly worktreePath: string | null;
  readonly origin: string;
  readonly checkoutRemovedAt?: string | null | undefined;
}

export function threadBelongsToWorktree(
  thread: Pick<LifecycleThreadLike, "projectId" | "worktreeId" | "worktreePath">,
  worktree: Pick<LifecycleWorktreeLike, "projectId" | "worktreeId" | "worktreePath">,
  samePath: (left: string, right: string) => boolean,
): boolean {
  if (thread.projectId !== worktree.projectId) return false;
  if (thread.worktreeId != null) return thread.worktreeId === worktree.worktreeId;
  return (
    worktree.worktreePath !== null &&
    thread.worktreePath !== null &&
    samePath(thread.worktreePath, worktree.worktreePath)
  );
}

export interface LifecycleSuggestionPlan {
  readonly threads: ReadonlyArray<{
    readonly threadId: string;
    readonly projectId: string;
    readonly title: string;
    readonly lastActivityAt: string;
  }>;
  readonly checkouts: ReadonlyArray<{
    readonly worktreeId: string;
    readonly projectId: string;
    readonly title: string;
    readonly branch: string;
    readonly archivedSince: string;
    readonly conversations: number;
  }>;
}

/**
 * Candidates only: a suggestion is shown for approval and every action still runs
 * the full preflight. Excluded threads (pinned, live terminals) block both kinds.
 */
export function planLifecycleSuggestions(input: {
  readonly threads: ReadonlyArray<LifecycleThreadLike>;
  readonly worktrees: ReadonlyArray<LifecycleWorktreeLike>;
  readonly projectRoots: ReadonlyMap<string, string>;
  readonly policyFor: (projectId: string) => LifecycleSuggestionPolicy;
  readonly excludedThreadIds: ReadonlySet<string>;
  readonly samePath: (left: string, right: string) => boolean;
  readonly nowMs: number;
  readonly limit?: number;
}): LifecycleSuggestionPlan {
  const limit = input.limit ?? 50;
  const live = input.threads.filter((thread) => thread.deletedAt == null);
  const threads = live
    .flatMap((thread) => {
      const days = input.policyFor(thread.projectId).archiveInactiveThreadsDays;
      if (
        days === null ||
        thread.archivedAt !== null ||
        !thread.latestUserMessageAt ||
        input.excludedThreadIds.has(thread.id) ||
        threadPendingWork(thread, input.nowMs).length > 0
      )
        return [];
      const lastActivityAt = latestActivityAt(thread);
      if (input.nowMs - Date.parse(lastActivityAt) < days * DAY_MS) return [];
      return [
        { threadId: thread.id, projectId: thread.projectId, title: thread.title, lastActivityAt },
      ];
    })
    .toSorted((left, right) => left.lastActivityAt.localeCompare(right.lastActivityAt))
    .slice(0, limit);

  const checkouts = input.worktrees
    .flatMap((worktree) => {
      const days = input.policyFor(worktree.projectId).removeArchivedCheckoutsDays;
      const root = input.projectRoots.get(worktree.projectId);
      if (
        days === null ||
        worktree.origin === "main" ||
        worktree.worktreePath === null ||
        worktree.checkoutRemovedAt != null ||
        root === undefined ||
        input.samePath(worktree.worktreePath, root)
      )
        return [];
      const associated = live.filter((thread) =>
        threadBelongsToWorktree(thread, worktree, input.samePath),
      );
      if (
        associated.length === 0 ||
        associated.some(
          (thread) =>
            thread.archivedAt === null ||
            input.excludedThreadIds.has(thread.id) ||
            threadPendingWork(thread, input.nowMs).length > 0,
        )
      )
        return [];
      const archivedSince = associated
        .map((thread) => thread.archivedAt!)
        .toSorted()
        .at(-1)!;
      if (input.nowMs - Date.parse(archivedSince) < days * DAY_MS) return [];
      return [
        {
          worktreeId: worktree.worktreeId,
          projectId: worktree.projectId,
          title: worktree.title ?? worktree.branch,
          branch: worktree.branch,
          archivedSince,
          conversations: associated.length,
        },
      ];
    })
    .toSorted((left, right) => left.archivedSince.localeCompare(right.archivedSince))
    .slice(0, limit);

  return { threads, checkouts };
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/** The exact one-line effect shown before confirming a workspace action. */
export function summarizeWorkspaceLifecycleEffects(
  action: WorkspaceLifecycleAction,
  effects: WorkspaceLifecycleEffects,
): string {
  const archived = effects.archiveConversationIds.length;
  const conversations =
    archived > 0
      ? `archive ${plural(archived, "conversation")}`
      : "leave conversations as they are";
  const branch = effects.deleteBranch
    ? `keep history, delete merged branch ${effects.branch}`
    : "keep history and branch";
  switch (action) {
    case "archive":
      return "Archive 1 workspace. Its checkout, branch and conversations stay as they are.";
    case "restore":
      return "Restore 1 workspace. Its checkout, branch and conversations stay as they are.";
    case "remove-checkout":
      return effects.removeCheckout
        ? `Remove 1 checkout, ${conversations}, ${branch}.`
        : `Record 1 already-removed checkout, ${conversations}, ${branch}.`;
    case "remove-stale-record":
      return `Record 1 missing checkout as removed, ${conversations}, ${branch}.`;
    case "recreate-checkout":
      return `Recreate 1 checkout on branch ${effects.branch}. Conversations stay as they are.`;
  }
}
