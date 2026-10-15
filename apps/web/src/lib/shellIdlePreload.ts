import { onStartupPhase } from "../perf/startupInstrumentation";
import { scheduleIdleTask } from "./idleTask";

interface NetworkInformationLike {
  readonly saveData?: boolean;
  readonly effectiveType?: string;
}

/**
 * Whether speculative chunk downloads (not requested by the user) are worth
 * their bandwidth. Data saver and anything slower than 4G opt out: there the
 * download would compete with boot-critical requests on the same link, so the
 * chunk loads on intent or on the navigation instead.
 */
export function allowsSpeculativePreload(
  connection: NetworkInformationLike | undefined = (
    globalThis.navigator as { readonly connection?: NetworkInformationLike } | undefined
  )?.connection,
): boolean {
  if (!connection) return true;
  if (connection.saveData === true) return false;
  return connection.effectiveType === undefined || connection.effectiveType === "4g";
}

/**
 * The default start cap, for sessions that may never paint a primary shell
 * (hosted-static, a hosted directory): the preloads start after this.
 */
export const SHELL_IDLE_PRELOAD_START_CAP_MS = 5_000;
/**
 * The safety cap for sessions that do paint a primary shell: long enough that
 * a slow link's shell snapshot and first thread lands first, so the cap only
 * covers a shell that never paints at all.
 */
export const SHELL_IDLE_PRELOAD_PRIMARY_START_CAP_MS = 30_000;
const SHELL_IDLE_PRELOAD_TASK_TIMEOUT_MS = 2_000;
/**
 * How long one task's download may hold the next one back. A stalled request
 * must not stop the rest; it keeps loading in the background either way.
 */
export const SHELL_IDLE_PRELOAD_TASK_SETTLE_CAP_MS = 8_000;

/**
 * A speculative preload. Returning the load's promise makes the next task
 * wait for that download, so the preloads share the link one at a time; any
 * other result moves straight on.
 */
export type ShellIdlePreloadTask = () => unknown;

export interface ShellIdlePreloadOptions {
  readonly allowed?: boolean;
  /** Starts the preloads after this even when the shell has not painted. */
  readonly startCapMs?: number;
  /** How long each task may wait for an idle period once the preloads started. */
  readonly idleTimeoutMs?: number;
  /**
   * Asked once the shell has painted: when true (the document opened on a
   * thread), the preloads also wait for that thread's first paint, so they
   * never compete with the thread's own chunk and detail stream.
   */
  readonly awaitsFirstThreadPaint?: () => boolean;
  /**
   * Notifies route changes. While the preloads wait for a thread's first
   * paint, each change asks `awaitsFirstThreadPaint` again, so a thread that
   * never renders (it redirected away) does not hold them until the cap.
   */
  readonly subscribeToNavigation?: (listener: () => void) => () => void;
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { readonly then?: unknown }).then === "function"
  );
}

/**
 * Runs speculative chunk preloads strictly after boot: nothing starts before
 * the primary shell has painted — and, for a document that opened on a
 * thread, that thread's first paint — or before the cap elapsed. Then each
 * task runs in its own idle period, in order, and a task that returns its
 * download's promise holds the next one until that download settles (or
 * {@link SHELL_IDLE_PRELOAD_TASK_SETTLE_CAP_MS} passes). The most likely next
 * navigation goes first, and the downloads never overlap one another, the
 * shell snapshot or the first thread render. Returns a cancel function.
 */
export function scheduleShellIdlePreloads(
  tasks: ReadonlyArray<ShellIdlePreloadTask>,
  options: ShellIdlePreloadOptions = {},
): () => void {
  if (tasks.length === 0 || !(options.allowed ?? allowsSpeculativePreload())) {
    return () => undefined;
  }
  let cancelled = false;
  let started = false;
  let cancelPhaseWait: () => void = () => undefined;
  let cancelIdleTask: () => void = () => undefined;
  let capTimer: ReturnType<typeof globalThis.setTimeout> | null = null;
  let settleTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const runFrom = (index: number) => {
    if (cancelled || index >= tasks.length) return;
    cancelIdleTask = scheduleIdleTask(() => {
      let result: unknown;
      try {
        result = tasks[index]?.();
      } catch {
        // Preloading is advisory; a failing task must not stop the rest.
      }
      if (!isPromiseLike(result)) {
        runFrom(index + 1);
        return;
      }
      let advanced = false;
      const next = () => {
        if (advanced) return;
        advanced = true;
        if (settleTimer !== null) globalThis.clearTimeout(settleTimer);
        settleTimer = null;
        runFrom(index + 1);
      };
      settleTimer = globalThis.setTimeout(next, SHELL_IDLE_PRELOAD_TASK_SETTLE_CAP_MS);
      Promise.resolve(result).then(next, next);
    }, options.idleTimeoutMs ?? SHELL_IDLE_PRELOAD_TASK_TIMEOUT_MS);
  };
  let cancelThreadPaintWait: () => void = () => undefined;
  const start = () => {
    if (started || cancelled) return;
    started = true;
    cancelPhaseWait();
    cancelThreadPaintWait();
    if (capTimer !== null) globalThis.clearTimeout(capTimer);
    runFrom(0);
  };

  capTimer = globalThis.setTimeout(start, options.startCapMs ?? SHELL_IDLE_PRELOAD_START_CAP_MS);
  const waitForThreadPaint = () => {
    const stopPhaseWait = onStartupPhase("first-thread-painted", start);
    const stopNavigationWait =
      options.subscribeToNavigation?.(() => {
        if (options.awaitsFirstThreadPaint?.() !== true) start();
      }) ?? (() => undefined);
    cancelThreadPaintWait = () => {
      stopPhaseWait();
      stopNavigationWait();
    };
  };
  cancelPhaseWait = onStartupPhase("primary-shell-painted", () => {
    if (started || cancelled) return;
    if (options.awaitsFirstThreadPaint?.() !== true) {
      start();
      return;
    }
    waitForThreadPaint();
    // The thread painted before the shell did: the phase listener ran already.
    if (started) cancelThreadPaintWait();
  });

  return () => {
    cancelled = true;
    cancelPhaseWait();
    cancelThreadPaintWait();
    if (capTimer !== null) globalThis.clearTimeout(capTimer);
    if (settleTimer !== null) globalThis.clearTimeout(settleTimer);
    cancelIdleTask();
  };
}

/**
 * Runs one speculative preload under the shell's policy for those (see
 * {@link scheduleShellIdlePreloads}): skipped where speculative downloads are
 * not allowed, and started in an idle period only once the primary shell has
 * painted (and the routed thread, when `awaitsFirstThreadPaint` asks for it)
 * or the start cap elapsed. Once the shell has painted in this document, only
 * the idle period remains. Returns a cancel function.
 */
export function scheduleAfterShellPaint(
  task: ShellIdlePreloadTask,
  options?: ShellIdlePreloadOptions,
): () => void {
  return scheduleShellIdlePreloads([task], options);
}
