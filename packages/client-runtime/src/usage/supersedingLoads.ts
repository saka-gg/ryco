import { UsageRequestGeneration } from "./merge.ts";

/**
 * The per-target requests of one view (one per node, say), where each answer
 * is delivered as soon as it settles, so a slow or hung target never hides the
 * others, and a later run supersedes the earlier one.
 *
 * A run starts its loads first and only then releases the previous run's
 * signal. Loads that both runs want were joined before that (shared
 * requests keep a flight while any signal still waits on it), so only
 * superseded requests (another range, a deselected node) are left without a
 * waiter and withdrawn, which frees the node's scan queue. Answers of a
 * superseded run are dropped. Nothing is released when the view goes away, so
 * a closed view still fills its caches.
 */
export class SupersedingLoads {
  readonly #generations = new UsageRequestGeneration();
  #waiting: AbortController | null = null;

  /**
   * Start one load per target. `load` must settle with a result for every
   * outcome (failures included) rather than reject.
   */
  run<Target, Result>(
    targets: Iterable<Target>,
    load: (target: Target, signal: AbortSignal) => Promise<Result>,
    onAnswer: (target: Target, result: Result) => void,
  ): void {
    const generation = this.#generations.next();
    const controller = new AbortController();
    for (const target of targets) {
      void load(target, controller.signal).then((result) => {
        if (this.#generations.isCurrent(generation)) onAnswer(target, result);
      });
    }
    this.#waiting?.abort();
    this.#waiting = controller;
  }
}
