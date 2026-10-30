import { captureReviewedSendReadiness } from "@ryco/client-runtime/state/composer";
import {
  buildSubmitReviewInput,
  EMPTY_REVIEW_DRAFT,
  isHeadMovedError,
  resolveChangeRequestRefreshScope,
  reviewDraftKey,
  selectReviewDraft,
  type ChangeRequestNextAction,
  type ChangeRequestRefreshScope,
} from "@ryco/client-runtime/state/pull-request-review";
import type { ChangeRequestHostCapabilities } from "@ryco/shared/changeRequestHostCapabilities";
import type {
  ChangeRequestReviewEvent,
  ChangeRequestViewerCapabilities,
  EnvironmentId,
  SourceControlChangeRequestDetail,
  SourceControlChangeRequestMergeMethod,
} from "@ryco/contracts";
import { useState } from "react";

import { readRpcClient } from "../../connection/environmentApi";
import { useConnectionRegistry } from "../../providers/ConnectionRegistryProvider";
import { refreshPullRequestReads } from "../../rpc/pullRequestAtoms";
import {
  buildPullRequestMergeInput,
  buildPullRequestUpdateBranchInput,
  derivePullRequestActions,
  describePullRequestActionError,
  PULL_REQUEST_NOT_READY,
  type PullRequestActions,
} from "./pullRequestActionsModel";
import { usePullRequestReviewDrafts } from "./pullRequestReviewDrafts";

export type PullRequestActionKind = "review" | "merge" | "update-branch";

const CONNECTION_CHANGED = "The connection changed. Reconnect and try again.";

/** Every pull request read of the checkout: a merge or branch update moves its head. */
const CHECKOUT_SCOPE: ChangeRequestRefreshScope = {
  checkout: true,
  detail: false,
  activity: false,
  lists: false,
};

export interface PullRequestActionsControl extends PullRequestActions {
  readonly pending: PullRequestActionKind | null;
  /** Why the last change failed, until the next one starts. */
  readonly error: string | null;
  /** What the last change did ("Approved", "#42 merged."), until the next one starts. */
  readonly notice: string | null;
  readonly summary: string;
  readonly setSummary: (summary: string) => void;
  readonly setEvent: (event: ChangeRequestReviewEvent) => void;
  readonly setMethod: (method: SourceControlChangeRequestMergeMethod) => void;
  /** The "Delete branch after merge" choice; null when it does not apply. */
  readonly deleteBranch: boolean | null;
  readonly setDeleteBranch: (deleteBranch: boolean) => void;
  readonly submitReview: (onDone: () => void) => void;
  readonly runMerge: (onDone: () => void) => void;
  readonly runUpdateBranch: () => void;
}

type RpcClient = NonNullable<ReturnType<typeof readRpcClient>>;

/**
 * Review, merge and branch update for one pull request on the phone. Every
 * change is refused unless the node takes changes now, and re-checks at send
 * time that the connection it was offered on is still the current one (the
 * same capture the thread screen sends with). After the host accepts, the
 * reads the shared refresh rules name are read again.
 */
export function usePullRequestActions(input: {
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly number: number | null;
  readonly detail: SourceControlChangeRequestDetail | null;
  readonly viewer: ChangeRequestViewerCapabilities | null;
  readonly nextAction: ChangeRequestNextAction | null;
  readonly capabilities: ChangeRequestHostCapabilities;
  readonly mutationReady: boolean;
  /** Comments in a review the viewer started on the host; they are submitted too. */
  readonly hostPendingComments: number;
}): PullRequestActionsControl {
  const { environmentId, cwd, number, detail, capabilities, mutationReady } = input;
  const { driver } = useConnectionRegistry();
  const draftKey =
    environmentId !== null && cwd !== null && number !== null
      ? reviewDraftKey({ environmentId, cwd, number })
      : null;
  const draft = usePullRequestReviewDrafts((state) =>
    draftKey === null ? EMPTY_REVIEW_DRAFT : selectReviewDraft(state, draftKey),
  );
  const setDraftSummary = usePullRequestReviewDrafts((state) => state.setSummary);
  const setDraftEvent = usePullRequestReviewDrafts((state) => state.setEvent);
  const clearSubmitted = usePullRequestReviewDrafts((state) => state.clearSubmitted);
  const [method, setMethod] = useState<SourceControlChangeRequestMergeMethod | null>(null);
  const [deleteBranchChoice, setDeleteBranch] = useState<boolean | null>(null);
  const [pending, setPending] = useState<PullRequestActionKind | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const actions = derivePullRequestActions({
    detail,
    viewer: input.viewer,
    nextAction: input.nextAction,
    capabilities,
    mutationReady,
    chosenEvent: draft.event,
    chosenMethod: method,
  });
  const deleteBranchDefault = actions.merge?.deleteBranchDefault ?? null;
  const deleteBranch =
    deleteBranchDefault === null ? null : (deleteBranchChoice ?? deleteBranchDefault);

  /**
   * Sends one change: refused offline or while another is in flight, checked
   * against the connection it was offered on, and followed by the refresh its
   * scope names (the whole checkout when new commits arrived meanwhile).
   */
  const send = <T>(
    kind: PullRequestActionKind,
    perform: (client: RpcClient) => Promise<T>,
    scope: (result: T) => ChangeRequestRefreshScope,
    done: (result: T) => void,
  ) => {
    if (pending !== null || environmentId === null || cwd === null || number === null) return;
    // Read on press, never in render: the compiler would keep a render-time read.
    const client = mutationReady ? readRpcClient(environmentId) : null;
    if (client === null) {
      setError(PULL_REQUEST_NOT_READY);
      return;
    }
    const assertReady = captureReviewedSendReadiness(
      environmentId,
      () => driver.supervisor.read(environmentId),
      CONNECTION_CHANGED,
    );
    setPending(kind);
    setError(null);
    setNotice(null);
    Promise.resolve()
      .then(() => {
        assertReady();
        return perform(client);
      })
      .then(
        (result) => {
          setPending(null);
          refreshPullRequestReads({ environmentId, cwd, number, scope: scope(result) });
          done(result);
        },
        (cause: unknown) => {
          setPending(null);
          setError(describePullRequestActionError(cause));
          if (isHeadMovedError(cause)) {
            refreshPullRequestReads({ environmentId, cwd, number, scope: CHECKOUT_SCOPE });
          }
        },
      );
  };

  const submitReview = (onDone: () => void) => {
    const review = actions.review;
    if (draftKey === null || cwd === null || number === null || review === null) return;
    const built = buildSubmitReviewInput(draft, {
      cwd,
      reference: String(number),
      headSha: detail?.headSha ?? null,
      event: review.event,
      hostPendingComments: input.hostPendingComments,
    });
    if (!built.ok) {
      setError(built.message);
      return;
    }
    send(
      "review",
      (client) => client.sourceControl.submitChangeRequestReview(built.input),
      () => resolveChangeRequestRefreshScope({ kind: "review" }),
      () => {
        clearSubmitted(draftKey, {
          commentIds: built.commentIds,
          summary: built.summary,
          event: built.event,
        });
        setNotice(
          built.event === "approve"
            ? "Approved."
            : built.event === "request_changes"
              ? "Changes requested."
              : "Review submitted.",
        );
        onDone();
      },
    );
  };

  const runMerge = (onDone: () => void) => {
    const offered = actions.merge;
    if (offered === null || cwd === null || number === null) return;
    const request = buildPullRequestMergeInput({
      cwd,
      number,
      method: offered.method,
      deleteBranch,
      headSha: detail?.headSha ?? null,
      capabilities,
    });
    send(
      "merge",
      (client) => client.sourceControl.mergeChangeRequest(request),
      () => CHECKOUT_SCOPE,
      (result) => {
        setNotice(
          result.outcome === "enqueued"
            ? `#${number} merges when the queue reaches it.`
            : `#${number} merged.`,
        );
        onDone();
      },
    );
  };

  const runUpdateBranch = () => {
    const offered = actions.updateBranch;
    const headSha = detail?.headSha;
    if (offered === null || headSha === undefined || cwd === null || number === null) return;
    const request = buildPullRequestUpdateBranchInput({
      cwd,
      number,
      method: offered.method,
      headSha,
    });
    send(
      "update-branch",
      (client) => client.sourceControl.updateChangeRequest(request),
      (result) =>
        resolveChangeRequestRefreshScope({
          kind: "update",
          action: request.action,
          previous: detail,
          next: result.detail,
        }),
      () => setNotice("Branch updated."),
    );
  };

  return {
    ...actions,
    pending,
    error,
    notice,
    summary: draft.summary,
    setSummary: (summary) => {
      if (draftKey !== null) setDraftSummary(draftKey, summary);
    },
    setEvent: (event) => {
      if (draftKey !== null) setDraftEvent(draftKey, event);
    },
    setMethod,
    deleteBranch,
    setDeleteBranch,
    submitReview,
    runMerge,
    runUpdateBranch,
  };
}
