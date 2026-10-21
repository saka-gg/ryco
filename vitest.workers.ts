// At the repo root, not in a workspace, so that `--affected` runs every suite
// it configures (see turbo.json globalDependencies). Tested by
// scripts/vitest.workers.test.ts, since a root file has no test task.

import { availableParallelism } from "node:os";

export interface VitestWorkerDefaults {
  /** Workers on CI, where a test leg runs one package's suite on its own runner. */
  readonly ci: number;
  /** Upper bound for local runs, which get at most half the machine's cores. */
  readonly localMax: number;
}

/**
 * Resolves `maxWorkers` for a package's Vitest run.
 *
 * RYCO_TEST_MAX_WORKERS overrides the result everywhere, CI included, so a run
 * can be repeated with CI's count or squeezed onto a busy machine. Locally,
 * Turbo runs up to ten packages' suites at once and parallel agent worktrees
 * share the same cores, so a package takes at most half of them. CI uses its
 * count unless the runner has fewer cores, because more workers than cores
 * would only stretch the tests that measure elapsed time.
 *
 * Vitest's own VITEST_MAX_WORKERS is not used: it overrides every project,
 * including the ones a package keeps serial on purpose.
 */
export function vitestMaxWorkers(
  defaults: VitestWorkerDefaults,
  env: NodeJS.ProcessEnv = process.env,
  cores: number = availableParallelism(),
): number {
  const explicit = env.RYCO_TEST_MAX_WORKERS?.trim();
  if (explicit) {
    const workers = Number(explicit);
    if (!Number.isSafeInteger(workers) || workers < 1) {
      throw new Error(`RYCO_TEST_MAX_WORKERS must be a positive integer, got "${explicit}".`);
    }
    return workers;
  }
  if (env.CI) return Math.max(1, Math.min(defaults.ci, cores));
  return Math.max(1, Math.min(defaults.localMax, Math.floor(cores / 2)));
}
