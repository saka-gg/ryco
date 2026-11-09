// What New Task can start from besides the project's checkout: a branch (a new worktree from it),
// or a pull request, issue or Jira item (a worktree the node makes for it, whose thread the task
// then starts in). The labels and the node's intent are web's (`worktreeSource.ts`).
import {
  issueWorktreeSource,
  pullRequestWorktreeSource,
  workItemWorktreeSource,
  type DraftWorktreeSource,
} from "@ryco/client-runtime/state/composer";
import type {
  ChangeRequest,
  SourceControlIssueSummary,
  VcsRef,
  WorkItemSummary,
} from "@ryco/contracts";

export type NewTaskSourceKind = "branch" | "pr" | "issue" | "workItem";

export const NEW_TASK_SOURCE_KINDS: ReadonlyArray<{
  readonly kind: NewTaskSourceKind;
  readonly label: string;
  readonly icon: string;
  readonly searchPlaceholder: string;
}> = [
  { kind: "branch", label: "Branch", icon: "arrow.triangle.branch", searchPlaceholder: "Branches" },
  {
    kind: "pr",
    label: "Pull request",
    icon: "arrow.triangle.pull",
    searchPlaceholder: "Open pull requests",
  },
  {
    kind: "issue",
    label: "Issue",
    icon: "smallcircle.filled.circle",
    searchPlaceholder: "Open issues",
  },
  { kind: "workItem", label: "Jira", icon: "checklist", searchPlaceholder: "Jira items" },
];

/** One row of a source list: what it shows, and what picking it does. */
export type NewTaskSourceRow =
  | {
      readonly kind: "branch";
      readonly key: string;
      readonly title: string;
      readonly detail: string | null;
      readonly branch: string;
    }
  | {
      readonly kind: "source";
      readonly key: string;
      readonly title: string;
      readonly detail: string | null;
      readonly source: DraftWorktreeSource;
    };

/**
 * Branches to start a worktree from: local ones first (the default marked), then remote ones
 * no local branch already tracks, each name once.
 */
export function branchSourceRows(refs: ReadonlyArray<VcsRef>): NewTaskSourceRow[] {
  const local = refs.filter((ref) => ref.isRemote !== true);
  const localNames = new Set(local.map((ref) => ref.name));
  const remote = refs.filter((ref) => {
    if (ref.isRemote !== true) return false;
    const prefix = ref.remoteName ? `${ref.remoteName}/` : "";
    const short = prefix && ref.name.startsWith(prefix) ? ref.name.slice(prefix.length) : ref.name;
    return short !== "HEAD" && !localNames.has(short);
  });
  const seen = new Set<string>();
  const rows: NewTaskSourceRow[] = [];
  for (const ref of [...local, ...remote]) {
    if (seen.has(ref.name)) continue;
    seen.add(ref.name);
    rows.push({
      kind: "branch",
      key: `branch:${ref.name}`,
      title: ref.name,
      detail: ref.isDefault ? "Default branch" : ref.current ? "Checked out" : null,
      branch: ref.name,
    });
  }
  return rows;
}

export function pullRequestSourceRows(pulls: ReadonlyArray<ChangeRequest>): NewTaskSourceRow[] {
  return pulls.map((pull) => ({
    kind: "source",
    key: `pr:${pull.number}`,
    title: `#${pull.number} ${pull.title}`,
    detail: `${pull.headRefName} → ${pull.baseRefName}${pull.isDraft ? " · Draft" : ""}`,
    source: pullRequestWorktreeSource(pull.number, pull.title),
  }));
}

export function issueSourceRows(
  issues: ReadonlyArray<SourceControlIssueSummary>,
): NewTaskSourceRow[] {
  return issues.map((issue) => ({
    kind: "source",
    key: `issue:${issue.number}`,
    title: `#${issue.number} ${issue.title}`,
    detail: issue.author ? `by ${issue.author}` : null,
    source: issueWorktreeSource(issue),
  }));
}

export function workItemSourceRows(items: ReadonlyArray<WorkItemSummary>): NewTaskSourceRow[] {
  return items.map((item) => ({
    kind: "source",
    key: `workItem:${item.key}`,
    title: `${item.key} ${item.title}`,
    detail: item.stateName ?? null,
    source: workItemWorktreeSource({
      provider: item.provider,
      key: item.key,
      title: item.title,
      state: item.state,
      stateName: item.stateName,
      url: item.url,
    }),
  }));
}

/** Rows whose title contains every word of `query` (case-insensitive); all of them for none. */
export function filterSourceRows(
  rows: ReadonlyArray<NewTaskSourceRow>,
  query: string,
): NewTaskSourceRow[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return [...rows];
  return rows.filter((row) => {
    const title = row.title.toLowerCase();
    return words.every((word) => title.includes(word));
  });
}

/** The New Task location line for a picked source: "Worktree for #42 Fix CI". */
export function sourceLocationLabel(source: DraftWorktreeSource): string {
  return `Worktree for ${source.label}`;
}
