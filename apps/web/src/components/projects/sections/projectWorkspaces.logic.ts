import type { WorkspaceActionId } from "@ryco/client-runtime/state/lifecycle";
import type {
  LifecycleSuggestions,
  WorkspaceLifecycleAction,
  WorkspaceLifecycleSummary,
} from "@ryco/contracts";

/** Row menu order: hide/show first, then the checkout changes, removal last. */
export const WORKSPACE_MENU_ACTIONS: readonly WorkspaceLifecycleAction[] = [
  "archive",
  "restore",
  "recreate-checkout",
  "remove-stale-record",
  "remove-checkout",
];

/**
 * The actions the server's inspection allows right now, in menu order, with
 * "Delete workspace" last when the node can delete it.
 */
export function availableWorkspaceActions(
  summary: WorkspaceLifecycleSummary | null | undefined,
): WorkspaceActionId[] {
  if (!summary) return [];
  const actions: WorkspaceActionId[] = WORKSPACE_MENU_ACTIONS.filter(
    (action) => summary.actions.find((entry) => entry.action === action)?.available === true,
  );
  if (summary.discardBlockers?.length === 0) actions.push("delete-workspace");
  return actions;
}

export interface WorkspaceFact {
  readonly label: string;
  /** `warning`: something the reader should know before changing the checkout. */
  readonly tone: "muted" | "warning";
  /** The long form, for a tooltip. */
  readonly detail?: string;
}

const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? "" : "s"}`;

/**
 * What the inspection found, as short facts stated once. A clean, present,
 * merged checkout has none: the row stays quiet unless something needs care.
 */
export function workspaceFacts(summary: WorkspaceLifecycleSummary): WorkspaceFact[] {
  const facts: WorkspaceFact[] = [];
  switch (summary.checkout) {
    case "removed":
      facts.push({
        label: "Checkout removed",
        tone: "muted",
        detail: "The directory is gone; the branch and every conversation are kept.",
      });
      break;
    case "missing":
      facts.push({
        label: "Checkout missing",
        tone: "warning",
        detail: "The directory no longer exists on disk.",
      });
      break;
    case "unavailable":
      facts.push({
        label: "Not verifiable",
        tone: "warning",
        detail: "Git could not inspect this checkout.",
      });
      break;
    case "present":
      break;
  }
  const changes = summary.checkout === "present" ? summary.changes : null;
  if (changes) {
    if (changes.truncated) {
      facts.push({ label: "Many uncommitted changes", tone: "warning" });
    } else {
      const parts = [
        changes.modified > 0 ? `${changes.modified} modified` : null,
        changes.untracked > 0 ? `${changes.untracked} untracked` : null,
      ].filter((part): part is string => part !== null);
      if (parts.length > 0) facts.push({ label: parts.join(", "), tone: "warning" });
    }
    if (changes.protectedIgnored > 0) {
      facts.push({
        label: plural(changes.protectedIgnored, "ignored file"),
        tone: "warning",
        detail: `Ignored files that are not caches, e.g. ${changes.protectedIgnoredSample.join(", ")}`,
      });
    }
  }
  if (!summary.main && summary.unmerged === true) {
    facts.push({ label: "Unmerged commits", tone: "warning" });
  }
  if (summary.activeWork.length > 0) {
    facts.push({ label: "In use", tone: "warning", detail: summary.activeWork.join("; ") });
  }
  return facts;
}

/**
 * The server inspection that belongs to a sidebar worktree row. The main
 * checkout may be synthesized locally (no registered id), so it matches the
 * inspected main record instead.
 */
export function findWorkspaceSummary(
  summaries: readonly WorkspaceLifecycleSummary[],
  row: { readonly worktreeId: string; readonly main: boolean },
): WorkspaceLifecycleSummary | null {
  return (
    summaries.find((summary) => summary.worktreeId === row.worktreeId) ??
    (row.main ? (summaries.find((summary) => summary.main) ?? null) : null)
  );
}

/** Registered workspaces the local tree does not show (never the main checkout). */
export function unlistedWorkspaces(
  summaries: readonly WorkspaceLifecycleSummary[],
  listedIds: ReadonlySet<string>,
): WorkspaceLifecycleSummary[] {
  return summaries.filter((summary) => !summary.main && !listedIds.has(summary.worktreeId));
}

/** A project's share of the device-wide suggestions. */
export function projectSuggestions(
  suggestions: LifecycleSuggestions,
  projectId: string,
): LifecycleSuggestions {
  return {
    ...suggestions,
    threads: suggestions.threads.filter((thread) => thread.projectId === projectId),
    checkouts: suggestions.checkouts.filter((checkout) => checkout.projectId === projectId),
  };
}

/**
 * Pinned threads are never suggested for archiving. A pinned thread also keeps its
 * workspace's checkout out of removal suggestions, mirroring the server's exclusion
 * of threads with live terminals (pinning is client-side, so the client applies it).
 */
export function excludePinnedSuggestions(
  suggestions: LifecycleSuggestions,
  isPinned: (threadId: string) => boolean,
  pinnedWorktreeIds: ReadonlySet<string> = new Set(),
): LifecycleSuggestions {
  return {
    ...suggestions,
    threads: suggestions.threads.filter((thread) => !isPinned(thread.threadId)),
    checkouts: suggestions.checkouts.filter(
      (checkout) => !pinnedWorktreeIds.has(checkout.worktreeId),
    ),
  };
}

/**
 * What re-inspection keys on: the checkout's set of workspaces and their
 * lifecycle fields. Thread activity does not re-run Git.
 */
export function workspaceInspectionSignature(
  worktrees: ReadonlyArray<{
    readonly id: string;
    readonly branch: string;
    readonly worktreePath: string | null;
    readonly archivedAt?: string | null | undefined;
    readonly checkoutRemovedAt?: string | null | undefined;
  }>,
): string {
  return worktrees
    .map((worktree) =>
      [
        worktree.id,
        worktree.branch,
        worktree.worktreePath ?? "",
        worktree.archivedAt ?? "",
        worktree.checkoutRemovedAt ?? "",
      ].join("\u0001"),
    )
    .toSorted()
    .join("\u0000");
}
