import type { DraftWorktreeSource } from "@ryco/client-runtime/state/composer";
import { nextTaskBranchName, taskBranchSlug } from "@ryco/client-runtime/state/tasks";
import {
  PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS,
  type ComposerSourceControlContext,
  type LocalTaskLink,
  type RepositoryIdentity,
  type SourceControlChangeRequestDetail,
  type SourceControlIssueDetail,
} from "@ryco/contracts";
import { normalizeGitRemoteUrl } from "@ryco/shared/git";
import { DateTime } from "effect";

/**
 * The pure half of starting a chat from a task: the draft it opens with
 * (where its worktree comes from, what it is called) and the linked pull
 * requests and issues it attaches. `taskDraft.ts` does the reads and writes
 * around it.
 */

/**
 * The branch a task's next new worktree gets: `task/<slug>` for the task's
 * first, `task/<slug>-<n>` after that, moved on past any branch that exists
 * already or that an earlier start of the task asked for. Chats that ran in
 * an existing checkout asked for no new branch, so they don't count.
 */
export function taskWorktreeBranch(input: {
  readonly title: string;
  readonly startBranches: ReadonlyArray<string>;
  readonly existingRefNames: ReadonlyArray<string>;
}): string {
  return nextTaskBranchName({
    slug: taskBranchSlug(input.title),
    delegationCount: input.startBranches.length,
    existingRefNames: [...input.existingRefNames, ...input.startBranches],
  });
}

/** The local branch names a ref listing holds, remote refs without their remote. */
export function localRefNames(
  refs: ReadonlyArray<{
    readonly name: string;
    readonly isRemote?: boolean | undefined;
    readonly remoteName?: string | undefined;
  }>,
): string[] {
  return refs.map((ref) => {
    const prefix = ref.isRemote && ref.remoteName ? `${ref.remoteName}/` : null;
    return prefix && ref.name.startsWith(prefix) ? ref.name.slice(prefix.length) : ref.name;
  });
}

/** The path a pull/merge request or issue adds to its repository's URL, on every host the app links. */
const CHANGE_REQUEST_URL_PATH =
  /\/(?:-\/)?(?:merge_requests|pulls?|pullrequest|issues)\/\d+(?:[/?#].*)?$/i;

/**
 * The repository a pull request or issue URL belongs to, named the way
 * `normalizeGitRemoteUrl` names a remote (`github.com/owner/repo`); `null`
 * for a URL of no known shape.
 */
export function changeRequestRepositoryKey(url: string): string | null {
  const match = CHANGE_REQUEST_URL_PATH.exec(url);
  return match ? normalizeGitRemoteUrl(url.slice(0, match.index)) : null;
}

/**
 * The repository the project's pull requests and issues live in: its primary
 * remote's (`upstream`, else `origin`), the one a number resolves in. `null`
 * while the project's repository is unknown.
 */
export function projectRepositoryKey(
  identity: RepositoryIdentity | null | undefined,
): string | null {
  return identity?.canonicalKey ?? null;
}

/**
 * Whether a linked pull request or issue is the project's own, so its number
 * names it there: one linked by number is, one linked by URL is when the URL
 * is in the project's repository. Another repository's #N is a different item
 * (or none) in this checkout.
 */
export function isProjectChangeRequestLink(
  link: { readonly url?: string | undefined },
  repositoryKey: string | null,
): boolean {
  if (link.url === undefined) return true;
  return repositoryKey !== null && changeRequestRepositoryKey(link.url) === repositoryKey;
}

/** Where a task's draft creates its worktree. The user can change all of it in the draft. */
export interface TaskDraftPlacement {
  /** A pull request, issue or Jira item the worktree is created for; the node names its branch. */
  readonly worktreeSource: DraftWorktreeSource | null;
  /** The branch a new worktree branches from; `null` for the default branch (or with a source). */
  readonly baseBranch: string | null;
  /** The new worktree's branch; `null` when a source names it. */
  readonly worktreeBranchName: string | null;
  /**
   * Whether the new worktree starts from the origin's copy (fetched first). A linked branch is
   * taken as it is in the checkout, which may have commits (or be a branch) not pushed yet.
   */
  readonly fetchOrigin: boolean;
}

export interface TaskDraftPlacementInput {
  readonly title: string;
  readonly links: ReadonlyArray<LocalTaskLink>;
  /** The project's repository (`projectRepositoryKey`); another repository's item has no worktree here. */
  readonly projectRepository: string | null;
  /** The branches the task's earlier starts asked for (new worktrees only). */
  readonly startBranches: ReadonlyArray<string>;
  /** The node can create a worktree for a pull request, issue or Jira item. */
  readonly sourceWorktrees: boolean;
}

const withTitle = (prefix: string, title: string | undefined) =>
  title ? `${prefix} ${title}` : prefix;

/**
 * The worktree a task's draft opens with, the way the new-thread picker would
 * set it: the task's first pull request of the project, else a new branch
 * from its first linked branch, else a worktree for its first issue of the
 * project or Jira item, else a new `task/<slug>` branch from the default
 * branch. A source's title is the one it was linked with, the task's own
 * when it has none (the node names an issue's branch after it).
 */
export function taskDraftPlacement(input: TaskDraftPlacementInput): TaskDraftPlacement {
  const newBranch = () =>
    taskWorktreeBranch({
      title: input.title,
      startBranches: input.startBranches,
      existingRefNames: [],
    });
  const ownItem = (link: { readonly url?: string | undefined }) =>
    isProjectChangeRequestLink(link, input.projectRepository);
  const pr = input.sourceWorktrees
    ? input.links.find(
        (link): link is Extract<LocalTaskLink, { kind: "pr" }> =>
          link.kind === "pr" && ownItem(link),
      )
    : undefined;
  if (pr) {
    return {
      worktreeSource: {
        kind: "pr",
        number: pr.number,
        label: withTitle(`#${pr.number}`, pr.title),
      },
      baseBranch: null,
      worktreeBranchName: null,
      fetchOrigin: true,
    };
  }
  const branch = input.links.find(
    (link): link is Extract<LocalTaskLink, { kind: "branch" }> => link.kind === "branch",
  );
  if (branch)
    return {
      worktreeSource: null,
      baseBranch: branch.name,
      worktreeBranchName: newBranch(),
      fetchOrigin: false,
    };
  if (input.sourceWorktrees) {
    for (const link of input.links) {
      if (link.kind === "issue" && ownItem(link)) {
        const title = link.title ?? input.title;
        return {
          worktreeSource: {
            kind: "issue",
            number: link.number,
            title,
            label: withTitle(`#${link.number}`, title),
          },
          baseBranch: null,
          worktreeBranchName: null,
          fetchOrigin: true,
        };
      }
      if (link.kind === "workItem") {
        const title = link.title ?? input.title;
        return {
          worktreeSource: {
            kind: "workItem",
            provider: link.provider,
            key: link.key,
            title,
            ...(link.url ? { url: link.url } : {}),
            label: withTitle(link.key, title),
          },
          baseBranch: null,
          worktreeBranchName: null,
          fetchOrigin: true,
        };
      }
    }
  }
  return {
    worktreeSource: null,
    baseBranch: null,
    worktreeBranchName: newBranch(),
    fetchOrigin: true,
  };
}

/** The words beside Start: `in ${prefix}`, then `ref` in mono when there is one. */
export interface TaskStartHint {
  readonly prefix: string;
  readonly ref: string | null;
}

export function taskStartHint(placement: TaskDraftPlacement): TaskStartHint {
  const source = placement.worktreeSource;
  if (source?.kind === "pr") return { prefix: `the PR #${source.number} worktree`, ref: null };
  if (source?.kind === "issue") return { prefix: `a worktree for #${source.number}`, ref: null };
  if (source?.kind === "workItem") return { prefix: `a worktree for ${source.key}`, ref: null };
  if (placement.baseBranch)
    return {
      prefix: `a worktree from ${placement.baseBranch}`,
      ref: placement.worktreeBranchName,
    };
  return { prefix: "a new worktree", ref: placement.worktreeBranchName };
}

/** How long attached detail counts as fresh, the composer's `#` picker window. */
const SOURCE_CONTROL_CONTEXT_FRESH_MS = 5 * 60 * 1000;

/** A linked pull request or issue as the draft's attached context, the way the composer attaches it. */
export function taskSourceControlContext(input: {
  readonly id: string;
  readonly kind: ComposerSourceControlContext["kind"];
  readonly detail: SourceControlIssueDetail | SourceControlChangeRequestDetail;
  readonly nowMs: number;
}): ComposerSourceControlContext {
  return {
    id: input.id,
    kind: input.kind,
    provider: input.detail.provider,
    reference: `${input.detail.provider}#${input.detail.number}`,
    detail: input.detail,
    fetchedAt: DateTime.fromDateUnsafe(new Date(input.nowMs)),
    staleAfter: DateTime.fromDateUnsafe(new Date(input.nowMs + SOURCE_CONTROL_CONTEXT_FRESH_MS)),
  };
}

/**
 * The project's own pull requests and issues a task links to, the ones whose
 * detail its draft attaches (read by URL when the link has one). Another
 * repository's items stay in the message as links: attached context is
 * refreshed by its number in the project's checkout, which would read the
 * project's item of that number instead.
 */
export function taskSourceControlLinks(
  links: ReadonlyArray<LocalTaskLink>,
  projectRepository: string | null,
): ReadonlyArray<{
  readonly kind: ComposerSourceControlContext["kind"];
  readonly number: number;
  readonly reference: string;
}> {
  const picked: Array<{
    kind: ComposerSourceControlContext["kind"];
    number: number;
    reference: string;
  }> = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (link.kind !== "pr" && link.kind !== "issue") continue;
    if (!isProjectChangeRequestLink(link, projectRepository)) continue;
    const kind = link.kind === "pr" ? "change-request" : "issue";
    const key = `${kind}:${link.number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    picked.push({ kind, number: link.number, reference: link.url ?? String(link.number) });
    if (picked.length === PROVIDER_SEND_TURN_MAX_SOURCE_CONTROL_CONTEXTS) break;
  }
  return picked;
}
