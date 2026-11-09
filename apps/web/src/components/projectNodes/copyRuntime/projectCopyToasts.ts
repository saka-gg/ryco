// FILE: projectCopyToasts.ts
// Purpose: The toast a cross-node copy keeps while it runs ("Run in background",
//          "Cancel") and the one it ends with ("X is ready on Y · View", or the
//          failure with its retry). One toast per copy, updated in place.
// Layer: Web copy runtime, loaded with `copyManager` (never from the app shell).

import type { ToastManagerAddOptions } from "@base-ui/react/toast";

import { stackedThreadToast, toastManager, type ThreadToastData } from "../../ui/toast";
import type { ProjectCopyView } from "@ryco/client-runtime/projectCopy/progressView";

type ToastId = ReturnType<typeof toastManager.add>;

/** A finished copy's toast stays this long once seen. */
const RESULT_TOAST_VISIBLE_MS = 15_000;

interface ShownToast {
  readonly id: ToastId;
  /** What it shows, so an unchanged progress tick does not re-render it. */
  readonly key: string;
}

const toasts = new Map<string, ShownToast>();

export interface ProjectCopyProgressToastActions {
  /** Hides the toast; the copy goes on. Also what dismissing the toast does. */
  readonly onBackground: () => void;
  readonly onCancel: () => void;
}

export interface ProjectCopyResultToastActions {
  /** "View": a finished copy opens a new thread in the new project. */
  readonly onView?: (() => void) | undefined;
  /** A failure's retry (`view.retryLabel`). */
  readonly onRetry?: (() => void) | undefined;
}

/**
 * Adds the copy's toast, or updates the one it shows. A toast that went away
 * (dismissed, timed out) drops out of the map once removed, so the next report
 * adds a new one instead of updating a toast nobody sees.
 */
function present(
  copyId: string,
  key: string,
  options: ToastManagerAddOptions<ThreadToastData>,
): void {
  const shown = toasts.get(copyId);
  if (shown) {
    toastManager.update(shown.id, options);
    toasts.set(copyId, { id: shown.id, key });
    return;
  }
  const added: { id: ToastId | null } = { id: null };
  added.id = toastManager.add({
    ...options,
    onRemove: () => {
      if (added.id !== null && toasts.get(copyId)?.id === added.id) toasts.delete(copyId);
    },
  });
  toasts.set(copyId, { id: added.id, key });
}

function viewKey(view: ProjectCopyView): string {
  return JSON.stringify([view.kind, view.title, view.description, view.percent]);
}

function progressDescription(view: ProjectCopyView): string {
  return view.percent === null ? view.description : `${view.percent}% · ${view.description}`;
}

/** Shows or updates the copy's progress toast. */
export function showProjectCopyProgressToast(
  copyId: string,
  view: ProjectCopyView,
  actions: ProjectCopyProgressToastActions,
): void {
  const key = viewKey(view);
  if (toasts.get(copyId)?.key === key) return;
  const options = stackedThreadToast({
    type: "loading",
    title: view.title,
    description: progressDescription(view),
    timeout: 0,
    actionProps: {
      children: "Run in background",
      onClick: () => {
        dismissProjectCopyToast(copyId);
        actions.onBackground();
      },
    },
    actionVariant: "outline",
    data: {
      hideCopyButton: true,
      // Dismissing the toast is "Run in background", never a cancel.
      onClose: actions.onBackground,
      secondaryActionProps: {
        children: "Cancel",
        onClick: actions.onCancel,
      },
      secondaryActionVariant: "ghost",
    },
  });
  present(copyId, key, options);
}

/** Replaces the copy's toast (or adds one) with how it ended. */
export function showProjectCopyResultToast(
  copyId: string,
  view: ProjectCopyView,
  actions: ProjectCopyResultToastActions = {},
): void {
  const action =
    view.kind === "done" && actions.onView
      ? { label: "View", onClick: actions.onView }
      : view.kind === "failed" && view.retryLabel && actions.onRetry
        ? { label: view.retryLabel, onClick: actions.onRetry }
        : null;
  const type = view.kind === "done" ? "success" : view.kind === "failed" ? "error" : "info";
  const options = stackedThreadToast({
    type,
    title: view.title,
    ...(view.description.length > 0 ? { description: view.description } : {}),
    timeout: 0,
    ...(action
      ? {
          actionProps: {
            children: action.label,
            onClick: () => {
              dismissProjectCopyToast(copyId);
              action.onClick();
            },
          },
          actionVariant: "outline" as const,
        }
      : {}),
    // A failure stays until dismissed; the rest leave once seen for a while.
    ...(view.kind === "failed" ? {} : { data: { dismissAfterVisibleMs: RESULT_TOAST_VISIBLE_MS } }),
  });
  present(copyId, viewKey(view), options);
}

export interface ProjectCopyInterruptedToastActions {
  /** Reopens the copy dialog on the stopped copy. */
  readonly onResume: () => void;
  /** Gives it up and cleans up what it sent. */
  readonly onDiscard: () => void;
}

/**
 * A copy whose upload stopped when Ryco closed, offered again after a start:
 * "Resume" (the copy dialog) or "Discard". It stays until one is picked or it
 * is dismissed; the Copies block keeps offering it either way.
 */
export function showProjectCopyInterruptedToast(
  copyId: string,
  text: { readonly title: string; readonly description: string },
  actions: ProjectCopyInterruptedToastActions,
): void {
  const options = stackedThreadToast({
    type: "warning",
    title: text.title,
    description: text.description,
    timeout: 0,
    actionProps: {
      children: "Resume",
      onClick: () => {
        dismissProjectCopyToast(copyId);
        actions.onResume();
      },
    },
    actionVariant: "outline",
    data: {
      hideCopyButton: true,
      secondaryActionProps: {
        children: "Discard",
        onClick: () => {
          dismissProjectCopyToast(copyId);
          actions.onDiscard();
        },
      },
      secondaryActionVariant: "ghost",
    },
  });
  present(copyId, `interrupted:${text.title}`, options);
}

export function dismissProjectCopyToast(copyId: string): void {
  const shown = toasts.get(copyId);
  if (!shown) return;
  toasts.delete(copyId);
  toastManager.close(shown.id);
}
