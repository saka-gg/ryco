import {
  isUnarchivedThreadEntry,
  type SidebarThreadOrStub,
  type SidebarThreadSummary,
} from "@ryco/client-runtime/state/threads";
import type {
  DesktopQuitGuardResponder,
  DesktopQuitRunningChat,
  DesktopQuitRunningChatsReport,
  EnvironmentId,
} from "@ryco/contracts";

import { interruptibleThreadStatus } from "./desktopRelaunchGuard.logic";

/**
 * Chats the quit dialog names; the rest are counted. Desktop main shows at most as many
 * (`QUIT_DIALOG_MAX_CHATS`) whatever a window sends. Not shared through `@ryco/contracts`:
 * a value in its ipc module, imported from this lazy chunk, splits that module into a chunk
 * of its own, past the web bundle budgets.
 */
export const DESKTOP_QUIT_LISTED_CHATS = 8;

/** When the thread's current work started, as an ISO string (they order as text). */
function startedAt(thread: SidebarThreadSummary): string {
  return (
    thread.latestTurn?.requestedAt ??
    thread.latestUserMessageAt ??
    thread.updatedAt ??
    thread.createdAt
  );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * The chats on this desktop's own backend that quitting would stop, most recently started
 * first. `unknown` while the local environment is not known or has no live snapshot: rows
 * hydrated from the cache, or held over a reconnect, show nothing running whatever the backend
 * is doing (the relaunch guard's rule).
 */
export function buildDesktopQuitRunningChatsReport(input: {
  readonly threads: ReadonlyArray<SidebarThreadOrStub>;
  readonly localEnvironmentId: EnvironmentId | null;
  readonly localEnvironmentLive: boolean;
  readonly continueThreadsAfterRestart: boolean | null;
}): DesktopQuitRunningChatsReport {
  const { localEnvironmentId } = input;
  if (localEnvironmentId === null || !input.localEnvironmentLive) return { status: "unknown" };
  const running: Array<{
    readonly thread: SidebarThreadSummary;
    readonly chat: DesktopQuitRunningChat;
  }> = [];
  let resumableCount = 0;
  let otherNodesRunningCount = 0;
  for (const thread of input.threads) {
    if (!isUnarchivedThreadEntry(thread)) continue;
    const status = interruptibleThreadStatus(thread);
    if (status === null) continue;
    if (thread.environmentId !== localEnvironmentId) {
      otherNodesRunningCount += 1;
      continue;
    }
    if (status === "working") resumableCount += 1;
    running.push({ thread, chat: { threadId: thread.id, title: thread.title, status } });
  }
  running.sort(
    (left, right) =>
      compareText(startedAt(right.thread), startedAt(left.thread)) ||
      compareText(left.thread.id, right.thread.id),
  );
  return {
    status: "known",
    runningCount: running.length,
    resumableCount,
    chats: running.slice(0, DESKTOP_QUIT_LISTED_CHATS).map((entry) => entry.chat),
    otherNodesRunningCount,
    continueThreadsAfterRestart: input.continueThreadsAfterRestart,
  };
}

/** The window's answers to Desktop main before a quit, read from the stores when asked. */
export function createDesktopQuitGuardResponder(deps: {
  readonly readThreads: () => ReadonlyArray<SidebarThreadOrStub>;
  readonly readLocalEnvironment: () => {
    readonly id: EnvironmentId | null;
    readonly live: boolean;
  };
  readonly readContinueSetting: () => boolean | null;
  readonly writeContinueSetting: (enabled: boolean) => Promise<void>;
}): DesktopQuitGuardResponder {
  return {
    runningChats: () => {
      const local = deps.readLocalEnvironment();
      return buildDesktopQuitRunningChatsReport({
        threads: deps.readThreads(),
        localEnvironmentId: local.id,
        localEnvironmentLive: local.live,
        continueThreadsAfterRestart: deps.readContinueSetting(),
      });
    },
    setContinueAfterRestart: (enabled) => deps.writeContinueSetting(enabled),
  };
}
