import type {
  ChangeRequestInvolvement,
  ChangeRequestReviewEvent,
  ChangeRequestUpdateAction,
  ChangeRequestUpdateActionKind,
  SourceControlChangeRequestMergeMethod,
  SourceControlCommentAuthorRole,
  SourceControlProviderInfo,
  SourceControlProviderKind,
} from "@ryco/contracts";

export interface ChangeRequestPresentation {
  readonly icon: "github" | "gitlab" | "forgejo" | "azure-devops" | "bitbucket" | "change-request";
  readonly providerName: string;
  readonly shortName: string;
  readonly longName: string;
  readonly pluralLongName: string;
  readonly providerLongName: string;
  readonly checkoutCommandExample?: string;
  readonly urlExample: string;
}

export interface ChangeRequestTerminology {
  readonly shortLabel: string;
  readonly singular: string;
}

export const DEFAULT_CHANGE_REQUEST_TERMINOLOGY: ChangeRequestTerminology = {
  shortLabel: "PR",
  singular: "pull request",
};

const GITHUB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "github",
  providerName: "GitHub",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "GitHub pull request",
  checkoutCommandExample: "gh pr checkout 123",
  urlExample: "https://github.com/owner/repo/pull/42",
};

const GITLAB_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "gitlab",
  providerName: "GitLab",
  shortName: "MR",
  longName: "merge request",
  pluralLongName: "merge requests",
  providerLongName: "GitLab merge request",
  checkoutCommandExample: "glab mr checkout 123",
  urlExample: "https://gitlab.com/group/project/-/merge_requests/42",
};

const FORGEJO_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "forgejo",
  providerName: "Forgejo",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Forgejo pull request",
  urlExample: "https://codeberg.org/owner/repo/pulls/42",
};

const AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "azure-devops",
  providerName: "Azure DevOps",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Azure DevOps pull request",
  checkoutCommandExample: "az repos pr checkout --id 123",
  urlExample: "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
};

const BITBUCKET_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "bitbucket",
  providerName: "Bitbucket",
  shortName: "PR",
  longName: "pull request",
  pluralLongName: "pull requests",
  providerLongName: "Bitbucket pull request",
  urlExample: "https://bitbucket.org/workspace/repo/pull-requests/42",
};

const GENERIC_CHANGE_REQUEST_PRESENTATION: ChangeRequestPresentation = {
  icon: "change-request",
  providerName: "source control",
  shortName: "change request",
  longName: "change request",
  pluralLongName: "change requests",
  providerLongName: "change request",
  urlExample: "#42",
};

export function resolveChangeRequestPresentation(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestPresentation {
  switch (provider?.kind) {
    case "github":
    case undefined:
      return GITHUB_CHANGE_REQUEST_PRESENTATION;
    case "gitlab":
      return GITLAB_CHANGE_REQUEST_PRESENTATION;
    case "forgejo":
      return FORGEJO_CHANGE_REQUEST_PRESENTATION;
    case "azure-devops":
      return AZURE_DEVOPS_CHANGE_REQUEST_PRESENTATION;
    case "bitbucket":
      return BITBUCKET_CHANGE_REQUEST_PRESENTATION;
    case "unknown":
      return GENERIC_CHANGE_REQUEST_PRESENTATION;
  }
}

export function resolveChangeRequestPresentationForKind(
  kind: SourceControlProviderKind,
): ChangeRequestPresentation {
  return resolveChangeRequestPresentation({ kind, name: "", baseUrl: "" });
}

export function formatChangeRequestAction(
  verb: "View" | "Create",
  presentation: ChangeRequestPresentation,
): string {
  return `${verb} ${presentation.shortName}`;
}

export function formatCreateChangeRequestPhrase(presentation: ChangeRequestPresentation): string {
  return `create ${presentation.shortName}`;
}

export function getChangeRequestTerminology(
  provider: SourceControlProviderInfo | null | undefined,
): ChangeRequestTerminology {
  if (!provider) {
    return DEFAULT_CHANGE_REQUEST_TERMINOLOGY;
  }

  const presentation = resolveChangeRequestPresentation(provider);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

export function getChangeRequestTerminologyForKind(
  kind: SourceControlProviderKind,
): ChangeRequestTerminology {
  const presentation = resolveChangeRequestPresentationForKind(kind);
  return {
    shortLabel: presentation.shortName,
    singular: presentation.longName,
  };
}

/**
 * Link to one commit of a change request on its host, or null where the
 * host's URL scheme for it is not known.
 */
export function changeRequestCommitUrl(
  kind: SourceControlProviderKind,
  changeRequestUrl: string | null | undefined,
  oid: string,
): string | null {
  if (!changeRequestUrl) return null;
  switch (kind) {
    case "github":
      return `${changeRequestUrl.replace(/\/+$/u, "")}/commits/${oid}`;
    case "gitlab":
    case "forgejo":
    case "azure-devops":
    case "bitbucket":
    case "unknown":
      return null;
  }
}

// ── Change request host capabilities ─────────────────────────────────
//
// The single source of truth for what each host implements for change
// requests (the pull requests page and its RPCs). The web hides every control
// whose capability is false (SPEC §8: "mutations for providers that don't
// implement them — those controls are hidden"); the server fails fast with a
// clear message before calling a provider for them.
//
// An entry states what works TODAY. Flip a flag in the same change that
// implements it (provider code, fixtures shaped like the host's API, tests),
// never ahead of it. `.docs/pr-lab/PROVIDERS.md` maps every flag to the host
// endpoint that would back it.

/** Review verdicts a host accepts from `submitChangeRequestReview`. */
export interface ChangeRequestReviewSubmitCapabilities {
  /** `event: "comment"`: a review that only comments (also "Comment now" on a line). */
  readonly comment: boolean;
  readonly approve: boolean;
  readonly requestChanges: boolean;
  /**
   * The viewer's unsubmitted host-side review is reported
   * (`ChangeRequestActivity.pendingReview`) and submitted along with the
   * page's drafts.
   */
  readonly pendingReview: boolean;
}

export interface ChangeRequestMergeHostCapabilities {
  /** Methods `mergeChangeRequest` accepts; empty when the host cannot merge from Ryco. */
  readonly methods: ReadonlySet<SourceControlChangeRequestMergeMethod>;
  /** `deleteBranch`: delete the head branch after a successful merge. */
  readonly deleteBranch: boolean;
  /** `expectedHeadSha`: refuse the merge when the head moved since the user looked. */
  readonly expectedHeadSha: boolean;
}

/**
 * What a host's list rows can say about readiness (the row's second line and
 * whether a stack layer counts as landable):
 * - `verdict`: rows carry everything the merge verdict reads, so a row may
 *   read "Ready to merge".
 * - `blockers`: rows carry only some blockers (conflicts, drafts, failing or
 *   running checks, requested changes); a row with none of them reads "Open",
 *   never "Ready to merge", since what the row lacks (reviews, policies) may
 *   still block it.
 * - `none`: rows state only open, draft, merged or closed.
 */
export type ChangeRequestListReadiness = "verdict" | "blockers" | "none";

/** How `update-branch` brings the head up to date with its base. */
export type ChangeRequestUpdateBranchMethod = Extract<
  ChangeRequestUpdateAction,
  { readonly kind: "update-branch" }
>["method"];

/**
 * How often an open, idle change request re-reads its detail and activity
 * (the `watching` refresh phase): `standard`, or `slow` for hosts where each
 * read fans out into many CLI processes (`az` starts a Python process per
 * call; GitLab's detail and activity are 6–8 `glab api` calls each).
 */
export type ChangeRequestIdleRefresh = "standard" | "slow";

export interface ChangeRequestCreateCapabilities {
  /** `createChangeRequest`. */
  readonly supported: boolean;
  /** `createChangeRequest{draft: true}`. */
  readonly draft: boolean;
}

export interface ChangeRequestHostCapabilities {
  // ── Lists ──
  /**
   * Server-side involvement filters (`listChangeRequests{involvement}`:
   * authored, review requested, …), combinable with state and a free-text
   * `query`. Drives the list's groups and the "Review requested" / "Yours"
   * filters.
   */
  readonly involvementFilters: boolean;
  /** Host search (`searchChangeRequests`): the list's fallback when nothing loaded matches. */
  readonly search: boolean;

  // ── Reading one change request ──
  /** `getChangeRequestActivity`: timeline, review threads, and the viewer's permissions. */
  readonly activity: boolean;
  /** `getChangeRequestDiff` returns the real unified diff (false: it is an empty stub). */
  readonly diff: boolean;
  /** `getChangeRequestDiff{commitSha}`: the Files tab's commit scope. */
  readonly commitDiffs: boolean;
  /** `getChangeRequestFileContents`: hunk expansion in the diff. */
  readonly fileContents: boolean;
  /** The detail carries `checkRollup`: the merge section's checks line and the Checks tab. */
  readonly checkRollup: boolean;
  /** List rows carry `checkRollup`: row check glyphs and the "Failing checks" filter. */
  readonly listCheckRollup: boolean;
  /**
   * The detail carries merge readiness (mergeability, merge state, review
   * decision, reviewer states): the merge verdict, its status lines, the next
   * action and the merge controls. Without it the page states no verdict.
   */
  readonly mergeReadiness: boolean;
  /** What list rows say about readiness (see `ChangeRequestListReadiness`). */
  readonly listReadiness: ChangeRequestListReadiness;
  /** How often an open, idle change request is re-read (see `ChangeRequestIdleRefresh`). */
  readonly idleRefresh: ChangeRequestIdleRefresh;
  /** `listWorkflowRuns` + `getWorkflowRunJobs`: the Checks tab's workflow → job → step tree. */
  readonly workflowRuns: boolean;
  /** `getWorkflowJobLog`: step logs and "Fix with agent" log tails. */
  readonly workflowJobLogs: boolean;
  /** `rerunWorkflow`: "Re-run failed" and "Re-run job". */
  readonly rerunWorkflows: boolean;
  /** The detail carries host-native stacks (`stack`): stack section, chip, spines, merge-through. */
  readonly stacks: boolean;
  /** `getChangeRequestFilesViewed` / `setChangeRequestFileViewed` with host storage. */
  readonly viewedFiles: boolean;

  // ── Conversation ──
  /** `addChangeRequestComment`: the timeline composer. */
  readonly comment: boolean;
  /** `addChangeRequestCommentReaction`. */
  readonly reactions: boolean;
  /** `updateChangeRequestComment{action: "edit"}`. */
  readonly editComments: boolean;
  /** `updateChangeRequestComment{action: "delete"}`. */
  readonly deleteComments: boolean;

  // ── Review ──
  /** New line-anchored comments in a review (`submitChangeRequestReview{comments}`): the diff gutter. */
  readonly lineComments: boolean;
  /** `replyToReviewThread`. */
  readonly replyToThreads: boolean;
  /** `setReviewThreadResolved`. */
  readonly resolveThreads: boolean;
  readonly submitReview: ChangeRequestReviewSubmitCapabilities;

  // ── Lifecycle and merge ──
  /** `updateChangeRequest` action kinds the host applies (auto-merge lives here, not under `merge`). */
  readonly lifecycle: ReadonlySet<ChangeRequestUpdateActionKind>;
  /**
   * The `update-branch` methods the host applies: merging the base in,
   * rebasing onto it, or both. Empty exactly when `lifecycle` lacks
   * `update-branch`.
   */
  readonly updateBranchMethods: ReadonlySet<ChangeRequestUpdateBranchMethod>;
  readonly merge: ChangeRequestMergeHostCapabilities;

  // ── Checkout and create ──
  /** `checkoutChangeRequest`: worktree checkout, which every agent hand-off needs. */
  readonly checkout: boolean;
  readonly create: ChangeRequestCreateCapabilities;
}

const ALL_LIFECYCLE_ACTIONS: ReadonlySet<ChangeRequestUpdateActionKind> = new Set([
  "edit",
  "set-draft",
  "close",
  "reopen",
  "reviewers",
  "labels",
  "assignees",
  "update-branch",
  "auto-merge",
  "delete-branch",
]);

/**
 * One entry per provider kind, each spelled out in full (no shared base), so
 * one host's entry can change without touching another's. Keep the
 * `── <kind> ──` / `── end <kind> ──` delimiters.
 */
const CHANGE_REQUEST_HOST_CAPABILITIES: Record<
  SourceControlProviderKind,
  ChangeRequestHostCapabilities
> = {
  // ── github ──────────────────────────────────────────────────────────
  // `gh` CLI (GraphQL + REST): everything the page offers.
  github: {
    involvementFilters: true,
    search: true,
    activity: true,
    diff: true,
    commitDiffs: true,
    fileContents: true,
    checkRollup: true,
    listCheckRollup: true,
    mergeReadiness: true,
    listReadiness: "verdict",
    idleRefresh: "standard",
    workflowRuns: true,
    workflowJobLogs: true,
    rerunWorkflows: true,
    stacks: true,
    viewedFiles: true,
    comment: true,
    reactions: true,
    editComments: true,
    deleteComments: true,
    lineComments: true,
    replyToThreads: true,
    resolveThreads: true,
    submitReview: { comment: true, approve: true, requestChanges: true, pendingReview: true },
    lifecycle: ALL_LIFECYCLE_ACTIONS,
    updateBranchMethods: new Set(["merge", "rebase"]),
    merge: {
      methods: new Set(["merge", "squash", "rebase"]),
      deleteBranch: true,
      expectedHeadSha: true,
    },
    checkout: true,
    create: { supported: true, draft: true },
  },
  // ── end github ──────────────────────────────────────────────────────

  // ── gitlab ──────────────────────────────────────────────────────────
  // `glab` CLI + REST v4 (`glab api`): lists with involvement filters and
  // pipelines, readiness, diffs, activity (notes, discussions, events),
  // draft-note reviews with approve / request changes, lifecycle, merge, CI.
  // No reactions (reading award emoji is one request per note), no host
  // viewed state, no stacks. `update-branch` only rebases (`PUT .../rebase`):
  // GitLab cannot merge the target branch into the source from its API.
  // List rows carry `detailed_merge_status`, so they state the verdict.
  gitlab: {
    involvementFilters: true,
    search: true,
    activity: true,
    diff: true,
    commitDiffs: true,
    fileContents: true,
    checkRollup: true,
    listCheckRollup: true,
    mergeReadiness: true,
    listReadiness: "verdict",
    idleRefresh: "slow",
    workflowRuns: true,
    workflowJobLogs: true,
    rerunWorkflows: true,
    stacks: false,
    viewedFiles: false,
    comment: true,
    reactions: false,
    editComments: true,
    deleteComments: true,
    lineComments: true,
    replyToThreads: true,
    resolveThreads: true,
    submitReview: { comment: true, approve: true, requestChanges: true, pendingReview: true },
    lifecycle: new Set([
      "edit",
      "set-draft",
      "close",
      "reopen",
      "reviewers",
      "labels",
      "assignees",
      "update-branch",
      "auto-merge",
      "delete-branch",
    ]),
    updateBranchMethods: new Set(["rebase"]),
    merge: {
      methods: new Set(["merge", "squash", "rebase"]),
      deleteBranch: true,
      expectedHeadSha: true,
    },
    checkout: true,
    create: { supported: true, draft: true },
  },
  // ── end gitlab ──────────────────────────────────────────────────────

  // ── bitbucket ───────────────────────────────────────────────────────
  // Bitbucket Cloud REST 2.0 (apps/server/src/sourceControl/bitbucket*):
  // involvement lists (authored / review requested), search, activity
  // (timeline rebuilt from the activity log, threads, viewer), diffs incl.
  // single commits, hunk expansion, comments, threads, approve / request
  // changes, edit / draft / decline / reviewers / branch deletion, merges with
  // a head pre-check, checkout, drafts. No reactions, labels, assignees,
  // reopen, update-branch, auto-merge or publishing pending comments. The
  // detail carries readiness and build statuses; list rows cannot (one extra
  // read per row), so they state only open / draft / merged / closed.
  bitbucket: {
    involvementFilters: true,
    search: true,
    activity: true,
    diff: true,
    commitDiffs: true,
    fileContents: true,
    checkRollup: true,
    listCheckRollup: false,
    mergeReadiness: true,
    listReadiness: "none",
    idleRefresh: "standard",
    workflowRuns: false,
    workflowJobLogs: false,
    rerunWorkflows: false,
    stacks: false,
    viewedFiles: false,
    comment: true,
    reactions: false,
    editComments: true,
    deleteComments: true,
    lineComments: true,
    replyToThreads: true,
    resolveThreads: true,
    submitReview: { comment: true, approve: true, requestChanges: true, pendingReview: false },
    lifecycle: new Set(["edit", "set-draft", "close", "reviewers", "delete-branch"]),
    updateBranchMethods: new Set(),
    merge: {
      methods: new Set(["merge", "squash", "rebase"]),
      deleteBranch: true,
      expectedHeadSha: true,
    },
    checkout: true,
    create: { supported: true, draft: true },
  },
  // ── end bitbucket ───────────────────────────────────────────────────

  // ── forgejo ─────────────────────────────────────────────────────────
  // Forgejo / Gitea REST v1 (Forgejo 7+): timeline, positional review
  // threads, reviews (pending reviews absorbed), readiness from commit
  // statuses and base branch protection. Drafts are `WIP:` title prefixes.
  // Not in the API: resolving conversations, viewed files, auto-merge state,
  // and Actions jobs/logs before Forgejo 16. List rows carry the head's
  // combined status and mergeability, not reviews (one more read per row).
  forgejo: {
    involvementFilters: true,
    search: true,
    activity: true,
    diff: true,
    commitDiffs: true,
    fileContents: true,
    checkRollup: true,
    listCheckRollup: true,
    mergeReadiness: true,
    listReadiness: "blockers",
    idleRefresh: "standard",
    workflowRuns: false,
    workflowJobLogs: false,
    rerunWorkflows: false,
    stacks: false,
    viewedFiles: false,
    comment: true,
    reactions: true,
    editComments: true,
    deleteComments: true,
    lineComments: true,
    replyToThreads: true,
    resolveThreads: false,
    submitReview: { comment: true, approve: true, requestChanges: true, pendingReview: true },
    lifecycle: new Set([
      "edit",
      "set-draft",
      "close",
      "reopen",
      "reviewers",
      "labels",
      "assignees",
      "update-branch",
      "delete-branch",
    ]),
    updateBranchMethods: new Set(["merge", "rebase"]),
    merge: {
      methods: new Set(["merge", "squash", "rebase"]),
      deleteBranch: true,
      expectedHeadSha: true,
    },
    checkout: true,
    create: { supported: true, draft: true },
  },
  // ── end forgejo ─────────────────────────────────────────────────────

  // ── azure-devops ────────────────────────────────────────────────────
  // `az repos` + `az devops invoke` (Git REST 7.1): threads, iterations,
  // votes, completion. Diffs and file contents come from local git (Azure has
  // no REST hunk diff). No reactions (likes only), assignees, update-branch,
  // pending reviews, CI runs or check rollups yet. List rows carry merge
  // conflicts and votes but not branch policies, so they never read ready.
  "azure-devops": {
    involvementFilters: true,
    search: true,
    activity: true,
    diff: true,
    commitDiffs: true,
    fileContents: true,
    checkRollup: false,
    listCheckRollup: false,
    mergeReadiness: true,
    listReadiness: "blockers",
    idleRefresh: "slow",
    workflowRuns: false,
    workflowJobLogs: false,
    rerunWorkflows: false,
    stacks: false,
    viewedFiles: false,
    comment: true,
    reactions: false,
    editComments: true,
    deleteComments: true,
    lineComments: true,
    replyToThreads: true,
    resolveThreads: true,
    submitReview: { comment: true, approve: true, requestChanges: true, pendingReview: false },
    lifecycle: new Set([
      "edit",
      "set-draft",
      "close",
      "reopen",
      "reviewers",
      "labels",
      "auto-merge",
      "delete-branch",
    ]),
    updateBranchMethods: new Set(),
    merge: {
      methods: new Set(["merge", "squash", "rebase"]),
      deleteBranch: true,
      expectedHeadSha: true,
    },
    checkout: true,
    create: { supported: true, draft: true },
  },
  // ── end azure-devops ────────────────────────────────────────────────

  // ── unknown ─────────────────────────────────────────────────────────
  // No registered provider: nothing works.
  unknown: {
    involvementFilters: false,
    search: false,
    activity: false,
    diff: false,
    commitDiffs: false,
    fileContents: false,
    checkRollup: false,
    listCheckRollup: false,
    mergeReadiness: false,
    listReadiness: "none",
    idleRefresh: "standard",
    workflowRuns: false,
    workflowJobLogs: false,
    rerunWorkflows: false,
    stacks: false,
    viewedFiles: false,
    comment: false,
    reactions: false,
    editComments: false,
    deleteComments: false,
    lineComments: false,
    replyToThreads: false,
    resolveThreads: false,
    submitReview: { comment: false, approve: false, requestChanges: false, pendingReview: false },
    lifecycle: new Set(),
    updateBranchMethods: new Set(),
    merge: { methods: new Set(), deleteBranch: false, expectedHeadSha: false },
    checkout: false,
    create: { supported: false, draft: false },
  },
  // ── end unknown ─────────────────────────────────────────────────────
};

/** What `kind` implements for change requests (see `ChangeRequestHostCapabilities`). */
export function getChangeRequestHostCapabilities(
  kind: SourceControlProviderKind,
): ChangeRequestHostCapabilities {
  return CHANGE_REQUEST_HOST_CAPABILITIES[kind];
}

/** The host accepts `event` from `submitChangeRequestReview`. */
export function supportsChangeRequestReviewEvent(
  capabilities: ChangeRequestHostCapabilities,
  event: ChangeRequestReviewEvent,
): boolean {
  switch (event) {
    case "comment":
      return capabilities.submitReview.comment;
    case "approve":
      return capabilities.submitReview.approve;
    case "request_changes":
      return capabilities.submitReview.requestChanges;
  }
}

/** The host accepts at least one review verdict (the Review button and popover exist). */
export function canSubmitChangeRequestReview(capabilities: ChangeRequestHostCapabilities): boolean {
  const { comment, approve, requestChanges } = capabilities.submitReview;
  return comment || approve || requestChanges;
}

/** The host merges change requests from Ryco with at least one method. */
export function canMergeChangeRequests(capabilities: ChangeRequestHostCapabilities): boolean {
  return capabilities.merge.methods.size > 0;
}

/**
 * The method a one-click "Update branch" uses: merging the base in where the
 * host can (it keeps the branch's history), else rebasing; null when the host
 * cannot update branches.
 */
export function preferredUpdateBranchMethod(
  capabilities: Pick<ChangeRequestHostCapabilities, "updateBranchMethods">,
): ChangeRequestUpdateBranchMethod | null {
  if (capabilities.updateBranchMethods.has("merge")) return "merge";
  if (capabilities.updateBranchMethods.has("rebase")) return "rebase";
  return null;
}

/** A change request call, described by the inputs that decide whether a host supports it. */
export type ChangeRequestHostRequest =
  | {
      readonly operation: "listChangeRequests";
      readonly involvement?: ChangeRequestInvolvement | undefined;
      readonly query?: string | undefined;
    }
  | { readonly operation: "searchChangeRequests" }
  | { readonly operation: "getChangeRequestDiff"; readonly commitSha?: string | undefined }
  | { readonly operation: "createChangeRequest"; readonly draft?: boolean | undefined }
  | { readonly operation: "getChangeRequestActivity" }
  | { readonly operation: "getChangeRequestFileContents" }
  | { readonly operation: "getChangeRequestFilesViewed" }
  | { readonly operation: "setChangeRequestFileViewed" }
  | { readonly operation: "addChangeRequestComment" }
  | { readonly operation: "addChangeRequestCommentReaction" }
  | { readonly operation: "updateChangeRequestComment"; readonly action: "edit" | "delete" }
  | {
      readonly operation: "submitChangeRequestReview";
      readonly event: ChangeRequestReviewEvent;
      /** Line comments sent with the review. */
      readonly commentCount: number;
    }
  | { readonly operation: "replyToReviewThread" }
  | { readonly operation: "setReviewThreadResolved" }
  | {
      readonly operation: "updateChangeRequest";
      readonly action: ChangeRequestUpdateActionKind;
      /** `update-branch`'s method. */
      readonly updateBranchMethod?: ChangeRequestUpdateBranchMethod | undefined;
    }
  | {
      readonly operation: "mergeChangeRequest";
      readonly mergeMethod: SourceControlChangeRequestMergeMethod;
      readonly deleteBranch?: boolean | undefined;
      readonly expectedHeadSha?: string | undefined;
    }
  | { readonly operation: "listWorkflowRuns" }
  | { readonly operation: "getWorkflowRunJobs" }
  | { readonly operation: "getWorkflowJobLog" }
  | { readonly operation: "rerunWorkflow" };

const UPDATE_ACTION_PHRASES: Record<
  ChangeRequestUpdateActionKind,
  (presentation: ChangeRequestPresentation) => string
> = {
  edit: (p) => `editing ${p.pluralLongName}`,
  "set-draft": (p) => `draft ${p.pluralLongName}`,
  close: (p) => `closing ${p.pluralLongName}`,
  reopen: (p) => `reopening ${p.pluralLongName}`,
  reviewers: () => "requesting reviewers",
  labels: (p) => `labeling ${p.pluralLongName}`,
  assignees: (p) => `assigning ${p.pluralLongName}`,
  "update-branch": () => "updating branches from their base",
  "auto-merge": () => "auto-merge",
  "delete-branch": () => "deleting head branches",
};

/** What the request needs that the host lacks, as a phrase ("approving reviews"); null when supported. */
function unsupportedChangeRequestFeature(
  capabilities: ChangeRequestHostCapabilities,
  presentation: ChangeRequestPresentation,
  request: ChangeRequestHostRequest,
): string | null {
  const plural = presentation.pluralLongName;
  switch (request.operation) {
    case "listChangeRequests":
      if (request.involvement !== undefined && !capabilities.involvementFilters) {
        return `filtering ${plural} by involvement`;
      }
      if (
        request.query !== undefined &&
        request.query.trim().length > 0 &&
        !capabilities.involvementFilters
      ) {
        return `searching within filtered ${plural} lists`;
      }
      return null;
    case "searchChangeRequests":
      return capabilities.search ? null : `searching ${plural}`;
    case "getChangeRequestDiff":
      return request.commitSha !== undefined && !capabilities.commitDiffs
        ? "single-commit diffs"
        : null;
    case "createChangeRequest":
      if (!capabilities.create.supported) return `opening ${plural}`;
      return request.draft === true && !capabilities.create.draft
        ? `opening draft ${plural}`
        : null;
    case "getChangeRequestActivity":
      return capabilities.activity ? null : "the review timeline";
    case "getChangeRequestFileContents":
      return capabilities.fileContents ? null : "expanding diff context";
    case "getChangeRequestFilesViewed":
    case "setChangeRequestFileViewed":
      return capabilities.viewedFiles ? null : "marking files viewed";
    case "addChangeRequestComment":
      return capabilities.comment ? null : `commenting on ${plural}`;
    case "addChangeRequestCommentReaction":
      return capabilities.reactions ? null : "comment reactions";
    case "updateChangeRequestComment":
      if (request.action === "edit") return capabilities.editComments ? null : "editing comments";
      return capabilities.deleteComments ? null : "deleting comments";
    case "submitChangeRequestReview":
      if (!supportsChangeRequestReviewEvent(capabilities, request.event)) {
        return request.event === "approve"
          ? "approving reviews"
          : request.event === "request_changes"
            ? "requesting changes in reviews"
            : "submitting reviews";
      }
      return request.commentCount > 0 && !capabilities.lineComments ? "line comments" : null;
    case "replyToReviewThread":
      return capabilities.replyToThreads ? null : "replying to review threads";
    case "setReviewThreadResolved":
      return capabilities.resolveThreads ? null : "resolving review threads";
    case "updateChangeRequest":
      if (!capabilities.lifecycle.has(request.action)) {
        return UPDATE_ACTION_PHRASES[request.action](presentation);
      }
      return request.action === "update-branch" &&
        request.updateBranchMethod !== undefined &&
        !capabilities.updateBranchMethods.has(request.updateBranchMethod)
        ? request.updateBranchMethod === "merge"
          ? "updating branches by merging the base in"
          : "updating branches by rebasing"
        : null;
    case "mergeChangeRequest":
      if (!canMergeChangeRequests(capabilities)) return `merging ${plural}`;
      if (!capabilities.merge.methods.has(request.mergeMethod)) {
        return `the ${request.mergeMethod} merge method`;
      }
      if (request.deleteBranch === true && !capabilities.merge.deleteBranch) {
        return "deleting the head branch after a merge";
      }
      return request.expectedHeadSha !== undefined && !capabilities.merge.expectedHeadSha
        ? "refusing merges when the head moved"
        : null;
    case "listWorkflowRuns":
    case "getWorkflowRunJobs":
      return capabilities.workflowRuns ? null : "workflow runs";
    case "getWorkflowJobLog":
      return capabilities.workflowJobLogs ? null : "workflow logs";
    case "rerunWorkflow":
      return capabilities.rerunWorkflows ? null : "re-running workflows";
  }
}

/**
 * Why `kind` cannot serve `request`, as one sentence ("GitLab does not
 * support approving reviews."), or null when the matrix says it can. The
 * server fails with this before calling the provider.
 */
export function describeUnsupportedChangeRequestRequest(
  kind: SourceControlProviderKind,
  request: ChangeRequestHostRequest,
): string | null {
  const presentation = resolveChangeRequestPresentationForKind(kind);
  const feature = unsupportedChangeRequestFeature(
    getChangeRequestHostCapabilities(kind),
    presentation,
    request,
  );
  if (feature === null) return null;
  const host = kind === "unknown" ? "This source control provider" : presentation.providerName;
  return `${host} does not support ${feature}.`;
}

export interface ClassifySourceControlCommentAuthorRoleInput {
  readonly commentAuthor: string | null | undefined;
  readonly itemAuthor: string | null | undefined;
  readonly repositoryOwner: string | null | undefined;
  readonly authorAssociation?: string | null | undefined;
}

function normalizeLogin(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.toLowerCase() : null;
}

function normalizeAuthorAssociation(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed.length > 0 ? trimmed.toUpperCase() : null;
}

function isOwnerAssociation(association: string | null): boolean {
  return association === "OWNER";
}

function isMaintainerAssociation(association: string | null): boolean {
  return association === "MEMBER" || association === "COLLABORATOR";
}

export function classifySourceControlCommentAuthorRole(
  input: ClassifySourceControlCommentAuthorRoleInput,
): SourceControlCommentAuthorRole {
  const commentAuthor = normalizeLogin(input.commentAuthor);
  const itemAuthor = normalizeLogin(input.itemAuthor);
  const repositoryOwner = normalizeLogin(input.repositoryOwner);
  const authorAssociation = normalizeAuthorAssociation(input.authorAssociation);
  const isOriginalAuthor =
    commentAuthor !== null && itemAuthor !== null && commentAuthor === itemAuthor;
  const isRepositoryOwner =
    isOwnerAssociation(authorAssociation) ||
    (commentAuthor !== null && repositoryOwner !== null && commentAuthor === repositoryOwner);
  const isRepositoryMaintainer = isMaintainerAssociation(authorAssociation);

  return {
    primary: isOriginalAuthor
      ? "author"
      : isRepositoryOwner
        ? "owner"
        : isRepositoryMaintainer
          ? "maintainer"
          : "participant",
    isOriginalAuthor,
    isRepositoryOwner,
    isRepositoryMaintainer,
  };
}

/**
 * Best-effort parse of the owner/login segment from GitHub issue, pull request,
 * or repository URLs such as `https://github.com/owner/repo/issues/42`.
 */
export function parseGitHubRepositoryOwnerFromUrl(url: string | null | undefined): string | null {
  return parseGitHubRepositoryIdentityFromUrl(url)?.owner ?? null;
}

export interface GitHubRepositoryIdentity {
  readonly host: string;
  readonly owner: string;
  readonly repository: string;
  readonly nameWithOwner: string;
}

/**
 * Parses the base repository identity from a GitHub repository, issue, or PR
 * URL. This intentionally uses the public item URL rather than a local remote,
 * because a pull request's head may live in a fork.
 */
export function parseGitHubRepositoryIdentityFromUrl(
  url: string | null | undefined,
): GitHubRepositoryIdentity | null {
  const trimmed = url?.trim() ?? "";
  if (trimmed.length === 0) return null;

  try {
    const parsed = new URL(trimmed);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
      parsed.username ||
      parsed.password
    ) {
      return null;
    }
    const segments = parsed.pathname.split("/").filter(Boolean);
    const owner = segments[0]?.trim() ?? "";
    const repository = (segments[1]?.trim() ?? "").replace(/\.git$/iu, "");
    if (!owner || !repository || owner === "." || owner === "..") return null;
    if (/%2f/iu.test(owner) || /%2f/iu.test(repository)) return null;
    return {
      host: parsed.host.toLowerCase(),
      owner,
      repository,
      nameWithOwner: `${owner}/${repository}`,
    };
  } catch {
    return null;
  }
}

function parseRemoteHost(remoteUrl: string): string | null {
  const trimmed = remoteUrl.trim();
  if (trimmed.length === 0) {
    return null;
  }

  if (trimmed.startsWith("git@")) {
    const hostWithPath = trimmed.slice("git@".length);
    const separatorIndex = hostWithPath.search(/[:/]/);
    if (separatorIndex <= 0) {
      return null;
    }
    return hostWithPath.slice(0, separatorIndex).toLowerCase();
  }

  try {
    return new URL(trimmed).host.toLowerCase();
  } catch {
    return null;
  }
}

function parseHostName(host: string): string {
  try {
    return new URL(`https://${host}`).hostname.toLowerCase();
  } catch {
    return host.replace(/:\d+$/u, "").toLowerCase();
  }
}

function toBaseUrl(host: string): string {
  return `https://${host}`;
}

function isGitHubHost(host: string): boolean {
  return host === "github.com" || host.includes("github");
}

function isGitLabHost(host: string): boolean {
  return host === "gitlab.com" || host.includes("gitlab");
}

function isForgejoHost(host: string): boolean {
  return host === "codeberg.org" || host === "code.forgejo.org" || host.includes("forgejo");
}

function isAzureDevOpsHost(host: string): boolean {
  return host === "dev.azure.com" || host.endsWith(".visualstudio.com");
}

function isBitbucketHost(host: string): boolean {
  return host === "bitbucket.org" || host.includes("bitbucket");
}

export function detectSourceControlProviderFromRemoteUrl(
  remoteUrl: string,
): SourceControlProviderInfo | null {
  const host = parseRemoteHost(remoteUrl);
  if (!host) {
    return null;
  }
  const hostname = parseHostName(host);

  if (isGitHubHost(hostname)) {
    return {
      kind: "github",
      name: hostname === "github.com" ? "GitHub" : "GitHub Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isGitLabHost(hostname)) {
    return {
      kind: "gitlab",
      name: hostname === "gitlab.com" ? "GitLab" : "GitLab Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isForgejoHost(hostname)) {
    return {
      kind: "forgejo",
      name: hostname === "codeberg.org" ? "Codeberg" : "Forgejo",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isAzureDevOpsHost(hostname)) {
    return {
      kind: "azure-devops",
      name: "Azure DevOps",
      baseUrl: toBaseUrl(host),
    };
  }

  if (isBitbucketHost(hostname)) {
    return {
      kind: "bitbucket",
      name: hostname === "bitbucket.org" ? "Bitbucket" : "Bitbucket Self-Hosted",
      baseUrl: toBaseUrl(host),
    };
  }

  return {
    kind: "unknown",
    name: host,
    baseUrl: toBaseUrl(host),
  };
}
