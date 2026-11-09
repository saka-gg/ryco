import { comparisonBlameSides } from "@ryco/client-runtime/state/comparison";
import type { LineBlameTarget } from "@ryco/client-runtime/state/comparison/lineBlame";
import type {
  GitComparisonSource,
  GitLocalChangesResult,
  GitLocalChangesScope,
  GitStackedAction,
  VcsRef,
  VcsStatusResult,
} from "@ryco/contracts";
import { dedupeRemoteBranchesWithLocalMatches } from "@ryco/shared/git";

import {
  parsePullRequestDiffRows,
  readPatchFilesInOrder,
  type PullRequestDiffRow,
  type PullRequestPatchFile,
} from "../pullRequests/pullRequestDiffModel";

/**
 * The phone's Git tools, without React: which branches a checkout can switch
 * to, the commit choices its state allows, its staged and unstaged changes as
 * files and hunks, and what line blame can attribute in a comparison.
 */

// ---------------------------------------------------------------------------
// Checkout
// ---------------------------------------------------------------------------

/**
 * The folder a Git screen acts on. A route that names a worktree acts on that
 * worktree or on nothing: while the worktree is not known (not loaded yet,
 * after a reconnect, archived) it must never fall back to the project's main
 * checkout, or a commit, branch switch or note meant for the worktree would
 * land on main.
 */
export function resolveCheckoutCwd(input: {
  readonly worktreeId: string | null;
  readonly worktree: { readonly worktreePath: string | null } | null;
  readonly project: { readonly cwd: string } | null;
}): string | null {
  if (input.worktreeId !== null) return input.worktree?.worktreePath ?? null;
  return input.project?.cwd ?? null;
}

// ---------------------------------------------------------------------------
// Branches
// ---------------------------------------------------------------------------

export interface BranchRow {
  readonly key: string;
  readonly ref: VcsRef;
  readonly label: string;
  readonly detail: string;
  readonly current: boolean;
  /** Why the row cannot be switched to here; null when it can. */
  readonly disabledReason: string | null;
}

export interface BranchSections {
  readonly local: ReadonlyArray<BranchRow>;
  readonly remote: ReadonlyArray<BranchRow>;
}

function branchRow(ref: VcsRef, cwd: string): BranchRow {
  const elsewhere = ref.worktreePath !== null && ref.worktreePath !== cwd && !ref.current;
  const details: string[] = [];
  if (ref.current) details.push("Current");
  if (ref.isDefault) details.push("Default");
  if (ref.isRemote && ref.remoteName) details.push(ref.remoteName);
  if (elsewhere) details.push("Checked out in another worktree");
  return {
    key: `${ref.isRemote ? "remote" : "local"}:${ref.name}`,
    ref,
    label: ref.name,
    detail: details.join(" · ") || (ref.isRemote ? "Remote branch" : "Local branch"),
    current: ref.current,
    disabledReason: elsewhere ? "Checked out in another worktree" : null,
  };
}

/** Local branches first (current, then default, then by name), remote ones without a local twin. */
export function buildBranchSections(refs: ReadonlyArray<VcsRef>, cwd: string): BranchSections {
  const visible = dedupeRemoteBranchesWithLocalMatches(refs);
  const rank = (ref: VcsRef) => (ref.current ? 0 : ref.isDefault ? 1 : 2);
  const local = visible
    .filter((ref) => !ref.isRemote)
    .toSorted((left, right) => rank(left) - rank(right) || left.name.localeCompare(right.name))
    .map((ref) => branchRow(ref, cwd));
  const remote = visible
    .filter((ref) => ref.isRemote === true)
    .toSorted((left, right) => left.name.localeCompare(right.name))
    .map((ref) => branchRow(ref, cwd));
  return { local, remote };
}

// `git check-ref-format --branch`, the rules a person can break by typing.
// eslint-disable-next-line no-control-regex
const FORBIDDEN_BRANCH_CHARACTERS = /[\s~^:?*[\\\x00-\x1f\x7f]/u;

/** Why `name` cannot be a new branch, or null when it can. */
export function branchNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed.length === 0) return "Enter a branch name.";
  if (FORBIDDEN_BRANCH_CHARACTERS.test(trimmed))
    return "Branch names cannot contain spaces or ~ ^ : ? * [ \\.";
  if (
    trimmed.startsWith("-") ||
    trimmed.startsWith("/") ||
    trimmed.endsWith("/") ||
    trimmed.endsWith(".") ||
    trimmed.endsWith(".lock") ||
    trimmed.includes("..") ||
    trimmed.includes("//") ||
    trimmed.includes("@{") ||
    trimmed === "@" ||
    trimmed.split("/").some((part) => part.startsWith("."))
  )
    return "That is not a valid branch name.";
  return null;
}

/** The branch the search would create: valid, and not one that already exists. */
export function branchToCreate(query: string, refs: ReadonlyArray<VcsRef>): string | null {
  const name = query.trim();
  if (branchNameProblem(name) !== null) return null;
  return refs.some((ref) => !ref.isRemote && ref.name === name) ? null : name;
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

export interface CommitChoice {
  readonly action: Extract<GitStackedAction, "commit" | "commit_push" | "commit_push_pr">;
  readonly label: string;
  readonly enabled: boolean;
}

/** What the commit sheet offers for this checkout: commit always, pushing only with a remote. */
export function commitChoices(status: VcsStatusResult | null, mutable: boolean): CommitChoice[] {
  const canCommit = mutable && status?.isRepo === true && status.hasWorkingTreeChanges;
  const canPush = canCommit && status?.hasPrimaryRemote === true;
  const canOpenPr = canPush && status?.pr === null;
  return [
    { action: "commit", label: "Commit", enabled: canCommit },
    { action: "commit_push", label: "Commit & push", enabled: canPush },
    { action: "commit_push_pr", label: "Commit, push & open PR", enabled: canOpenPr },
  ];
}

/** What a fresh checkout needs before Git tools work: Git itself, then a host to push to. */
export type RepositorySetupStep = "initialize" | "publish" | null;

export function repositorySetupStep(status: VcsStatusResult | null): RepositorySetupStep {
  if (!status) return null;
  if (!status.isRepo) return "initialize";
  return status.hasPrimaryRemote ? null : "publish";
}

// ---------------------------------------------------------------------------
// Staged and unstaged changes
// ---------------------------------------------------------------------------

export interface ChangeHunk {
  readonly index: number;
  readonly header: string;
  readonly rows: ReadonlyArray<PullRequestDiffRow>;
}

export interface ChangeFile {
  /** The node's id for staging this file; null when the listing could not be paired. */
  readonly id: string | null;
  readonly file: PullRequestPatchFile;
  readonly hunks: ReadonlyArray<ChangeHunk>;
  /** The whole file can be (un)staged. */
  readonly fileAction: boolean;
  /** Each hunk can be (un)staged on its own. */
  readonly hunkAction: boolean;
}

/** Rows a hunk shows before "Show all" — enough to recognise it on a phone. */
export const CHANGE_HUNK_PREVIEW_ROWS = 60;

function hunksOf(patch: string): ChangeHunk[] {
  const hunks: ChangeHunk[] = [];
  for (const row of parsePullRequestDiffRows(patch).rows) {
    if (row.kind === "hunk") {
      hunks.push({ index: hunks.length, header: row.text, rows: [] });
      continue;
    }
    const current = hunks.at(-1);
    if (current) (current.rows as PullRequestDiffRow[]).push(row);
  }
  return hunks;
}

/**
 * One side of the local review as files and hunks, paired by position with the
 * node's per-file ids (Git lists both in the same order). When the counts
 * disagree nothing is paired, so no action can target the wrong file.
 */
export function buildChangeFiles(
  data: GitLocalChangesResult | null,
  scope: GitLocalChangesScope,
): ChangeFile[] {
  if (!data) return [];
  const side = data[scope];
  const files = readPatchFilesInOrder(side.patch);
  const paired = files.length === side.files.length;
  return files.map((file, index) => {
    const meta = paired ? side.files[index] : undefined;
    const hunks = hunksOf(file.patch);
    return {
      id: meta?.id ?? null,
      file,
      hunks,
      fileAction: meta?.fileAction === true,
      hunkAction: meta?.hunkAction === true && meta.hunkCount === hunks.length,
    };
  });
}

/** Files shown open at first; the rest start collapsed so a large review stays quick. */
export const CHANGE_FILES_OPEN_AT_FIRST = 3;
/** A file changing more lines than this starts collapsed wherever it is. */
export const CHANGE_FILE_OPEN_MAX_LINES = 300;

export function changeFileStartsCollapsed(
  index: number,
  file: Pick<PullRequestPatchFile, "additions" | "deletions" | "binary">,
): boolean {
  return (
    index >= CHANGE_FILES_OPEN_AT_FIRST ||
    file.additions + file.deletions > CHANGE_FILE_OPEN_MAX_LINES
  );
}

export function stageVerb(scope: GitLocalChangesScope): "Stage" | "Unstage" {
  return scope === "staged" ? "Unstage" : "Stage";
}

export function changeCounts(data: GitLocalChangesResult | null): {
  readonly staged: number;
  readonly unstaged: number;
} {
  return {
    staged: data ? readPatchFilesInOrder(data.staged.patch).length : 0,
    unstaged: data ? readPatchFilesInOrder(data.unstaged.patch).length : 0,
  };
}

// ---------------------------------------------------------------------------
// Compare and blame
// ---------------------------------------------------------------------------

/**
 * The committed line a comparison row stands for, in the shared line-blame
 * policy (`displayedBlameTarget`): deletions belong to the base, context lines
 * to the head (to the base against working files, which are no commit), and
 * added lines are deliberately not blamed.
 */
export function blameTargetForRow(
  source: GitComparisonSource,
  file: Pick<PullRequestPatchFile, "path" | "previousPath" | "status">,
  row: PullRequestDiffRow,
): LineBlameTarget | null {
  const basePath = file.previousPath ?? file.path;
  const sides = comparisonBlameSides(source);
  if (row.kind === "deletion" && row.oldLine !== null && file.status !== "added")
    return { side: "base", filePath: basePath, line: row.oldLine };
  if (row.kind !== "context") return null;
  if (sides.includes("head") && row.newLine !== null)
    return { side: "head", filePath: file.path, line: row.newLine };
  if (row.oldLine !== null) return { side: "base", filePath: basePath, line: row.oldLine };
  return null;
}

/** "Ada Lovelace · 3 days ago · Fix the parser" from a blame answer. */
export function blameSummary(
  blame: {
    readonly author: string;
    readonly summary: string;
    readonly authorTime: string | null;
    readonly oid: string;
  },
  now: Date = new Date(),
): string {
  const parts = [blame.author, blame.oid.slice(0, 7)];
  const when = blame.authorTime ? relativeAge(new Date(blame.authorTime), now) : null;
  if (when) parts.push(when);
  return `${parts.join(" · ")}\n${blame.summary}`;
}

function relativeAge(date: Date, now: Date): string | null {
  const seconds = Math.round((now.getTime() - date.getTime()) / 1000);
  if (!Number.isFinite(seconds)) return null;
  if (seconds < 60) return "just now";
  const units: ReadonlyArray<readonly [number, string]> = [
    [60 * 60 * 24 * 365, "year"],
    [60 * 60 * 24 * 30, "month"],
    [60 * 60 * 24, "day"],
    [60 * 60, "hour"],
    [60, "minute"],
  ];
  for (const [size, unit] of units) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `${count} ${unit}${count === 1 ? "" : "s"} ago`;
  }
  return null;
}
