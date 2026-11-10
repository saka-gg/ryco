/**
 * Hands main the display content of each live machine's recent conversations
 * (the Desktop's encrypted conversation cache). Desktop-only and loaded once
 * the setting keeps conversations, so none of it is on the first download.
 *
 * Main re-encrypts and rewrites a machine's file for each publication, so a
 * streaming conversation is handed over at most every
 * `THREAD_CONTENT_STREAMING_PUBLISH_INTERVAL_MS`, and only the threads that
 * changed since what main confirmed holding travel over IPC. A turn's end, a
 * thread switch and a hidden or closing window hand over what waits at once.
 */
import {
  ThreadId,
  type DesktopWorkspaceStateProjection,
  type EnvironmentId,
} from "@ryco/contracts";
import { scopedThreadKey } from "@ryco/client-runtime/scoped";
import {
  THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
  createThreadContentCapture,
  measureRecordBodyBytes,
  selectThreadsForContentCache,
  trimContentToBudget,
  type CapturedThreadContent,
} from "@ryco/client-runtime/state/threads";
import { listRunningThreadKeys } from "@ryco/client-runtime/state/threads/runningThreads";

import { readPrimaryEnvironmentDescriptor } from "../environments/primary";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";

/** Changes to conversations are handed to main at most this often... */
const THREAD_CONTENT_PUBLISH_THROTTLE_MS = 2_000;
/**
 * ...and while a turn runs anywhere, at most this often: every streamed token
 * changes a conversation, and main re-encrypts and rewrites the machine's file
 * for each publication. The turn's end, a thread switch and a hidden window
 * hand over what is waiting at once.
 */
export const THREAD_CONTENT_STREAMING_PUBLISH_INTERVAL_MS = 20_000;
/** Running threads looked at to notice a turn's end; more running at once is unusual. */
const RUNNING_THREADS_WATCHED = 64;

/** What the content of an environment was last captured from, and what that captured. */
interface ThreadContentPublication {
  readonly inputs: ThreadContentInputs;
  readonly captured: ReadonlyArray<CapturedThreadContent>;
}

/**
 * The thread entries main holds for an environment, as last confirmed by it: a
 * publication sends only the entries that differ. `null` until main confirmed
 * one, or after it refused one, so the next publication sends every thread.
 */
type AcknowledgedThreadContent = ReadonlyMap<string, CapturedThreadContent> | null;

/**
 * The store replaces a message list when it changes, so identical lists mean
 * identical content without looking at it. Visits and the open thread decide
 * which conversations are kept, so they are inputs too.
 */
interface ThreadContentInputs {
  readonly messageIds: unknown;
  readonly messages: unknown;
  readonly threadIds: unknown;
  readonly visits: unknown;
  readonly routedThreadId: string | null;
}

function sameThreadContentInputs(left: ThreadContentInputs, right: ThreadContentInputs): boolean {
  return (
    left.messageIds === right.messageIds &&
    left.messages === right.messages &&
    left.threadIds === right.threadIds &&
    left.visits === right.visits &&
    left.routedThreadId === right.routedThreadId
  );
}

/** A capture reuses the entry of a thread whose messages did not change. */
function sameCapturedThreads(
  left: ReadonlyArray<CapturedThreadContent>,
  right: ReadonlyArray<CapturedThreadContent>,
): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function sameOrder(
  acknowledged: ReadonlyMap<string, CapturedThreadContent>,
  kept: ReadonlyArray<CapturedThreadContent>,
): boolean {
  if (acknowledged.size !== kept.length) return false;
  let index = 0;
  for (const threadId of acknowledged.keys()) {
    if (kept[index]?.threadId !== threadId) return false;
    index += 1;
  }
  return true;
}

type DesktopBridgeThreadContentChanges = NonNullable<
  Window["desktopBridge"]
>["publishDesktopThreadContentChanges"];

/** The thread open in this window, from its hash route (`#/<environmentId>/<threadId>`). */
function readRoutedThread(): { environmentId: string; threadId: string } | null {
  const route =
    (globalThis.window?.location?.hash ?? "").replace(/^#/u, "").split(/[?#]/u)[0] ?? "";
  const segments = route.split("/").filter((segment) => segment.length > 0);
  if (segments.length !== 2) return null;
  try {
    return {
      environmentId: decodeURIComponent(segments[0]!),
      threadId: decodeURIComponent(segments[1]!),
    };
  } catch {
    return null;
  }
}

export interface DesktopThreadContentPublisher {
  /** A change that may need publishing: published after the throttle. */
  readonly schedule: () => void;
  /** A store update: a turn that ended or a thread switch publishes at once. */
  readonly noteStoreChange: (state: ReturnType<typeof useStore.getState>) => void;
  /** An environment no longer kept: its publications and captures go. */
  readonly forget: (environmentId: EnvironmentId) => void;
  /** Starts from scratch (another account, or the setting turned off). */
  readonly reset: () => void;
  readonly dispose: () => void;
}

export function createDesktopThreadContentPublisher(input: {
  readonly bridge: NonNullable<Window["desktopBridge"]>;
  readonly readMachines: () => Pick<
    DesktopWorkspaceStateProjection,
    "accountId" | "machines" | "localEnvironmentId"
  >;
  /** Whether conversations are kept and the workspace bridge still runs. */
  readonly isEnabled: () => boolean;
}): DesktopThreadContentPublisher {
  const { bridge } = input;
  let disposed = false;
  const active = () => !disposed && input.isEnabled();
  const threadContentCapture = createThreadContentCapture();
  const threadContentPublications = new Map<EnvironmentId, ThreadContentPublication>();
  const acknowledgedThreadContent = new Map<EnvironmentId, AcknowledgedThreadContent>();
  /** The environments with a publication on its way to main (one at a time each). */
  const threadContentInFlight = new Set<EnvironmentId>();
  let threadContentTimer: ReturnType<typeof setTimeout> | null = null;
  let threadContentDueAt = 0;
  let runningThreadKeys: ReadonlySet<string> = new Set();
  let routedThreadKey: string | null = null;
  /**
   * Hands main the display content of each live machine's recent conversations
   * when it changed. Nothing is serialized for a store update that left the
   * message lists, the visits and the open thread as they were.
   */
  const publishThreadContent = () => {
    const publish = bridge.publishDesktopThreadContent;
    if (!publish || !active()) return;
    const primaryEnvironmentId = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
    const routed = readRoutedThread();
    const visits = useUiStateStore.getState().threadLastVisitedAtById;
    const current = input.readMachines();
    for (const machine of current.machines) {
      if (!machine.canReadMetadata) continue;
      // The local server is shown from the primary environment, never from a copy
      // painted from the cache, so there is nothing to hydrate its content into.
      if (
        primaryEnvironmentId !== null &&
        machine.environmentId === current.localEnvironmentId &&
        machine.environmentId !== primaryEnvironmentId
      ) {
        continue;
      }
      const environment = useStore.getState().environmentStateById[machine.environmentId];
      // Content painted from the cache is already owned by main; echoing it back
      // would make offline data look newly captured.
      if (!environment?.bootstrapComplete || environment.hydratedFromCacheAt !== undefined)
        continue;
      const routedThreadId =
        routed?.environmentId === machine.environmentId ? ThreadId.make(routed.threadId) : null;
      const inputs: ThreadContentInputs = {
        messageIds: environment.messageIdsByThreadId,
        messages: environment.messageByThreadId,
        threadIds: environment.threadIds,
        visits,
        routedThreadId,
      };
      const previous = threadContentPublications.get(machine.environmentId);
      if (previous && sameThreadContentInputs(previous.inputs, inputs)) continue;
      const captured = threadContentCapture.capture(
        machine.environmentId,
        environment,
        selectThreadsForContentCache({
          threadIds: environment.threadIds,
          hasMessages: (threadId) => (environment.messageIdsByThreadId[threadId]?.length ?? 0) > 0,
          routedThreadId,
          lastVisitedAt: (threadId) =>
            visits[scopedThreadKey({ environmentId: machine.environmentId, threadId })],
        }),
      );
      threadContentPublications.set(machine.environmentId, { inputs, captured });
      if (previous ? sameCapturedThreads(previous.captured, captured) : captured.length === 0) {
        continue;
      }
      const kept = trimContentToBudget({
        // Measured as main measures its record, so both keep the same threads.
        bodyBytes: measureRecordBodyBytes({
          accountId: current.accountId ?? "",
          environmentId: machine.environmentId,
          capturedAt: Date.now(),
        }),
        entries: captured,
        budgetBytes: THREAD_CONTENT_CACHE_RECORD_BUDGET_BYTES,
      });
      const publishChanges = bridge.publishDesktopThreadContentChanges;
      if (!publishChanges) {
        publish(
          machine.environmentId,
          Object.fromEntries(kept.map((thread) => [thread.threadId, thread.content])),
        );
        continue;
      }
      publishThreadContentChanges(machine.environmentId, kept, publishChanges);
    }
  };
  /**
   * Hands main the threads that changed since what it confirmed holding, and
   * the order of all of them. While a publication is on its way the next one
   * waits for it, so each is relative to what main holds.
   */
  const publishThreadContentChanges = (
    environmentId: EnvironmentId,
    kept: ReadonlyArray<CapturedThreadContent>,
    publishChanges: NonNullable<DesktopBridgeThreadContentChanges>,
  ) => {
    if (threadContentInFlight.has(environmentId)) {
      // Captured again once the one on its way is confirmed.
      threadContentPublications.delete(environmentId);
      return;
    }
    const acknowledged = acknowledgedThreadContent.get(environmentId) ?? null;
    const changed = kept.filter((thread) => acknowledged?.get(thread.threadId) !== thread);
    if (acknowledged !== null && changed.length === 0 && sameOrder(acknowledged, kept)) return;
    threadContentInFlight.add(environmentId);
    const settle = (stored: boolean) => {
      threadContentInFlight.delete(environmentId);
      if (disposed) return;
      acknowledgedThreadContent.set(
        environmentId,
        stored ? new Map(kept.map((thread) => [thread.threadId, thread])) : null,
      );
      // Publish what changed while this one was on its way. After a refusal
      // the next change sends every thread; nothing is resent before it, so
      // a main that cannot store (no encryption, an ineligible machine) is
      // not handed the same content again and again.
      if (threadContentPublications.get(environmentId) === undefined) {
        scheduleThreadContentPublication();
      }
    };
    void publishChanges(environmentId, {
      order: kept.map((thread) => thread.threadId),
      changed: Object.fromEntries(changed.map((thread) => [thread.threadId, thread.content])),
    }).then(
      (stored) => settle(stored === true),
      () => settle(false),
    );
  };
  const turnRunning = () => runningThreadKeys.size > 0;
  // A throttle, not a debounce: a conversation that streams for minutes must still reach main.
  const scheduleThreadContentPublication = () => {
    if (!active()) return;
    const delayMs = turnRunning()
      ? THREAD_CONTENT_STREAMING_PUBLISH_INTERVAL_MS
      : THREAD_CONTENT_PUBLISH_THROTTLE_MS;
    const now = Date.now();
    if (threadContentTimer !== null) {
      // A turn ended while its publication waits out the streaming interval.
      if (now + delayMs >= threadContentDueAt) return;
      globalThis.clearTimeout(threadContentTimer);
    }
    threadContentDueAt = now + delayMs;
    threadContentTimer = globalThis.setTimeout(() => {
      threadContentTimer = null;
      publishThreadContent();
    }, delayMs);
  };
  /** A window that is leaving sight hands over what is still waiting. */
  const flushThreadContent = () => {
    if (threadContentTimer === null) return;
    globalThis.clearTimeout(threadContentTimer);
    threadContentTimer = null;
    publishThreadContent();
  };
  const flushThreadContentWhenHidden = () => {
    if (globalThis.document?.visibilityState === "hidden") flushThreadContent();
  };
  /** A turn that ended, or a thread left, hands over its conversation at once. */
  const noteTurnsAndRoute = (state: ReturnType<typeof useStore.getState>) => {
    const running = new Set(listRunningThreadKeys(state, RUNNING_THREADS_WATCHED));
    const turnEnded = [...runningThreadKeys].some((key) => !running.has(key));
    runningThreadKeys = running;
    const routed = readRoutedThread();
    const nextRoutedKey = routed === null ? null : `${routed.environmentId}\0${routed.threadId}`;
    const switched = nextRoutedKey !== routedThreadKey;
    routedThreadKey = nextRoutedKey;
    return turnEnded || switched;
  };
  const noteStoreChange = (state: ReturnType<typeof useStore.getState>) => {
    if (noteTurnsAndRoute(state) && threadContentTimer !== null) flushThreadContent();
    else scheduleThreadContentPublication();
  };
  const onRouteChange = () => {
    if (noteTurnsAndRoute(useStore.getState()) && threadContentTimer !== null) flushThreadContent();
  };
  const cancel = () => {
    if (threadContentTimer !== null) globalThis.clearTimeout(threadContentTimer);
    threadContentTimer = null;
  };
  noteTurnsAndRoute(useStore.getState());
  globalThis.window?.addEventListener?.("pagehide", flushThreadContent);
  globalThis.window?.addEventListener?.("hashchange", onRouteChange);
  globalThis.document?.addEventListener?.("visibilitychange", flushThreadContentWhenHidden);
  return {
    schedule: scheduleThreadContentPublication,
    noteStoreChange,
    forget: (environmentId) => {
      threadContentPublications.delete(environmentId);
      acknowledgedThreadContent.delete(environmentId);
      threadContentCapture.forget(environmentId);
    },
    reset: () => {
      cancel();
      threadContentPublications.clear();
      acknowledgedThreadContent.clear();
      threadContentCapture.clear();
    },
    dispose: () => {
      disposed = true;
      cancel();
      globalThis.window?.removeEventListener?.("pagehide", flushThreadContent);
      globalThis.window?.removeEventListener?.("hashchange", onRouteChange);
      globalThis.document?.removeEventListener?.("visibilitychange", flushThreadContentWhenHidden);
    },
  };
}
