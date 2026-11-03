import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import { hasErrorTag } from "@ryco/client-runtime/rpc";
import type {
  GitActionProgressEvent,
  GitActionRecoveryState,
  GitCancelStackedActionResult,
  GitStackedAction,
} from "@ryco/contracts";
import { useEffect, useState } from "react";

import { stackedThreadToast, toastManager, type ThreadToastData } from "./components/ui/toast";

/**
 * Where a user-started git action (pull, commit, push, pull request) reports
 * its progress and result: the crown showing that checkout when one presents
 * it, otherwise the regular toasts. Each report picks its surface anew, so an
 * action whose crown goes away mid-run still ends on a toast.
 */

export type GitActionNoticeKind = "pull" | "commit" | "push" | "pr";
/**
 * `cancelled`: stopped before anything ran (the Ship button's grace period), or
 * stopped by the user while it ran.
 */
export type GitActionNoticeStatus = "running" | "success" | "error" | "cancelled";

export interface GitActionNoticeAction {
  readonly label: string;
  readonly onClick: () => void;
}

export interface GitActionNotice {
  /** One per action run; every report of the run shares it. */
  readonly id: string;
  readonly kind: GitActionNoticeKind;
  readonly status: GitActionNoticeStatus;
  readonly title: string;
  readonly description?: string | undefined;
  /**
   * A follow-up offered with a result ("View PR", "Create PR"), or Stop while an
   * action that outlives its connection runs. Stop acts in place: the notice
   * stays until the run reports its result.
   */
  readonly action?: GitActionNoticeAction | undefined;
}

/** Shown while a recoverable action waits for a connection that can follow it again. */
export const GIT_ACTION_RECONNECTING_DESCRIPTION = "Reconnecting... It keeps running on the node.";

/** What a stacked action announces itself as: its last step decides. */
export function gitActionNoticeKind(action: GitStackedAction): GitActionNoticeKind {
  switch (action) {
    case "commit":
      return "commit";
    case "push":
    case "commit_push":
      return "push";
    case "create_pr":
    case "commit_push_pr":
      return "pr";
  }
}

type GitActionNoticePresenter = (notice: GitActionNotice) => void;

/** Presenters by checkout; the latest one registered wins. */
const presenters = new Map<string, GitActionNoticePresenter[]>();

function scopeKey(environmentId: string, cwd: string): string {
  return JSON.stringify([environmentId, cwd]);
}

/** Routes the checkout's git notices to `presenter` until the returned release. */
export function presentGitActionNotices(
  environmentId: string,
  cwd: string,
  presenter: GitActionNoticePresenter,
): () => void {
  const key = scopeKey(environmentId, cwd);
  presenters.set(key, [...(presenters.get(key) ?? []), presenter]);
  return () => {
    const remaining = (presenters.get(key) ?? []).filter((entry) => entry !== presenter);
    if (remaining.length > 0) presenters.set(key, remaining);
    else presenters.delete(key);
  };
}

function presenterFor(environmentId: string | null, cwd: string | null) {
  if (!environmentId || !cwd) return null;
  return presenters.get(scopeKey(environmentId, cwd))?.at(-1) ?? null;
}

/**
 * The latest git notice of a checkout while this surface presents them (the
 * crown); null until an action reports, and whenever `enabled` is off.
 */
export function useGitActionNotice(
  environmentId: string | null,
  cwd: string | null,
  enabled = true,
): GitActionNotice | null {
  const [notice, setNotice] = useState<GitActionNotice | null>(null);
  useEffect(() => {
    if (!enabled || !environmentId || !cwd) return;
    const release = presentGitActionNotices(environmentId, cwd, setNotice);
    return () => {
      release();
      setNotice(null);
    };
  }, [enabled, environmentId, cwd]);
  return notice;
}

export interface GitActionReporter {
  /**
   * The run's current step and progress line. While the run reconnects, or a
   * Stop is under way, the notice says so in place of the progress line.
   */
  readonly running: (title: string, description?: string) => void;
  readonly succeeded: (result: {
    readonly title: string;
    readonly description?: string | undefined;
    readonly action?: GitActionNoticeAction | undefined;
  }) => void;
  readonly failed: (failure: { readonly title: string; readonly description?: string }) => void;
  /** Ends the run before it did anything, or after the user stopped it. */
  readonly cancelled: (result: { readonly title: string; readonly description?: string }) => void;
  /** Drops this run's toast without a result, when a follow-up run reports in its place. */
  readonly dismiss: () => void;
  /**
   * `git.runStackedAction`'s `onRecoveryState`: a run that outlives its
   * connection offers Stop (when the reporter has `stop`) and says while it
   * reconnects.
   */
  readonly onRecoveryState: (state: GitActionRecoveryState) => void;
  /**
   * Sees each progress event of the run. Stop shows once the node reported the
   * run, so it never races the start, and goes away once the action reported
   * its end: a Stop then could only skip the bookkeeping after it.
   */
  readonly onProgress: (event: GitActionProgressEvent) => void;
  /**
   * Ends the run with its rejection: "Stopped", "Couldn't confirm" when the
   * client lost track of the action, otherwise `failureTitle` with the error's
   * message. True when the checkout may have changed without a reported result
   * (stopped or unconfirmed), so the caller reads it again.
   */
  readonly rejected: (error: unknown, failureTitle: string) => boolean;
}

/** Results stay up this long once seen (toasts only; the crown keeps its own dwell). */
const RESULT_TOAST_VISIBLE_MS = 10_000;

const STOPPING_DESCRIPTION = "Stopping...";
const NOTHING_TO_STOP_DESCRIPTION = "Nothing left to stop. Waiting for the result...";
const NOT_CONNECTED_TO_STOP = "Not connected to the node. Try again once it reconnects.";

/** Where the user's Stop of a run stands. A failed one leaves Stop offered, with its reason. */
type StopState =
  | { readonly kind: "idle" }
  | { readonly kind: "stopping" }
  | { readonly kind: "nothing-to-stop" }
  | { readonly kind: "failed"; readonly message: string };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An error occurred.";
}

function stoppedDescription(error: unknown): string {
  const revoked =
    typeof error === "object" &&
    error !== null &&
    "reason" in error &&
    error.reason === "access-revoked";
  return revoked
    ? "Access to this node was revoked. Steps that already finished stay done."
    : "Steps that already finished stay done.";
}

export function createGitActionReporter(input: {
  readonly id: string;
  readonly kind: GitActionNoticeKind;
  readonly environmentId: string | null;
  readonly cwd: string | null;
  readonly toastData?: ThreadToastData | undefined;
  /**
   * Stops the run's action on the node (`git.cancelStackedAction` through the
   * environment's current connection); undefined while no connection can take
   * it. Offered as Stop only while a recoverable run is under way.
   */
  readonly stop?: (() => Promise<GitCancelStackedActionResult> | undefined) | undefined;
}): GitActionReporter {
  const { toastData } = input;
  let toastId: ReturnType<typeof toastManager.add> | null = null;
  /** The caller's latest running report; null once the run reported a result. */
  let shown: { readonly title: string; readonly description: string | undefined } | null = null;
  let recoverable = false;
  /** The node reported the run, so a Stop reaches it. */
  let reported = false;
  /** The action reported its end (`action_finished` / `action_failed`). */
  let ending = false;
  let reconnecting = false;
  let stopState: StopState = { kind: "idle" };

  const report = (
    notice: Omit<GitActionNotice, "id" | "kind">,
    toast: () => ToastManagerAddOptions<ThreadToastData>,
  ) => {
    const presenter = presenterFor(input.environmentId, input.cwd);
    if (presenter) {
      if (toastId !== null) toastManager.close(toastId);
      toastId = null;
      presenter({ id: input.id, kind: input.kind, ...notice });
      return;
    }
    const options = toast();
    if (toastId === null) toastId = toastManager.add(options);
    // An update merges into the shown toast: a report without a line or an action drops the
    // running one's ("Running for 24s", Stop) instead of keeping it under its result.
    else
      toastManager.update(toastId, { description: undefined, actionProps: undefined, ...options });
  };

  const canStop = () =>
    input.stop !== undefined &&
    recoverable &&
    reported &&
    !ending &&
    (stopState.kind === "idle" || stopState.kind === "failed");

  function renderRunning() {
    if (shown === null) return;
    const { title } = shown;
    // A Stop under way or answered says so first; a failed one's reason gives way to
    // "Reconnecting...", which usually explains it.
    const description =
      stopState.kind === "stopping"
        ? STOPPING_DESCRIPTION
        : stopState.kind === "nothing-to-stop"
          ? NOTHING_TO_STOP_DESCRIPTION
          : reconnecting
            ? GIT_ACTION_RECONNECTING_DESCRIPTION
            : stopState.kind === "failed"
              ? `Couldn't stop: ${stopState.message}`
              : shown.description;
    const action = canStop() ? stopAction : undefined;
    report({ status: "running", title, description, action }, () => ({
      type: "loading",
      title,
      ...(description !== undefined ? { description } : {}),
      ...(action ? { actionProps: { children: action.label, onClick: action.onClick } } : {}),
      timeout: 0,
      ...(toastData !== undefined ? { data: toastData } : {}),
    }));
  }

  function requestStop() {
    const stop = input.stop;
    if (!stop || !canStop()) return;
    stopState = { kind: "stopping" };
    renderRunning();
    new Promise<GitCancelStackedActionResult>((resolve, reject) => {
      const request = stop();
      if (request) request.then(resolve, reject);
      else reject(new Error(NOT_CONNECTED_TO_STOP));
    }).then(
      ({ cancelled }) => {
        // Stopped: "Stopping..." holds until the run's result replaces it.
        if (cancelled || stopState.kind !== "stopping") return;
        stopState = { kind: "nothing-to-stop" };
        renderRunning();
      },
      (error: unknown) => {
        if (stopState.kind !== "stopping") return;
        stopState = { kind: "failed", message: errorMessage(error) };
        renderRunning();
      },
    );
  }

  const stopAction: GitActionNoticeAction = { label: "Stop", onClick: requestStop };

  const reporter: GitActionReporter = {
    running: (title, description) => {
      // A failed Stop's reason shows until the run moves on to another step.
      if (stopState.kind === "failed" && shown !== null && shown.title !== title) {
        stopState = { kind: "idle" };
      }
      shown = { title, description };
      renderRunning();
    },
    succeeded: ({ title, description, action }) => {
      shown = null;
      report({ status: "success", title, description, action }, () => {
        const data = { ...toastData, dismissAfterVisibleMs: RESULT_TOAST_VISIBLE_MS };
        return action
          ? stackedThreadToast({
              type: "success",
              title,
              ...(description !== undefined ? { description } : {}),
              timeout: 0,
              actionProps: {
                children: action.label,
                onClick: () => {
                  if (toastId !== null) toastManager.close(toastId);
                  action.onClick();
                },
              },
              actionVariant: "outline",
              data,
            })
          : {
              type: "success",
              title,
              ...(description !== undefined ? { description } : {}),
              timeout: 0,
              data,
            };
      });
    },
    failed: ({ title, description }) => {
      shown = null;
      report({ status: "error", title, description }, () =>
        stackedThreadToast({
          type: "error",
          title,
          ...(description !== undefined ? { description } : {}),
          ...(toastData !== undefined ? { data: toastData } : {}),
        }),
      );
    },
    cancelled: ({ title, description }) => {
      shown = null;
      // Goes like a success once seen, rather than keeping the running toast's `timeout: 0`.
      report({ status: "cancelled", title, description }, () => ({
        type: "info",
        title,
        ...(description !== undefined ? { description } : {}),
        timeout: 0,
        data: { ...toastData, dismissAfterVisibleMs: RESULT_TOAST_VISIBLE_MS },
      }));
    },
    dismiss: () => {
      shown = null;
      if (toastId !== null) toastManager.close(toastId);
      toastId = null;
    },
    onRecoveryState: (state) => {
      if (state.kind === "started") {
        // Stop waits for the run's first progress (`onProgress`).
        recoverable = state.recoverable;
        return;
      }
      reconnecting = state.kind === "reconnecting";
      // A Stop that failed on the connection that dropped says nothing about the next one.
      if (stopState.kind === "failed") stopState = { kind: "idle" };
      renderRunning();
    },
    onProgress: (event) => {
      const offered = canStop();
      reported = true;
      if (event.kind === "action_finished" || event.kind === "action_failed") ending = true;
      if (canStop() !== offered) renderRunning();
    },
    rejected: (error, failureTitle) => {
      if (hasErrorTag(error, "GitActionStoppedError")) {
        reporter.cancelled({ title: "Stopped", description: stoppedDescription(error) });
        return true;
      }
      if (hasErrorTag(error, "GitActionResultUnavailableError")) {
        reporter.failed({
          title: "Couldn't confirm the Git action",
          description: "Check the repository status before trying again.",
        });
        return true;
      }
      reporter.failed({ title: failureTitle, description: errorMessage(error) });
      return false;
    },
  };
  return reporter;
}
