/**
 * Bound launch prewarms to idle time: Hermes evaluates a required module
 * synchronously, so it must not land on top of the first frames.
 */
export function runWhenIdle(task: () => void): void {
  if (typeof globalThis.requestIdleCallback === "function") {
    globalThis.requestIdleCallback(() => task(), { timeout: 2_000 });
    return;
  }
  globalThis.setTimeout(task, 1_000);
}

/** Modules evaluated per idle slice, so one slice stays well under a frame budget. */
export const PREWARM_MODULES_PER_SLICE = 4;

/**
 * Evaluate `modules` a few per idle slice, then run `done`. A module that fails
 * to evaluate is left to fail again where a screen needs it; the warm-up itself
 * never throws out of an idle callback.
 */
export function prewarmInIdleSlices(
  modules: ReadonlyArray<() => unknown>,
  done: () => void,
  start = 0,
): void {
  runWhenIdle(() => {
    const end = Math.min(start + PREWARM_MODULES_PER_SLICE, modules.length);
    for (let index = start; index < end; index += 1) {
      try {
        modules[index]!();
      } catch {
        // Surfaces where the screen evaluates the module, as without a warm-up.
      }
    }
    if (end < modules.length) prewarmInIdleSlices(modules, done, end);
    else done();
  });
}
