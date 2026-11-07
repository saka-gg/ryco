import type { SidebarUndoNotice } from "@ryco/client-runtime/state/threads";

const ACTION_LABELS: Readonly<Record<SidebarUndoNotice["action"], string>> = {
  archive: "Task archived",
  settle: "Task settled",
  snooze: "Task snoozed",
  hide: "Task hidden",
  unpin: "Task unpinned",
};

export interface UndoNoticePresentation {
  readonly id: number;
  readonly message: string;
  readonly detail: string | undefined;
  readonly undoLabel: string;
  readonly undoDisabled: boolean;
  /** Read once the notice can be undone. */
  readonly announcement: string | null;
}

/**
 * The one notice the toast shows: the newest. A newer action replaces the
 * toast, as on the upstream phone app; older notices stay undoable from the
 * history until they lapse, but are not shown.
 */
export function presentUndoNotice(
  notices: readonly SidebarUndoNotice[],
): UndoNoticePresentation | null {
  const notice = notices.at(-1);
  if (!notice) return null;
  const label = notice.copy?.title ?? ACTION_LABELS[notice.action];
  const detail = notice.copy ? notice.copy.description : notice.threadTitle;
  return {
    id: notice.id,
    message: notice.applying ? "Updating task…" : label,
    detail,
    undoLabel:
      notice.copy?.undoLabel ??
      `Undo ${notice.action}${notice.threadTitle ? ` ${notice.threadTitle}` : ""}`,
    undoDisabled: notice.pending,
    announcement:
      notice.pending || notice.applying
        ? null
        : `${label}${notice.threadTitle ? `: ${notice.threadTitle}` : ""}. Undo available.`,
  };
}

/** A horizontal fling or drag past a quarter of the toast's width dismisses it. */
export function shouldDismissToast(input: {
  readonly translationX: number;
  readonly velocityX: number;
  readonly width: number;
}): boolean {
  "worklet";
  return (
    Math.abs(input.translationX) > input.width * 0.25 ||
    (Math.abs(input.velocityX) > 800 && input.translationX * input.velocityX > 0)
  );
}
