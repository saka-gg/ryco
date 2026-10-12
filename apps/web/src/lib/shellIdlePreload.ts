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

/** Sessions without a primary shell (hosted-static) start the preloads after this. */
export const SHELL_IDLE_PRELOAD_START_CAP_MS = 5_000;
const SHELL_IDLE_PRELOAD_TASK_TIMEOUT_MS = 2_000;

/**
 * Runs speculative chunk preloads strictly after boot: nothing starts before
 * the primary shell has painted (or the cap elapsed), then each task runs in
 * its own idle period, in order, so the most likely next navigation goes
 * first and none of them competes with the shell snapshot or the first
 * thread render. Returns a cancel function.
 */
export function scheduleShellIdlePreloads(
  tasks: ReadonlyArray<() => void>,
  options: { readonly allowed?: boolean } = {},
): () => void {
  if (tasks.length === 0 || !(options.allowed ?? allowsSpeculativePreload())) {
    return () => undefined;
  }
  let cancelled = false;
  let started = false;
  let cancelPhaseWait: () => void = () => undefined;
  let cancelIdleTask: () => void = () => undefined;
  let capTimer: ReturnType<typeof globalThis.setTimeout> | null = null;

  const runFrom = (index: number) => {
    if (cancelled || index >= tasks.length) return;
    cancelIdleTask = scheduleIdleTask(() => {
      try {
        tasks[index]?.();
      } catch {
        // Preloading is advisory; a failing task must not stop the rest.
      }
      runFrom(index + 1);
    }, SHELL_IDLE_PRELOAD_TASK_TIMEOUT_MS);
  };
  const start = () => {
    if (started || cancelled) return;
    started = true;
    cancelPhaseWait();
    if (capTimer !== null) globalThis.clearTimeout(capTimer);
    runFrom(0);
  };

  capTimer = globalThis.setTimeout(start, SHELL_IDLE_PRELOAD_START_CAP_MS);
  cancelPhaseWait = onStartupPhase("primary-shell-painted", start);

  return () => {
    cancelled = true;
    cancelPhaseWait();
    if (capTimer !== null) globalThis.clearTimeout(capTimer);
    cancelIdleTask();
  };
}
