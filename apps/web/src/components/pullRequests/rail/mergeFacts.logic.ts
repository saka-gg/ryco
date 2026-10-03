import type {
  ChangeRequestReviewThread,
  ChangeRequestViewerCapabilities,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";
import {
  deriveChangeRequestMergeAction,
  type ChangeRequestCheck,
  type ChangeRequestChecksSummary,
  type ChangeRequestNextAction,
} from "@ryco/client-runtime/state/pull-request-review";

/**
 * Pure derivations behind the merge section: the verdict line, the status
 * lines under it, the next-action button and the menu beside it. Kept free of
 * React so every rule (who a block is on, which line a click reveals, that the
 * menu never repeats the button) is unit-tested.
 */

/** One colour vocabulary for every fact on the rail. */
export type FactTone = "success" | "warning" | "danger" | "progress" | "neutral" | "merged";

export type MergeFactsDetail = Pick<
  SourceControlChangeRequestDetail,
  | "state"
  | "isDraft"
  | "author"
  | "baseRefName"
  | "mergeability"
  | "mergeStateStatus"
  | "reviewDecision"
  | "reviewerStates"
  | "reviewers"
  | "autoMerge"
  | "mergedBy"
  | "mergeCapabilities"
  | "deleteBranchOnMerge"
  | "isCrossRepository"
  | "stack"
  | "stackMetadataIncomplete"
>;

export interface MergeFactsInput {
  readonly detail: MergeFactsDetail;
  readonly viewer: ChangeRequestViewerCapabilities | null;
  readonly checks: ChangeRequestChecksSummary;
  readonly nextAction: ChangeRequestNextAction;
  /** Review threads in host order (the reveal order for "next unresolved"). */
  readonly threads: ReadonlyArray<ChangeRequestReviewThread>;
}

// ── Verdict ──────────────────────────────────────────────────────────

export interface MergeVerdict {
  /** "Blocked", "Waiting", "Draft", "Ready to merge", "Lands 3 layers", "Merged", "Closed" … */
  readonly text: string;
  /** Muted owner phrase: "on you", "on @mvogt", "by @sak0a". */
  readonly owner: string | null;
  readonly tone: FactTone;
  /** Shown only when no status line explains the block (branch rules, permissions). */
  readonly reason: string | null;
}

function ownerOf(login: string | null | undefined, viewer: string | null): string | null {
  if (!login) return null;
  return login === viewer ? "on you" : `on @${login}`;
}

function listOwners(logins: ReadonlyArray<string>, viewer: string | null): string | null {
  if (logins.length === 0) return null;
  if (viewer !== null && logins.includes(viewer)) return "on you";
  const [first, ...rest] = logins;
  return rest.length > 0 ? `on @${first} +${rest.length}` : `on @${first}`;
}

function requestedReviewers(detail: MergeFactsDetail): ReadonlyArray<string> {
  const requested = (detail.reviewerStates ?? [])
    .filter((reviewer) => reviewer.state === "requested")
    .map((reviewer) => reviewer.login);
  return requested.length > 0 ? requested : (detail.reviewers ?? []);
}

/** Open layers a merge of this pull request lands (itself included). */
export function stackMergeCount(detail: Pick<MergeFactsDetail, "stack">): number {
  const stack = detail.stack;
  if (!stack) return 1;
  return stack.entries.filter(
    (entry) => entry.position <= stack.position && entry.state !== "merged",
  ).length;
}

/**
 * The verdict names the state of the merge and who it waits on. Specific
 * blockers (failing checks, requested changes, conflicts, a stale base) are
 * the status lines' job, so the verdict says "Blocked" rather than repeating
 * the line beneath it.
 */
export function deriveMergeVerdict(input: MergeFactsInput): MergeVerdict {
  const { detail, viewer, nextAction } = input;
  const viewerLogin = viewer?.login ?? null;
  const authorOwner = ownerOf(detail.author, viewerLogin);
  const base = { owner: null, reason: null } as const;
  switch (nextAction.kind) {
    case "merged":
      return {
        ...base,
        text: "Merged",
        owner: detail.mergedBy
          ? detail.mergedBy === viewerLogin
            ? "by you"
            : `by @${detail.mergedBy}`
          : null,
        tone: "merged",
      };
    case "closed":
      return { ...base, text: "Closed", tone: "neutral" };
    case "resolve-conflicts":
    case "update-branch":
      return { ...base, text: "Blocked", owner: authorOwner, tone: "danger" };
    case "mark-ready":
      return { ...base, text: "Draft", owner: authorOwner, tone: "neutral" };
    case "fix-checks":
    case "changes-requested":
      return nextAction.blocking
        ? { ...base, text: "Blocked", owner: authorOwner, tone: "danger" }
        : {
            ...base,
            text: "Ready to merge",
            owner: viewer?.canMerge ? "on you" : null,
            tone: "warning",
          };
    case "checks-running":
      return { ...base, text: "Waiting", owner: "on checks", tone: "progress" };
    case "awaiting-review":
      return {
        ...base,
        text: "Waiting",
        owner: listOwners(requestedReviewers(detail), viewerLogin) ?? "on a review",
        tone: "neutral",
      };
    case "auto-merge-pending":
      return { ...base, text: "Merges when green", tone: "progress" };
    case "merge":
    case "merge-stack": {
      if (nextAction.blocking) {
        return {
          ...base,
          text: "Blocked",
          tone: nextAction.tone === "danger" ? "danger" : "warning",
          reason: nextAction.reason ?? null,
        };
      }
      const count = stackMergeCount(detail);
      return {
        ...base,
        text: nextAction.kind === "merge-stack" ? `Lands ${count} layers` : "Ready to merge",
        owner: nextAction.viewerCanAct ? "on you" : null,
        tone: nextAction.tone === "progress" ? "progress" : "success",
        reason: nextAction.tone === "progress" ? (nextAction.reason ?? null) : null,
      };
    }
  }
}

// ── Status lines ─────────────────────────────────────────────────────

export type MergeStatusLineKey = "checks" | "reviews" | "conversations" | "branch";

export type MergeStatusLineTarget =
  | { readonly kind: "job"; readonly jobId: string }
  | { readonly kind: "checks" }
  | { readonly kind: "thread"; readonly threadId: string };

/** The hover ghost on a line: an agent fix, or the branch update itself. */
export type MergeStatusLineFix =
  | { readonly kind: "fix-check"; readonly label: "Fix" }
  | { readonly kind: "resolve-conflicts"; readonly label: "Fix" }
  | { readonly kind: "update-branch"; readonly label: "Update" };

export interface MergeStatusLine {
  readonly key: MergeStatusLineKey;
  readonly tone: FactTone;
  readonly text: string;
  /** Right-aligned muted detail (`8/9`, a login). */
  readonly meta: string | null;
  readonly target: MergeStatusLineTarget | null;
  readonly fix: MergeStatusLineFix | null;
}

const JOB_URL_PATTERN = /\/actions\/runs\/\d+\/jobs?\/(\d+)/u;

/** GitHub Actions job id from a check-run URL (`…/actions/runs/1/job/2`). */
export function checkJobId(check: Pick<ChangeRequestCheck, "url" | "kind">): string | null {
  if (check.kind !== "check-run" || !check.url) return null;
  return JOB_URL_PATTERN.exec(check.url)?.[1] ?? null;
}

function checksTarget(check: ChangeRequestCheck | undefined): MergeStatusLineTarget {
  const jobId = check ? checkJobId(check) : null;
  return jobId ? { kind: "job", jobId } : { kind: "checks" };
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function checksLine(checks: ChangeRequestChecksSummary): MergeStatusLine {
  const total = checks.counts.total;
  const settled = checks.checks.filter((check) => check.group !== "running").length;
  const passed = checks.groups.completed.length + checks.groups.skipped.length;
  switch (checks.overall) {
    case "failing": {
      const [worst, ...others] = checks.failing;
      return {
        key: "checks",
        tone: "danger",
        text: worst
          ? others.length > 0
            ? `${worst.label} +${others.length}`
            : worst.label
          : "Checks failing",
        meta: `${passed}/${total}`,
        target: checksTarget(worst),
        fix: { kind: "fix-check", label: "Fix" },
      };
    }
    case "pending":
      return {
        key: "checks",
        tone: "progress",
        text: `${plural(checks.groups.running.length, "check")} running`,
        meta: `${settled}/${total}`,
        target: checksTarget(checks.groups.running[0]),
        fix: null,
      };
    case "passing":
      return {
        key: "checks",
        tone: "success",
        text: "Checks passed",
        meta: `${total}/${total}`,
        target: { kind: "checks" },
        fix: null,
      };
    case "none":
      return {
        key: "checks",
        tone: "neutral",
        text: "No checks",
        meta: null,
        target: null,
        fix: null,
      };
  }
}

function whoMeta(logins: ReadonlyArray<string>): string | null {
  if (logins.length === 0) return null;
  const [first, ...rest] = logins;
  return rest.length > 0 ? `${first} +${rest.length}` : (first ?? null);
}

/** The next unresolved thread, preferring one opened by `preferAuthors`. */
export function nextUnresolvedThread(
  threads: ReadonlyArray<ChangeRequestReviewThread>,
  preferAuthors: ReadonlyArray<string> = [],
): ChangeRequestReviewThread | null {
  const unresolved = threads.filter((thread) => !thread.isResolved);
  const preferred = unresolved.find((thread) =>
    preferAuthors.includes(thread.comments[0]?.author.login ?? ""),
  );
  return preferred ?? unresolved[0] ?? null;
}

function reviewsLine(input: MergeFactsInput): MergeStatusLine | null {
  const { detail, nextAction, threads } = input;
  const states = detail.reviewerStates ?? [];
  const requesters = states
    .filter((reviewer) => reviewer.state === "changes_requested")
    .map((reviewer) => reviewer.login);
  if (detail.reviewDecision === "changes_requested" || requesters.length > 0) {
    const thread = nextUnresolvedThread(threads, requesters);
    return {
      key: "reviews",
      tone: "danger",
      text: "Changes requested",
      meta: whoMeta(requesters),
      target: thread ? { kind: "thread", threadId: thread.id } : null,
      fix: null,
    };
  }
  const approvers = states
    .filter((reviewer) => reviewer.state === "approved")
    .map((reviewer) => reviewer.login);
  if (detail.reviewDecision === "approved" || approvers.length > 0) {
    return {
      key: "reviews",
      tone: "success",
      text: "Approved",
      meta: whoMeta(approvers),
      target: null,
      fix: null,
    };
  }
  const requested = requestedReviewers(detail);
  if (detail.reviewDecision === "review_required" || requested.length > 0) {
    return {
      key: "reviews",
      tone: "neutral",
      text: "Review required",
      // The verdict already names who it waits on while awaiting review.
      meta: nextAction.kind === "awaiting-review" ? null : whoMeta(requested),
      target: null,
      fix: null,
    };
  }
  return null;
}

function conversationsLine(threads: ReadonlyArray<ChangeRequestReviewThread>) {
  if (threads.length === 0) return null;
  const unresolved = threads.filter((thread) => !thread.isResolved);
  const next = unresolved[0];
  if (!next) {
    return {
      key: "conversations",
      tone: "success",
      text: "Conversations resolved",
      meta: null,
      target: null,
      fix: null,
    } satisfies MergeStatusLine;
  }
  return {
    key: "conversations",
    tone: "warning",
    text: `${unresolved.length} unresolved`,
    meta: null,
    target: { kind: "thread", threadId: next.id },
    fix: null,
  } satisfies MergeStatusLine;
}

function branchLine(input: MergeFactsInput): MergeStatusLine {
  // The base branch is already on the masthead's meta line; the line says only how it relates.
  const { detail, viewer } = input;
  if (detail.mergeability === "conflicting" || detail.mergeStateStatus === "dirty") {
    return {
      key: "branch",
      tone: "danger",
      text: "Merge conflicts",
      meta: null,
      target: null,
      fix: { kind: "resolve-conflicts", label: "Fix" },
    };
  }
  if (detail.mergeStateStatus === "behind") {
    return {
      key: "branch",
      tone: "warning",
      text: "Branch out of date",
      meta: null,
      target: null,
      fix: viewer?.canUpdateBranch === false ? null : { kind: "update-branch", label: "Update" },
    };
  }
  // A draft keeps reporting its base here: the verdict already reads "Draft".
  return {
    key: "branch",
    tone: "success",
    text: "Branch up to date",
    meta: null,
    target: null,
    fix: null,
  };
}

const TONE_RANK: Record<FactTone, number> = {
  danger: 0,
  warning: 1,
  progress: 2,
  neutral: 3,
  success: 4,
  merged: 5,
};

/**
 * Up to four lines (checks, reviews, conversations, branch) for an open
 * change request, most urgent first so the eye lands on what blocks the merge.
 * Closed and merged change requests have none.
 */
export function deriveMergeStatusLines(input: MergeFactsInput): ReadonlyArray<MergeStatusLine> {
  if (input.detail.state !== "open") return [];
  const lines: MergeStatusLine[] = [checksLine(input.checks)];
  if (input.detail.isDraft !== true) {
    const reviews = reviewsLine(input);
    if (reviews) lines.push(reviews);
  }
  const conversations = conversationsLine(input.threads);
  if (conversations) lines.push(conversations);
  lines.push(branchLine(input));
  return lines
    .map((line, index) => ({ line, index }))
    .toSorted(
      (left, right) =>
        TONE_RANK[left.line.tone] - TONE_RANK[right.line.tone] || left.index - right.index,
    )
    .map(({ line }) => line);
}

// ── Merge methods ────────────────────────────────────────────────────

export const MERGE_METHODS: ReadonlyArray<SourceControlChangeRequestMergeMethod> = [
  "squash",
  "merge",
  "rebase",
];

export const MERGE_METHOD_LABEL: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/** Button wording: GitHub's own ("Merge pull request" for a merge commit). */
export const MERGE_METHOD_ACTION: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Merge pull request",
  rebase: "Rebase and merge",
};

export const MERGE_METHOD_CONFIRM: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "Confirm squash and merge",
  merge: "Confirm merge",
  rebase: "Confirm rebase and merge",
};

export const MERGE_METHOD_HINT: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "One commit on the base branch",
  merge: "Keeps every commit plus a merge commit",
  rebase: "Replays every commit onto the base",
};

export interface MergeMethodOption {
  readonly method: SourceControlChangeRequestMergeMethod;
  readonly label: string;
  /** Why this method cannot be picked, or null when it can. */
  readonly disabledReason: string | null;
}

export function mergeMethodOptions(
  detail: Pick<MergeFactsDetail, "mergeCapabilities">,
): ReadonlyArray<MergeMethodOption> {
  return MERGE_METHODS.map((method) => ({
    method,
    label: MERGE_METHOD_LABEL[method],
    disabledReason:
      detail.mergeCapabilities && !detail.mergeCapabilities[method]
        ? "Not allowed in this repository"
        : null,
  }));
}

/** The preferred method when the host allows it, else the first it allows. */
export function resolveMergeMethod(
  detail: Pick<MergeFactsDetail, "mergeCapabilities">,
  preferred: SourceControlChangeRequestMergeMethod | null,
): SourceControlChangeRequestMergeMethod {
  const allowed = mergeMethodOptions(detail).filter((option) => option.disabledReason === null);
  if (preferred && allowed.some((option) => option.method === preferred)) return preferred;
  return allowed[0]?.method ?? preferred ?? "squash";
}

// ── Next action button ───────────────────────────────────────────────

export type NextActionCommand =
  | { readonly type: "checkout-worktree" }
  | { readonly type: "update-branch"; readonly method: "merge" | "rebase" }
  | { readonly type: "set-draft"; readonly draft: boolean }
  | { readonly type: "reveal-job"; readonly jobId: string }
  | { readonly type: "open-checks" }
  | { readonly type: "open-files" }
  | { readonly type: "reveal-thread"; readonly threadId: string }
  | { readonly type: "request-review" }
  | { readonly type: "enable-auto-merge" }
  | { readonly type: "disable-auto-merge" }
  | { readonly type: "merge" }
  | { readonly type: "merge-stack" }
  | { readonly type: "delete-branch" }
  | { readonly type: "reopen" }
  | { readonly type: "resolve-with-agent" }
  | { readonly type: "close" };

export interface NextActionButtonSpec {
  readonly label: string;
  /** Filled (neutral primary) when the step is the viewer's; outline when it is someone else's. */
  readonly variant: "filled" | "outline";
  readonly command: NextActionCommand;
  readonly disabledReason: string | null;
}

function filledWhen(canAct: boolean): "filled" | "outline" {
  return canAct ? "filled" : "outline";
}

/**
 * The merge a change request would get right now: through the stack when
 * open layers below land with it (so a lower layer that cannot land blocks
 * it), else this pull request alone.
 */
function mergeActionFor(input: MergeFactsInput): ChangeRequestNextAction {
  const { nextAction } = input;
  return nextAction.kind === "merge" || nextAction.kind === "merge-stack"
    ? nextAction
    : deriveChangeRequestMergeAction(input.detail, { viewer: input.viewer });
}

function mergeButton(
  detail: MergeFactsDetail,
  action: ChangeRequestNextAction,
  method: SourceControlChangeRequestMergeMethod,
): NextActionButtonSpec {
  const disabledReason = action.blocking ? (action.reason ?? "Cannot merge yet.") : null;
  return action.kind === "merge-stack"
    ? {
        label: `Merge stack (${stackMergeCount(detail)})`,
        variant: "filled",
        command: { type: "merge-stack" },
        disabledReason,
      }
    : {
        label: MERGE_METHOD_ACTION[method],
        variant: "filled",
        command: { type: "merge" },
        disabledReason,
      };
}

/**
 * The single button for the next step (SPEC §6 table). Returns null when the
 * change request offers no step at all (a merged branch the host already
 * deleted, a closed request the viewer cannot reopen).
 */
export function deriveNextActionButton(
  input: MergeFactsInput & { readonly method: SourceControlChangeRequestMergeMethod },
): NextActionButtonSpec | null {
  const { detail, viewer, nextAction, checks, threads, method } = input;
  const canAct = nextAction.viewerCanAct;
  const lacking = (what: string) => (canAct ? null : `You do not have permission to ${what}.`);
  switch (nextAction.kind) {
    case "resolve-conflicts":
      return {
        label: "Check out to resolve",
        variant: filledWhen(canAct),
        command: { type: "checkout-worktree" },
        disabledReason: null,
      };
    case "update-branch":
      return {
        label: "Update branch",
        variant: filledWhen(canAct),
        command: { type: "update-branch", method: "merge" },
        disabledReason: lacking("update this branch"),
      };
    case "mark-ready":
      return {
        label: "Mark ready for review",
        variant: filledWhen(canAct),
        command: { type: "set-draft", draft: false },
        disabledReason: canAct ? null : "Only the author can mark it ready for review.",
      };
    case "fix-checks": {
      const worst = checks.failing[0];
      const jobId = worst ? checkJobId(worst) : null;
      return {
        label: "View failing check",
        variant: "filled",
        command: jobId ? { type: "reveal-job", jobId } : { type: "open-checks" },
        disabledReason: null,
      };
    }
    case "checks-running":
      // Checks the host does not wait for: the step is the merge itself.
      if (!nextAction.blocking) return mergeButton(detail, mergeActionFor(input), method);
      return {
        label: "Merge when ready",
        variant: "outline",
        command: { type: "enable-auto-merge" },
        disabledReason: canAct ? null : "Auto-merge is not available to you here.",
      };
    case "changes-requested": {
      if (viewer?.isAuthor) {
        const requesters = (detail.reviewerStates ?? [])
          .filter((reviewer) => reviewer.state === "changes_requested")
          .map((reviewer) => reviewer.login);
        const thread = nextUnresolvedThread(threads, requesters);
        return {
          label: "View requested changes",
          variant: "filled",
          command: thread ? { type: "reveal-thread", threadId: thread.id } : { type: "open-files" },
          disabledReason: null,
        };
      }
      return {
        label: "Review again",
        variant: "outline",
        command: { type: "open-files" },
        disabledReason: null,
      };
    }
    case "awaiting-review":
      if (canAct) {
        return {
          label: "Start review",
          variant: "filled",
          command: { type: "open-files" },
          disabledReason: null,
        };
      }
      return {
        label: "Request review",
        variant: "outline",
        command: { type: "request-review" },
        disabledReason: viewer?.canUpdate === false ? "You cannot request reviewers here." : null,
      };
    case "auto-merge-pending":
      return {
        label: "Cancel auto-merge",
        variant: "outline",
        command: { type: "disable-auto-merge" },
        disabledReason: canAct ? null : "You cannot change auto-merge here.",
      };
    case "merged":
      if (detail.deleteBranchOnMerge === true || detail.isCrossRepository === true) return null;
      if (viewer !== null && !viewer.canUpdate) return null;
      return {
        label: "Delete branch",
        variant: "outline",
        command: { type: "delete-branch" },
        disabledReason: null,
      };
    case "closed":
      if (!canAct) return null;
      return {
        label: "Reopen",
        variant: "outline",
        command: { type: "reopen" },
        disabledReason: null,
      };
    case "merge":
    case "merge-stack":
      return mergeButton(detail, nextAction, method);
  }
}

// ── Next action menu ─────────────────────────────────────────────────

export interface NextActionMenuItem {
  readonly command: NextActionCommand;
  readonly label: string;
  readonly hint: string | null;
  readonly destructive: boolean;
}

export interface NextActionMenuModel {
  /** Merge method radio (open change requests on hosts that report capabilities). */
  readonly methods: ReadonlyArray<MergeMethodOption> | null;
  /** "Delete branch after merge" checkbox; null when it does not apply. */
  readonly deleteBranchDefault: boolean | null;
  readonly items: ReadonlyArray<NextActionMenuItem>;
}

/** Commands that only move around the page (safe on hosts without lifecycle mutations). */
export function isNavigationCommand(command: NextActionCommand): boolean {
  switch (command.type) {
    case "reveal-job":
    case "open-checks":
    case "open-files":
    case "reveal-thread":
      return true;
    default:
      return false;
  }
}

export function sameCommand(left: NextActionCommand, right: NextActionCommand): boolean {
  if (left.type !== right.type) return false;
  if (left.type === "update-branch" && right.type === "update-branch") {
    return left.method === right.method;
  }
  if (left.type === "set-draft" && right.type === "set-draft") return left.draft === right.draft;
  return true;
}

/**
 * Why a merge the host allows is offered past a step that is still open
 * (the menu item's hint).
 */
const MERGE_PAST_HINT: Partial<Record<ChangeRequestNextAction["kind"], string>> = {
  "fix-checks": "The failing checks are not required",
  "changes-requested": "Requested changes do not block merging here",
  "awaiting-review": "No approving review is required",
};

/**
 * The menu beside the button: merge method, delete-branch, then the other
 * lifecycle steps. It never offers what the button already does. When the
 * host already allows the merge but the button points at a step that is
 * still open (a failing optional check, a review it does not require), the
 * merge is offered here, so a change request read as "Ready to merge" can be.
 */
export function deriveNextActionMenu(
  input: MergeFactsInput & {
    readonly button: NextActionButtonSpec | null;
    /** The merge method the merge item and button use. */
    readonly method: SourceControlChangeRequestMergeMethod;
    /** The host implements review/lifecycle mutations (GitHub). */
    readonly supportsMutations: boolean;
    /** Agent hand-offs can start a thread. */
    readonly agentsAvailable: boolean;
  },
): NextActionMenuModel {
  const { detail, viewer, nextAction, button } = input;
  if (detail.state !== "open" || !input.supportsMutations) {
    return { methods: null, deleteBranchDefault: null, items: [] };
  }
  const canUpdate = viewer?.canUpdate ?? true;
  const items: NextActionMenuItem[] = [];
  const add = (command: NextActionCommand, label: string, hint: string | null = null) => {
    if (button && sameCommand(button.command, command)) return;
    items.push({ command, label, hint, destructive: command.type === "close" });
  };

  if (nextAction.kind === "resolve-conflicts" && input.agentsAvailable) {
    add({ type: "resolve-with-agent" }, "Resolve with an agent");
  }
  if (!nextAction.blocking) {
    const merge = mergeActionFor(input);
    // A stack merge goes through "Merge stack through…" below, which names every layer.
    if (merge.kind === "merge" && !merge.blocking) {
      add({ type: "merge" }, MERGE_METHOD_ACTION[input.method], MERGE_PAST_HINT[nextAction.kind]);
    }
  }
  if (detail.autoMerge) {
    if (viewer?.canDisableAutoMerge ?? true)
      add({ type: "disable-auto-merge" }, "Cancel auto-merge");
  } else if (
    (viewer?.canEnableAutoMerge ?? false) &&
    nextAction.blocking &&
    nextAction.kind !== "merged" &&
    nextAction.kind !== "closed"
  ) {
    add({ type: "enable-auto-merge" }, "Merge when ready", "Merges once every requirement passes");
  }
  if (detail.mergeStateStatus === "behind" && (viewer?.canUpdateBranch ?? true)) {
    add(
      { type: "update-branch", method: "merge" },
      "Update branch",
      `Merge ${detail.baseRefName} in`,
    );
    add(
      { type: "update-branch", method: "rebase" },
      "Update with rebase",
      `Replay onto ${detail.baseRefName}`,
    );
  }
  if (
    detail.stack &&
    detail.stack.entries.length > 1 &&
    detail.stackMetadataIncomplete !== true &&
    (viewer?.canMerge ?? true)
  ) {
    add({ type: "merge-stack" }, "Merge stack through…");
  }
  if (canUpdate) {
    add(
      { type: "set-draft", draft: !(detail.isDraft === true) },
      detail.isDraft === true ? "Mark ready for review" : "Convert to draft",
    );
    add({ type: "close" }, "Close pull request");
  }

  const mergeRelevant = viewer?.canMerge ?? true;
  return {
    methods: mergeRelevant && detail.mergeCapabilities ? mergeMethodOptions(detail) : null,
    deleteBranchDefault:
      mergeRelevant && detail.isCrossRepository !== true
        ? (detail.deleteBranchOnMerge ?? false)
        : null,
    items,
  };
}

/** True when the error is the host refusing a merge because the head moved. */
export function isHeadMovedError(error: unknown): boolean {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : String(error);
  return /head (?:changed|moved)|changed since it was loaded|head branch was modified/iu.test(
    message,
  );
}
