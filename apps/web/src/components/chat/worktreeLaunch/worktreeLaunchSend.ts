import {
  type EnvironmentId,
  type MessageId,
  type ThreadId,
  WORKTREE_SETUP_CANCELLED_MESSAGE,
} from "@ryco/contracts";
import { parseScopedThreadKey, scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { PROJECT_SETUP_TERMINAL_ID_PREFIX } from "@ryco/shared/projectScripts";
import {
  readWorktreeLaunch,
  startWorktreeLaunchFeed,
  stopWorktreeLaunchFeed,
  useWorktreeLaunchStore,
  type WorktreeSetupFeedApi,
} from "@ryco/client-runtime/state/worktree-setup";

import { useTerminalStateStore } from "../../../terminalStateStore";

/** The launch of a first send in `threadId`, keyed like the thread itself. */
export function worktreeLaunchKey(environmentId: EnvironmentId, threadId: ThreadId): string {
  return scopedThreadKey(scopeThreadRef(environmentId, threadId));
}

/**
 * What it takes to send a failed launch's message again, or to hand it back to
 * the composer. Held outside React: the failure outlives the send that caused
 * it, and the draft view can remount meanwhile.
 */
export interface WorktreeLaunchRetry {
  readonly messageId: MessageId;
  /** Sends the same message again under the same id. */
  readonly resend: () => Promise<boolean>;
  /** Puts the message back into the composer and drops it from the timeline. */
  readonly restore: () => void;
}

const retriesByKey = new Map<string, WorktreeLaunchRetry>();

export function readWorktreeLaunchRetry(key: string): WorktreeLaunchRetry | null {
  return retriesByKey.get(key) ?? null;
}

// The setup script's terminal starts while the setup row reports it, so it does
// not pop the terminal drawer open; its chip and "Open terminal" do that. The
// hold outlasts the hand-off a little: the start can arrive after the turn's.
const QUIET_SETUP_TERMINAL_AFTER_HANDOFF_MS = 10_000;

function setQuietSetupTerminal(key: string, quiet: boolean): void {
  const threadRef = parseScopedThreadKey(key);
  if (!threadRef) return;
  useTerminalStateStore
    .getState()
    .setQuietTerminalStart(threadRef, quiet ? PROJECT_SETUP_TERMINAL_ID_PREFIX : null);
}

export function forgetWorktreeLaunch(key: string): void {
  retriesByKey.delete(key);
  stopWorktreeLaunchFeed(key);
  setQuietSetupTerminal(key, false);
  useWorktreeLaunchStore.getState().remove(key);
}

/** The node started the turn: the agent owns the thread from here. */
export function handOffWorktreeLaunch(key: string): void {
  useWorktreeLaunchStore.getState().handOff(key);
  globalThis.setTimeout(() => {
    // Unless a newer launch of the thread holds it again.
    if (readWorktreeLaunch(key)?.phase === "handed-off") setQuietSetupTerminal(key, false);
  }, QUIET_SETUP_TERMINAL_AFTER_HANDOFF_MS);
}

export function beginWorktreeLaunch(input: {
  readonly api: WorktreeSetupFeedApi;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messageId: MessageId;
  readonly baseRef: string;
  readonly fetchOrigin: boolean;
}): string {
  const key = worktreeLaunchKey(input.environmentId, input.threadId);
  retriesByKey.delete(key);
  useWorktreeLaunchStore.getState().begin({
    key,
    environmentId: input.environmentId,
    threadId: input.threadId,
    messageId: input.messageId,
    baseRef: input.baseRef,
    fetchOrigin: input.fetchOrigin,
  });
  setQuietSetupTerminal(key, true);
  startWorktreeLaunchFeed({ api: input.api, key, threadId: input.threadId });
  return key;
}

// A failure the node never reported (the client failed first, or the node
// predates the feed) leaves the feed open; it gets this long to say more.
const FAILED_FEED_GRACE_MS = 2_000;

/**
 * Settles a launch whose send failed. A stop the user asked for returns the
 * draft to how it was (`restore`); any other failure keeps the message in the
 * timeline with the setup's failure and offers `retry`.
 * @returns whether the failure was a cancellation.
 */
export function settleFailedWorktreeLaunch(input: {
  readonly key: string;
  readonly error: unknown;
  readonly retry: WorktreeLaunchRetry;
}): "cancelled" | "failed" {
  const launch = readWorktreeLaunch(input.key);
  const message = input.error instanceof Error ? input.error.message : "Worktree setup failed.";
  if (launch?.phase === "cancelling" || message === WORKTREE_SETUP_CANCELLED_MESSAGE) {
    input.retry.restore();
    forgetWorktreeLaunch(input.key);
    return "cancelled";
  }
  retriesByKey.set(input.key, input.retry);
  setQuietSetupTerminal(input.key, false);
  useWorktreeLaunchStore.getState().fail(input.key, message);
  globalThis.setTimeout(() => {
    if (readWorktreeLaunch(input.key)?.phase === "failed") stopWorktreeLaunchFeed(input.key);
  }, FAILED_FEED_GRACE_MS);
  return "failed";
}
