/**
 * Pure derivations for the "New pull request" dialog: which refs can be
 * picked, the default head and base, whether the head is on the remote, and
 * what (if anything) stands between the form and `createChangeRequest`.
 */
import type {
  ChangeRequest,
  ChangeRequestCreateInput,
  VcsRef,
  VcsStatusResult,
} from "@ryco/contracts";
import type {
  ChangeRequestHostCapabilities,
  ChangeRequestPresentation,
} from "@ryco/shared/sourceControl";

/** The remote change requests are opened against (the host's repository). */
export const CREATE_PULL_REQUEST_REMOTE = "origin";

/** A branch as the host knows it, picked from a local or a remote-tracking ref. */
export interface CreatePullRequestBranch {
  /** The branch name on the host (`origin/` stripped from remote-tracking refs). */
  readonly name: string;
  /** The ref it was picked from (`feature`, `origin/feature`): the picker's item value. */
  readonly refName: string;
  readonly isRemote: boolean;
}

/**
 * The branch a ref names on the host, or null for refs a change request
 * cannot use: other remotes (a fork head needs `owner:branch`, which the
 * dialog does not model) and the remote's symbolic `HEAD`.
 */
export function branchFromRef(ref: VcsRef): CreatePullRequestBranch | null {
  if (!ref.isRemote) return { name: ref.name, refName: ref.name, isRemote: false };
  const remote = ref.remoteName ?? ref.name.slice(0, Math.max(0, ref.name.indexOf("/")));
  if (remote !== CREATE_PULL_REQUEST_REMOTE) return null;
  const name = ref.name.slice(remote.length + 1);
  if (name.length === 0 || name === "HEAD") return null;
  return { name, refName: ref.name, isRemote: true };
}

/** Pickable branches in the server's order (current, default, recent; then remote). */
export function pickableBranches(refs: ReadonlyArray<VcsRef>): CreatePullRequestBranch[] {
  const seen = new Set<string>();
  const branches: CreatePullRequestBranch[] = [];
  for (const ref of refs) {
    const branch = branchFromRef(ref);
    if (!branch || seen.has(branch.refName)) continue;
    seen.add(branch.refName);
    branches.push(branch);
  }
  return branches;
}

/** The checkout's current branch: git status first, else the ref list's `current`. */
export function defaultHeadBranch(input: {
  readonly status: Pick<VcsStatusResult, "refName"> | null;
  readonly refs: ReadonlyArray<VcsRef>;
}): CreatePullRequestBranch | null {
  const name =
    input.status?.refName ?? input.refs.find((ref) => ref.current && !ref.isRemote)?.name ?? null;
  return name === null ? null : { name, refName: name, isRemote: false };
}

const CONVENTIONAL_DEFAULT_BRANCHES = ["main", "master"] as const;

/**
 * The repository's default branch (the ref `origin/HEAD` points at), else a
 * conventional `main` / `master` that exists locally or on the remote. Never
 * the head itself: a base equal to the head is no default at all.
 */
export function defaultBaseBranch(input: {
  readonly refs: ReadonlyArray<VcsRef>;
  readonly head: string | null;
}): CreatePullRequestBranch | null {
  const branches = input.refs.flatMap((ref) => {
    const branch = branchFromRef(ref);
    return branch ? [{ ref, branch }] : [];
  });
  const candidate =
    branches.find(({ ref }) => ref.isDefault && !ref.isRemote)?.branch ??
    CONVENTIONAL_DEFAULT_BRANCHES.map(
      (name) => branches.find(({ branch }) => branch.name === name)?.branch,
    ).find((branch) => branch !== undefined) ??
    null;
  return candidate && candidate.name !== input.head ? candidate : null;
}

/** Whether `origin` has a branch, as far as the checkout's remote-tracking refs know. */
export type RemoteBranchPresence = "present" | "absent" | "checking" | "failed";

/** Whether the head can back a change request on the host. */
export type HeadPushState =
  | { readonly kind: "none" }
  | { readonly kind: "checking" }
  | {
      readonly kind: "pushed";
      /** Local commits on the current branch that the remote does not have yet. */
      readonly unpushedCommits: number;
    }
  | { readonly kind: "unpushed" }
  /** The lookup failed: let the host decide (it explains a missing head itself). */
  | { readonly kind: "unknown" };

export function resolveHeadPushState(input: {
  readonly head: CreatePullRequestBranch | null;
  readonly status: Pick<VcsStatusResult, "refName" | "hasUpstream" | "aheadCount"> | null;
  /** Presence of `origin/<head>`, consulted for local branches other than the current one. */
  readonly remote: RemoteBranchPresence;
}): HeadPushState {
  const { head, status } = input;
  if (!head) return { kind: "none" };
  // A remote-tracking ref is, by definition, on the remote.
  if (head.isRemote) return { kind: "pushed", unpushedCommits: 0 };
  if (status && status.refName === head.name) {
    return status.hasUpstream
      ? { kind: "pushed", unpushedCommits: status.aheadCount }
      : { kind: "unpushed" };
  }
  switch (input.remote) {
    case "present":
      return { kind: "pushed", unpushedCommits: 0 };
    case "absent":
      return { kind: "unpushed" };
    case "checking":
      return { kind: "checking" };
    case "failed":
      return { kind: "unknown" };
  }
}

/** Whether the head is a local branch that needs the remote lookup (not current, not remote). */
export function needsRemoteLookup(
  head: CreatePullRequestBranch | null,
  status: Pick<VcsStatusResult, "refName"> | null,
): boolean {
  return head !== null && !head.isRemote && status?.refName !== head.name;
}

/** An open change request from `head` into `base` (one already exists; the host refuses another). */
export function findOpenChangeRequest(input: {
  readonly rows: ReadonlyArray<ChangeRequest> | null;
  readonly head: string | null;
  readonly base: string | null;
}): ChangeRequest | null {
  if (!input.rows || input.head === null || input.base === null) return null;
  return (
    input.rows.find(
      (row) =>
        row.state === "open" &&
        row.isCrossRepository !== true &&
        row.headRefName === input.head &&
        row.baseRefName === input.base,
    ) ?? null
  );
}

/** One line under the branches: a blocker stops Create; a note only informs. */
export type CreatePullRequestNotice =
  | { readonly kind: "same-branch"; readonly tone: "blocker"; readonly branch: string }
  | { readonly kind: "unpushed"; readonly tone: "blocker"; readonly branch: string }
  | {
      readonly kind: "already-open";
      readonly tone: "blocker";
      readonly number: number;
      readonly branch: string;
    }
  | { readonly kind: "checking"; readonly tone: "note"; readonly branch: string }
  | {
      readonly kind: "unpushed-commits";
      readonly tone: "note";
      readonly branch: string;
      readonly count: number;
    };

export interface CreatePullRequestValidation {
  readonly canSubmit: boolean;
  readonly notice: CreatePullRequestNotice | null;
}

export function validateCreatePullRequest(input: {
  readonly head: CreatePullRequestBranch | null;
  readonly base: CreatePullRequestBranch | null;
  readonly title: string;
  readonly pushState: HeadPushState;
  readonly existing: ChangeRequest | null;
}): CreatePullRequestValidation {
  const { head, base, pushState } = input;
  const titled = input.title.trim().length > 0;
  if (!head || !base) return { canSubmit: false, notice: null };
  if (head.name === base.name) {
    return {
      canSubmit: false,
      notice: { kind: "same-branch", tone: "blocker", branch: head.name },
    };
  }
  if (pushState.kind === "unpushed") {
    return { canSubmit: false, notice: { kind: "unpushed", tone: "blocker", branch: head.name } };
  }
  if (input.existing) {
    return {
      canSubmit: false,
      notice: {
        kind: "already-open",
        tone: "blocker",
        number: input.existing.number,
        branch: head.name,
      },
    };
  }
  if (pushState.kind === "checking") {
    return { canSubmit: false, notice: { kind: "checking", tone: "note", branch: head.name } };
  }
  const notice: CreatePullRequestNotice | null =
    pushState.kind === "pushed" && pushState.unpushedCommits > 0
      ? {
          kind: "unpushed-commits",
          tone: "note",
          branch: head.name,
          count: pushState.unpushedCommits,
        }
      : null;
  return { canSubmit: titled, notice };
}

/** The notice as one sentence, in the host's own words ("merge request" on GitLab). */
export function describeCreatePullRequestNotice(
  notice: CreatePullRequestNotice,
  presentation: Pick<ChangeRequestPresentation, "longName">,
): string {
  switch (notice.kind) {
    case "same-branch":
      return `The ${presentation.longName} needs a base other than ${notice.branch}.`;
    case "unpushed":
      return `${notice.branch} isn't on ${CREATE_PULL_REQUEST_REMOTE} yet. Push it, then open the ${presentation.longName}.`;
    case "already-open":
      return `#${notice.number} is already open from ${notice.branch}.`;
    case "checking":
      return `Checking ${CREATE_PULL_REQUEST_REMOTE} for ${notice.branch}…`;
    case "unpushed-commits":
      return `${notice.count === 1 ? "1 local commit isn't" : `${notice.count} local commits aren't`} on ${CREATE_PULL_REQUEST_REMOTE} yet; the ${presentation.longName} opens without ${notice.count === 1 ? "it" : "them"}.`;
  }
}

export function buildCreatePullRequestInput(input: {
  readonly cwd: string;
  readonly head: CreatePullRequestBranch;
  readonly base: CreatePullRequestBranch;
  readonly title: string;
  readonly body: string;
  readonly draft: boolean;
  readonly capabilities: Pick<ChangeRequestHostCapabilities, "create">;
}): ChangeRequestCreateInput {
  const draft = input.draft && input.capabilities.create.draft;
  return {
    cwd: input.cwd,
    baseRefName: input.base.name,
    headRefName: input.head.name,
    title: input.title.trim(),
    body: input.body.trimEnd(),
    ...(draft ? { draft: true } : {}),
  };
}
