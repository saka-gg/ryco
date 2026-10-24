import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import type {
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  SidebarAutoSettleAfterDays,
} from "@ryco/contracts";
import { resolveSnoozePresets } from "@ryco/shared/threadSnooze";
import { useEffect, useLayoutEffect, useRef } from "react";

import { type CurrentThreadLifecycle, useCommandPaletteStore } from "../../commandPaletteStore";
import { getClientSettings } from "../../hooks/useSettings";
import { resolveShortcutCommand, type ShortcutMatchContext } from "../../keybindings";
import { isComposerFocused } from "../../lib/composerFocus";
import { sidebarUndo } from "../../sidebarUndo";
import {
  dispatchThreadSettlement,
  dispatchThreadSnooze,
  requestThreadArchive,
} from "../../threadLifecycleCommands";
import {
  isUnarchivedThreadEntry,
  type Project,
  type SidebarThreadOrStub,
  type SidebarWorktreeSummary,
} from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import { formatInboxDayTime } from "../inboxSidebar/inboxRowPresentation";
import {
  resolveCurrentThreadLifecycle,
  threadLifecycleDisabledReason,
  type InboxSidebarEnvironment,
} from "../inboxSidebar/inboxSidebarModel";
import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  createThreadUndoShortcut,
  resolveUndoShortcutOwner,
  runThreadLifecycleShortcut,
  shouldIgnoreThreadLifecycleShortcut,
  threadLifecycleActionForCommand,
  UNDO_SHORTCUT_EDIT_EVENTS,
} from "./threadLifecycleShortcuts.logic";

export interface ThreadLifecycleShortcutsProps {
  readonly routeThreadRef: ScopedThreadRef | null;
  readonly threadByKey: ReadonlyMap<string, SidebarThreadOrStub>;
  readonly projects: ReadonlyArray<Project>;
  readonly worktrees: ReadonlyArray<SidebarWorktreeSummary>;
  readonly environments: ReadonlyArray<InboxSidebarEnvironment>;
  readonly localQueuedThreadKeys: ReadonlySet<string>;
  readonly deliveryUnknownThreadKeys: ReadonlySet<string>;
  readonly pinnedThreadKeys: ReadonlySet<string>;
  readonly autoSettleAfterDays: SidebarAutoSettleAfterDays;
  readonly archiveThread: (target: ScopedThreadRef) => Promise<void>;
  readonly keybindings: ResolvedKeybindingsConfig;
  readonly readShortcutContext: () => Partial<ShortcutMatchContext>;
}

const SHORTCUT_UI = {
  notify: (reason: string) => {
    toastManager.add(stackedThreadToast({ type: "info", title: reason }));
  },
  pickSnoozeTime: () => useCommandPaletteStore.getState().openSnoozeThread(),
};

function readCurrentThreadLifecycle(
  props: ThreadLifecycleShortcutsProps,
): CurrentThreadLifecycle | null {
  const thread = props.routeThreadRef
    ? props.threadByKey.get(scopedThreadKey(props.routeThreadRef))
    : undefined;
  // An archived thread is not in the inbox, so it has nothing to settle or snooze.
  if (thread === undefined || !isUnarchivedThreadEntry(thread)) return null;
  const lifecycle = resolveCurrentThreadLifecycle({
    thread,
    projects: props.projects,
    worktrees: props.worktrees,
    environments: props.environments,
    localQueuedThreadKeys: props.localQueuedThreadKeys,
    deliveryUnknownThreadKeys: props.deliveryUnknownThreadKeys,
    pinnedThreadKeys: props.pinnedThreadKeys,
    autoSettleAfterDays: props.autoSettleAfterDays,
    nowMs: Date.now(),
  });
  if (lifecycle === null) return null;
  const { target, title, availability } = lifecycle;
  return {
    title,
    settled: availability.settle.settled,
    snoozed: availability.snooze.snoozedUntil !== null,
    disabledReasons: {
      settle: threadLifecycleDisabledReason(availability, "settle"),
      snooze: threadLifecycleDisabledReason(availability, "snooze"),
      archive: threadLifecycleDisabledReason(availability, "archive"),
      markUnread: threadLifecycleDisabledReason(availability, "markUnread"),
    },
    snoozeOptions: () =>
      resolveSnoozePresets(new Date()).map(({ id, label, snoozedUntil }) => ({
        id,
        label,
        snoozedUntil,
        timeLabel: formatInboxDayTime(snoozedUntil),
      })),
    setSettled: (settled) => void dispatchThreadSettlement(target, settled),
    snooze: (snoozedUntil) => void dispatchThreadSnooze(target, snoozedUntil),
    archive: () =>
      void requestThreadArchive({
        target,
        thread,
        isDraft: false,
        confirmThreadArchive: getClientSettings().confirmThreadArchive,
        archiveThread: props.archiveThread,
      }),
    markUnread: () => {
      // The open thread stays unread until it is left (see ChatView's read marker).
      useUiStateStore
        .getState()
        .markThreadUnread(scopedThreadKey(target), thread.latestTurn?.completedAt);
      toastManager.add(
        stackedThreadToast({ type: "info", title: "Thread marked unread", description: title }),
      );
    },
  };
}

/**
 * Settle, snooze, archive and mark unread for the open thread: their keyboard
 * shortcuts, and what the command palette offers. Also the Undo shortcut for
 * the newest Undo notice. Only the sidebar has the inbox's inputs, so it
 * renders this once. It subscribes to nothing and decides nothing until a
 * shortcut or the palette asks.
 */
export function ThreadLifecycleShortcuts(props: ThreadLifecycleShortcutsProps) {
  // Read at call time, so the reader and the listener stay registered for the mount.
  const latestProps = useRef(props);
  useLayoutEffect(() => {
    latestProps.current = props;
  });
  useEffect(() => {
    const read = () => readCurrentThreadLifecycle(latestProps.current);
    useCommandPaletteStore.setState({ readCurrentThreadLifecycle: read });
    const onWindowKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.repeat) return;
      const { keybindings, readShortcutContext } = latestProps.current;
      const action = threadLifecycleActionForCommand(
        resolveShortcutCommand(event, keybindings, {
          context: { ...readShortcutContext(), composerFocus: isComposerFocused() },
        }),
      );
      // The page is searched for dialogs and menus only for a lifecycle chord.
      if (action === null || shouldIgnoreThreadLifecycleShortcut(event)) return;
      if (!runThreadLifecycleShortcut(action, read(), SHORTCUT_UI)) return;
      event.preventDefault();
      event.stopPropagation();
    };
    // Document capture: after the keybinding recorder, which stops the keys it
    // records at the window, and before the composer's own undo.
    const undoShortcut = createThreadUndoShortcut({
      latestNoticeId: () => sidebarUndo.latest()?.id ?? null,
      undo: (noticeId) => void sidebarUndo.undo(noticeId),
      owner: (event) => {
        const { keybindings, readShortcutContext } = latestProps.current;
        return resolveUndoShortcutOwner(event, keybindings, {
          ...readShortcutContext(),
          composerFocus: isComposerFocused(),
        });
      },
    });
    window.addEventListener("keydown", onWindowKeyDown);
    document.addEventListener("keydown", undoShortcut.keydown, true);
    for (const type of UNDO_SHORTCUT_EDIT_EVENTS) {
      document.addEventListener(type, undoShortcut.edit, true);
    }
    return () => {
      window.removeEventListener("keydown", onWindowKeyDown);
      document.removeEventListener("keydown", undoShortcut.keydown, true);
      for (const type of UNDO_SHORTCUT_EDIT_EVENTS) {
        document.removeEventListener(type, undoShortcut.edit, true);
      }
      if (useCommandPaletteStore.getState().readCurrentThreadLifecycle === read) {
        useCommandPaletteStore.setState({ readCurrentThreadLifecycle: null });
      }
    };
  }, []);
  return null;
}
