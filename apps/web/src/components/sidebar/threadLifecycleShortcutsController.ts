import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import type {
  ResolvedKeybindingsConfig,
  ScopedThreadRef,
  SidebarAutoSettleAfterDays,
} from "@ryco/contracts";
import { resolveSnoozePresets } from "@ryco/shared/threadSnooze";

import { type CurrentThreadLifecycle, useCommandPaletteStore } from "../../commandPaletteStore";
import { getClientSettings } from "../../hooks/useSettings";
import { resolveShortcutCommand, type ShortcutMatchContext } from "../../keybindings";
import { isComposerFocused } from "../../lib/composerFocus";
import { sidebarUndo } from "../../sidebarUndo";
import type * as ThreadLifecycleCommandsModule from "../../threadLifecycleCommands";
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

/** The sidebar's inbox inputs, read whenever a shortcut or the palette asks. */
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

/**
 * The sidebar's thread dispatchers. Handed in rather than imported: imported by
 * this lazy module too, their module would become a chunk file of its own.
 */
export type ThreadLifecycleCommands = Pick<
  typeof ThreadLifecycleCommandsModule,
  "dispatchThreadSettlement" | "dispatchThreadSnooze" | "requestThreadArchive"
>;

const SHORTCUT_UI = {
  notify: (reason: string) => {
    toastManager.add(stackedThreadToast({ type: "info", title: reason }));
  },
  pickSnoozeTime: () => useCommandPaletteStore.getState().openSnoozeThread(),
};

function readCurrentThreadLifecycle(
  props: ThreadLifecycleShortcutsProps,
  commands: ThreadLifecycleCommands,
  /** Threads with a settle, snooze or archive the node has not answered yet. */
  pendingThreadKeys: Set<string>,
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
  const key = scopedThreadKey(target);
  const send = (dispatch: () => Promise<unknown>) => {
    if (pendingThreadKeys.has(key)) return;
    pendingThreadKeys.add(key);
    void dispatch().finally(() => pendingThreadKeys.delete(key));
  };
  return {
    title,
    settled: availability.settle.settled,
    snoozed: availability.snooze.snoozedUntil !== null,
    pending: pendingThreadKeys.has(key),
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
    setSettled: (settled) => send(() => commands.dispatchThreadSettlement(target, settled)),
    snooze: (snoozedUntil) => send(() => commands.dispatchThreadSnooze(target, snoozedUntil)),
    archive: () =>
      send(() =>
        commands.requestThreadArchive({
          target,
          thread,
          isDraft: false,
          confirmThreadArchive: getClientSettings().confirmThreadArchive,
          archiveThread: props.archiveThread,
        }),
      ),
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
 * Registers the lifecycle shortcuts, the Undo shortcut and the palette's reader
 * of the open thread's lifecycle; returns what removes them. `readProps` is read
 * at call time, so they stay registered while the sidebar re-renders.
 */
export function startThreadLifecycleShortcuts(
  readProps: () => ThreadLifecycleShortcutsProps,
  commands: ThreadLifecycleCommands,
): () => void {
  const pendingThreadKeys = new Set<string>();
  const read = () => readCurrentThreadLifecycle(readProps(), commands, pendingThreadKeys);
  useCommandPaletteStore.setState({ readCurrentThreadLifecycle: read });
  const onWindowKeyDown = (event: KeyboardEvent) => {
    if (event.defaultPrevented || event.repeat) return;
    const { keybindings, readShortcutContext } = readProps();
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
      const { keybindings, readShortcutContext } = readProps();
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
}
