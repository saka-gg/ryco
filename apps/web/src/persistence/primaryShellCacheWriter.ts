import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { parseScopedThreadKey, scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
  createThreadContentCapture,
  measureRecordBodyBytes,
  sameThreadReadingAnchors,
  selectThreadsForContentCache,
  trimContentToBudget,
  type CapturedThreadContent,
  type SavedThreadReadingAnchor,
} from "@ryco/client-runtime/state/threads";

import { selectEnvironmentState, useStore, type AppState } from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  capturePrimaryShellSnapshot,
  dropPrimaryShellCacheConversations,
  getPrimaryShellCacheBrowserStorage,
  type PrimaryShellCacheRecord,
  type PrimaryShellCacheStorage,
} from "./primaryShellCache";
import {
  subscribeThreadReadingPositionChanges,
  threadReadingPositions,
} from "./threadReadingPositions";

/**
 * Writes the primary environment's shell cache (see `primaryShellCache`):
 * its bounded metadata, the display text of its recent conversations under
 * the shared content-cache policy, and where its threads were left.
 */

/** Wait this long after the last change before writing, then for an idle moment. */
export const PRIMARY_SHELL_CACHE_WRITE_DELAY_MS = 2_000;
/**
 * Longest a change waits for its write: a turn that streams for minutes
 * never leaves the quiet the delay above waits for, and its text must still
 * reach disk.
 */
export const PRIMARY_SHELL_CACHE_MAX_WRITE_WAIT_MS = 30_000;

/** Whether this device keeps conversation text: `null` while that is not known yet. */
export type PrimaryShellCacheKeepsConversations = () => boolean | null;

export interface PrimaryShellCacheWriterInput {
  readonly environmentId: EnvironmentId;
  readonly storage?: PrimaryShellCacheStorage | null;
  readonly origin?: string;
  readonly now?: () => number;
  readonly setTimeout?: (callback: () => void, delayMs: number) => unknown;
  readonly clearTimeout?: (handle: unknown) => void;
  readonly whenIdle?: (callback: () => void) => void;
  readonly keepsConversations?: PrimaryShellCacheKeepsConversations;
  /** Calls `flush` when the page is hidden or left; returns an unsubscribe function. */
  readonly onPageHidden?: (flush: () => void) => () => void;
}

/**
 * The Desktop's "keep recent conversations" setting, read when a record is
 * written so a change applies to the next write. A loopback page has no such
 * setting and keeps them: it is the node's own machine, which holds the same
 * conversations on disk. A Desktop that cannot answer keeps none, as its
 * cache of Hub machines does.
 */
function desktopKeepsConversations(
  onChange: () => void,
  onStop: (dispose: () => void) => void,
): PrimaryShellCacheKeepsConversations {
  const bridge = globalThis.window?.desktopBridge;
  if (bridge === undefined) return () => true;
  const ask = bridge.getDesktopThreadContentCacheEnabled;
  if (!ask) return () => false;
  // Main's answer, until the workspace bridge (which follows the setting as
  // it is changed) has one of its own.
  let answered: boolean | null = null;
  let current: (() => boolean | null) | null = null;
  void ask()
    .then((enabled) => {
      answered = enabled;
    })
    .catch(() => {
      answered = false;
    });
  let stopped = false;
  onStop(() => {
    stopped = true;
  });
  void import("../platform/desktopWorkspace")
    .then((workspace) => {
      if (stopped) return;
      current = workspace.readDesktopThreadContentCacheEnabled;
      // Turned off, saved conversations go at once rather than at the next write.
      onStop(workspace.subscribeDesktopThreadContentCacheEnabled(onChange));
    })
    .catch(() => undefined);
  return () => current?.() ?? answered;
}

function subscribePageHidden(flush: () => void): () => void {
  const onVisibilityChange = () => {
    if (globalThis.document?.visibilityState === "hidden") flush();
  };
  globalThis.window?.addEventListener?.("pagehide", flush);
  globalThis.document?.addEventListener?.("visibilitychange", onVisibilityChange);
  return () => {
    globalThis.window?.removeEventListener?.("pagehide", flush);
    globalThis.document?.removeEventListener?.("visibilitychange", onVisibilityChange);
  };
}

/** The thread open in this page when it is one of `environmentId`'s (`/<environmentId>/<threadId>`). */
function readRoutedThreadId(
  environmentId: EnvironmentId,
  threadIds: ReadonlyArray<ThreadId>,
): ThreadId | null {
  const location = globalThis.window?.location;
  if (!location) return null;
  // The desktop app routes in the hash, a loopback page in the path.
  const route = location.hash.startsWith("#/") ? location.hash.slice(1) : location.pathname;
  const segments = (route.split(/[?#]/u)[0] ?? "").split("/").filter((part) => part.length > 0);
  if (segments.length !== 2) return null;
  try {
    if (decodeURIComponent(segments[0]!) !== environmentId) return null;
    const threadId = decodeURIComponent(segments[1]!);
    return threadIds.find((id) => id === threadId) ?? null;
  } catch {
    return null;
  }
}

/** This environment's remembered anchors, least recently left first. */
function captureReadingPositions(
  environmentId: EnvironmentId,
): Record<string, SavedThreadReadingAnchor> {
  const readingPositions: Record<string, SavedThreadReadingAnchor> = {};
  threadReadingPositions.forEach((key, anchor) => {
    if (parseScopedThreadKey(key)?.environmentId !== environmentId) return;
    readingPositions[key] = {
      rowId: anchor.rowId,
      offsetWithinRow: anchor.offsetWithinRow,
      ...(anchor.turnId === undefined ? {} : { turnId: anchor.turnId }),
      leftAt: anchor.leftAt,
    };
  });
  return readingPositions;
}

/** A capture reuses the entry of a thread whose messages did not change. */
function sameCapturedThreads(
  left: ReadonlyArray<CapturedThreadContent> | null,
  right: ReadonlyArray<CapturedThreadContent> | null,
): boolean {
  if (left === null || right === null) return left === right;
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

/** What a content capture was made from; an unchanged set captures nothing. */
interface ContentInputs {
  readonly metadata: string;
  readonly messageIds: unknown;
  readonly messages: unknown;
  readonly threadIds: unknown;
  readonly visits: unknown;
  readonly routedThreadId: ThreadId | null;
}

function sameContentInputs(left: ContentInputs, right: ContentInputs): boolean {
  return (
    left.metadata === right.metadata &&
    left.messageIds === right.messageIds &&
    left.messages === right.messages &&
    left.threadIds === right.threadIds &&
    left.visits === right.visits &&
    left.routedThreadId === right.routedThreadId
  );
}

/** What the last write held, so a write that would change nothing is skipped. */
interface WrittenRecord {
  readonly metadata: string;
  /** `null` when the record held no conversations. */
  readonly captured: ReadonlyArray<CapturedThreadContent> | null;
  readonly readingPositions: Readonly<Record<string, SavedThreadReadingAnchor>>;
}

const isLive = (environment: ReturnType<typeof selectEnvironmentState>) =>
  environment.bootstrapComplete && environment.hydratedFromCacheAt === undefined;

let activeWriter: (() => void) | null = null;

/**
 * Keeps the cache current while the page lives: a change to the primary
 * environment's shell, its conversations, the thread visits or a reading
 * position schedules one write after `PRIMARY_SHELL_CACHE_WRITE_DELAY_MS` of
 * quiet, or `PRIMARY_SHELL_CACHE_MAX_WRITE_WAIT_MS` after the first unwritten
 * change at the latest, at an idle moment. Hiding or leaving the page writes
 * what is waiting at once. Only a live, bootstrapped environment is written.
 * Returns a stop function.
 */
export function startPrimaryShellCacheWriter(input: PrimaryShellCacheWriterInput): () => void {
  const storage =
    input.storage === undefined ? getPrimaryShellCacheBrowserStorage() : input.storage;
  if (storage === null) return () => undefined;
  const { environmentId } = input;
  const origin = input.origin ?? window.location.origin;
  const now = input.now ?? Date.now;
  const schedule =
    input.setTimeout ?? ((callback, delayMs) => globalThis.setTimeout(callback, delayMs));
  const cancel =
    input.clearTimeout ??
    ((handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>));
  const whenIdle =
    input.whenIdle ??
    ((callback: () => void) => {
      if (typeof requestIdleCallback === "function")
        requestIdleCallback(callback, { timeout: 5_000 });
      else globalThis.setTimeout(callback, 0);
    });
  const disposers: Array<() => void> = [];
  const keepsConversations =
    input.keepsConversations ??
    desktopKeepsConversations(
      () => {
        // Turned off: what is saved goes now, also when this session has not
        // written the record yet (the machine may never connect before quit).
        if (!stopped && keepsConversations() === false) {
          void dropPrimaryShellCacheConversations(storage, origin);
        }
        flush();
      },
      (dispose) => disposers.push(dispose),
    );
  const threadContentCapture = createThreadContentCapture();
  let stopped = false;
  let delayTimer: unknown = null;
  let maxWaitTimer: unknown = null;
  let lastWritten: WrittenRecord | null = null;
  let lastCapture: {
    readonly inputs: ContentInputs;
    readonly captured: ReadonlyArray<CapturedThreadContent>;
  } | null = null;

  const captureContent = (
    state: AppState,
    metadata: string,
    snapshotThreadIds: ReadonlySet<string>,
  ): ReadonlyArray<CapturedThreadContent> => {
    const environment = selectEnvironmentState(state, environmentId);
    const visits = useUiStateStore.getState().threadLastVisitedAtById;
    const inputs: ContentInputs = {
      metadata,
      messageIds: environment.messageIdsByThreadId,
      messages: environment.messageByThreadId,
      threadIds: environment.threadIds,
      visits,
      routedThreadId: readRoutedThreadId(environmentId, environment.threadIds),
    };
    if (lastCapture && sameContentInputs(lastCapture.inputs, inputs)) return lastCapture.captured;
    const captured = threadContentCapture.capture(
      environmentId,
      environment,
      selectThreadsForContentCache({
        // A thread the bounded metadata left out could not be read back.
        threadIds: environment.threadIds.filter((id) => snapshotThreadIds.has(id)),
        hasMessages: (id) => (environment.messageIdsByThreadId[id]?.length ?? 0) > 0,
        routedThreadId: inputs.routedThreadId,
        lastVisitedAt: (id) => visits[scopedThreadKey({ environmentId, threadId: id })],
      }),
    );
    lastCapture = { inputs, captured };
    return captured;
  };

  const write = () => {
    if (stopped) return;
    const state = useStore.getState();
    const snapshot = capturePrimaryShellSnapshot(environmentId, state, now());
    if (snapshot === null) return;
    const keeps = keepsConversations();
    // Not known yet: written once it is, rather than dropping what is saved.
    if (keeps === null) {
      scheduleWrite();
      return;
    }
    const { capturedAt: _capturedAt, ...metadataContent } = snapshot;
    const metadata = JSON.stringify(metadataContent);
    const readingPositions = captureReadingPositions(environmentId);
    let captured: ReadonlyArray<CapturedThreadContent> | null = null;
    if (keeps) {
      captured = captureContent(
        state,
        metadata,
        new Set(snapshot.threads.map((thread) => thread.id as string)),
      );
    } else {
      threadContentCapture.clear();
      lastCapture = null;
    }
    if (
      lastWritten !== null &&
      lastWritten.metadata === metadata &&
      sameCapturedThreads(lastWritten.captured, captured) &&
      sameThreadReadingAnchors(lastWritten.readingPositions, readingPositions)
    )
      return;
    const body = {
      origin,
      environmentId,
      savedAt: snapshot.capturedAt,
      snapshot,
      readingPositions,
    };
    // Display history is trimmed (least recently visited first) before the
    // record may exceed the shared per-record budget.
    const record: PrimaryShellCacheRecord =
      captured === null
        ? body
        : {
            ...body,
            content: Object.fromEntries(
              trimContentToBudget({
                bodyBytes: measureRecordBodyBytes(body),
                entries: captured,
                budgetBytes: THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
              }).map((thread) => [thread.threadId, thread.content]),
            ),
          };
    const written: WrittenRecord = { metadata, captured, readingPositions };
    lastWritten = written;
    void storage.write(record).catch(() => {
      // Retried by the next write.
      if (lastWritten === written) lastWritten = null;
    });
  };

  const clearTimers = () => {
    if (delayTimer !== null) cancel(delayTimer);
    if (maxWaitTimer !== null) cancel(maxWaitTimer);
    delayTimer = null;
    maxWaitTimer = null;
  };
  const fire = () => {
    clearTimers();
    whenIdle(write);
  };
  function scheduleWrite() {
    if (stopped || !isLive(selectEnvironmentState(useStore.getState(), environmentId))) return;
    if (delayTimer !== null) cancel(delayTimer);
    delayTimer = schedule(fire, PRIMARY_SHELL_CACHE_WRITE_DELAY_MS);
    maxWaitTimer ??= schedule(fire, PRIMARY_SHELL_CACHE_MAX_WRITE_WAIT_MS);
  }
  /**
   * A page being hidden or left writes what is waiting now, and also a record
   * whose conversations the setting has since turned off (or on).
   */
  const flush = () => {
    if (stopped) return;
    const settingChanged =
      lastWritten !== null && (lastWritten.captured !== null) !== (keepsConversations() === true);
    if (delayTimer === null && maxWaitTimer === null && !settingChanged) return;
    clearTimers();
    write();
  };

  let observed = selectEnvironmentState(useStore.getState(), environmentId);
  const unsubscribeStore = useStore.subscribe((state) => {
    const environment = selectEnvironmentState(state, environmentId);
    if (environment === observed) return;
    observed = environment;
    scheduleWrite();
  });
  const unsubscribeVisits = useUiStateStore.subscribe((state, previous) => {
    if (state.threadLastVisitedAtById !== previous.threadLastVisitedAtById) scheduleWrite();
  });
  const unsubscribeReadingPositions = subscribeThreadReadingPositionChanges(scheduleWrite);
  const unsubscribePageHidden = (input.onPageHidden ?? subscribePageHidden)(flush);
  scheduleWrite();
  // One writer per page: a later start (a re-run boot) replaces the earlier one.
  activeWriter?.();
  const stop = () => {
    if (stopped) return;
    stopped = true;
    unsubscribeStore();
    unsubscribeVisits();
    unsubscribeReadingPositions();
    unsubscribePageHidden();
    for (const dispose of disposers.splice(0)) dispose();
    clearTimers();
    threadContentCapture.clear();
    lastCapture = null;
    if (activeWriter === stop) activeWriter = null;
  };
  activeWriter = stop;
  return stop;
}
