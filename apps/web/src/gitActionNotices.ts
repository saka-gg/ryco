import type { ToastManagerAddOptions } from "@base-ui/react/toast";
import type { GitStackedAction } from "@ryco/contracts";
import { useEffect, useState } from "react";

import { stackedThreadToast, toastManager, type ThreadToastData } from "./components/ui/toast";

/**
 * Where a user-started git action (pull, commit, push, pull request) reports
 * its progress and result: the crown showing that checkout when one presents
 * it, otherwise the regular toasts. Each report picks its surface anew, so an
 * action whose crown goes away mid-run still ends on a toast.
 */

export type GitActionNoticeKind = "pull" | "commit" | "push" | "pr";
export type GitActionNoticeStatus = "running" | "success" | "error";

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
  /** A follow-up offered with a result ("View PR", "Create PR"). */
  readonly action?: GitActionNoticeAction | undefined;
}

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
  readonly running: (title: string, description?: string) => void;
  readonly succeeded: (result: {
    readonly title: string;
    readonly description?: string | undefined;
    readonly action?: GitActionNoticeAction | undefined;
  }) => void;
  readonly failed: (failure: { readonly title: string; readonly description?: string }) => void;
}

/** Results stay up this long once seen (toasts only; the crown keeps its own dwell). */
const RESULT_TOAST_VISIBLE_MS = 10_000;

export function createGitActionReporter(input: {
  readonly id: string;
  readonly kind: GitActionNoticeKind;
  readonly environmentId: string | null;
  readonly cwd: string | null;
  readonly toastData?: ThreadToastData | undefined;
}): GitActionReporter {
  const { toastData } = input;
  let toastId: ReturnType<typeof toastManager.add> | null = null;

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
    else toastManager.update(toastId, options);
  };

  return {
    running: (title, description) =>
      report({ status: "running", title, description }, () => ({
        type: "loading",
        title,
        ...(description !== undefined ? { description } : {}),
        timeout: 0,
        ...(toastData !== undefined ? { data: toastData } : {}),
      })),
    succeeded: ({ title, description, action }) =>
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
      }),
    failed: ({ title, description }) =>
      report({ status: "error", title, description }, () =>
        stackedThreadToast({
          type: "error",
          title,
          ...(description !== undefined ? { description } : {}),
          ...(toastData !== undefined ? { data: toastData } : {}),
        }),
      ),
  };
}
