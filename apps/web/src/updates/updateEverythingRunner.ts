import {
  buildUpdateEverythingPlan,
  describeUpdateEverythingResult,
  runUpdateEverything,
  type UpdateEverythingEnvironmentInput,
  type UpdateEverythingIo,
  type UpdateEverythingLocalApp,
  type UpdateEverythingPlan,
  type UpdateEverythingResult,
  type UpdateEverythingResultDescription,
  type UpdateEverythingRunState,
} from "@ryco/client-runtime/updates";
import type { EnvironmentId } from "@ryco/contracts";

import { selectUpdateEverythingEnvironments } from "./updateEverythingInputs";

export interface UpdateEverythingRunSnapshot {
  /** The active run, or the finished one until it is dismissed. */
  readonly run: UpdateEverythingRunState | null;
  /** The finished run's result, until it is dismissed. */
  readonly result: UpdateEverythingResult | null;
  readonly running: boolean;
  readonly checking: boolean;
}

export interface UpdateEverythingRunnerDeps {
  /** What a run would act on now, read fresh at the click. */
  readonly readInputs: () => {
    readonly environments: ReadonlyArray<UpdateEverythingEnvironmentInput>;
    readonly localApp: UpdateEverythingLocalApp;
  };
  readonly io: UpdateEverythingIo;
  /** Shows the finished run's one notice. */
  readonly showResult: (description: UpdateEverythingResultDescription) => void;
  /** Asks every node and this app's updater to check now; per-node failures are its own. */
  readonly checkAll: () => Promise<void>;
}

export interface UpdateEverythingStartOptions {
  readonly environmentIds?: ReadonlyArray<EnvironmentId>;
}

export interface UpdateEverythingRunner {
  readonly getSnapshot: () => UpdateEverythingRunSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
  /** Runs the current plan (only `environmentIds` when given); a no-op while a run is active or nothing would run. */
  readonly start: (options?: UpdateEverythingStartOptions) => void;
  /** Single-flight: a call while a check runs joins it. */
  readonly checkAll: () => Promise<void>;
  /** Forgets the finished run; a no-op while one runs. */
  readonly dismissRun: () => void;
}

const IDLE: UpdateEverythingRunSnapshot = Object.freeze({
  run: null,
  result: null,
  running: false,
  checking: false,
});

const STOPPED_TITLE = "Update everything stopped";

/**
 * The app's one "Update everything" run, outside React so it outlives the
 * surfaces that show it: one run at a time, its progress and result kept until
 * dismissed, and one notice when it finishes.
 */
export function createUpdateEverythingRunner(
  deps: UpdateEverythingRunnerDeps,
): UpdateEverythingRunner {
  let snapshot = IDLE;
  const listeners = new Set<() => void>();
  let checking: Promise<void> | null = null;

  const set = (patch: Partial<UpdateEverythingRunSnapshot>) => {
    snapshot = Object.freeze({ ...snapshot, ...patch });
    for (const listener of Array.from(listeners)) {
      try {
        listener();
      } catch {
        // One failing listener must not stop the others or the run.
      }
    }
  };

  const show = (description: UpdateEverythingResultDescription | null) => {
    if (description === null) return;
    try {
      deps.showResult(description);
    } catch {
      // The run is over either way.
    }
  };

  const planFor = (options?: UpdateEverythingStartOptions): UpdateEverythingPlan | null => {
    try {
      const inputs = deps.readInputs();
      return buildUpdateEverythingPlan({
        environments: selectUpdateEverythingEnvironments(
          inputs.environments,
          options?.environmentIds,
        ),
        localApp: inputs.localApp,
      });
    } catch (error) {
      show({
        type: "error",
        title: STOPPED_TITLE,
        description: error instanceof Error ? error.message : "Couldn't read what to update.",
      });
      return null;
    }
  };

  const start = (options?: UpdateEverythingStartOptions) => {
    if (snapshot.running) return;
    const plan = planFor(options);
    if (plan === null) return;
    if (!plan.hasWork) return;
    set({ running: true, run: null, result: null });
    let settled = false;
    void runUpdateEverything(plan, deps.io, {
      onProgress: (run) => {
        if (!settled) set({ run });
      },
    }).then(
      (result) => {
        settled = true;
        set({ running: false, result });
        show(describeUpdateEverythingResult(result));
      },
      (error: unknown) => {
        settled = true;
        set({ running: false });
        show({
          type: "error",
          title: STOPPED_TITLE,
          description: error instanceof Error ? error.message : "An unexpected error occurred.",
        });
      },
    );
  };

  const checkAll = () => {
    if (checking !== null) return checking;
    set({ checking: true });
    // Deferred a tick, so the pending check is recorded before any of it runs.
    const current: Promise<void> = Promise.resolve()
      .then(() => deps.checkAll())
      .catch(() => {
        // Each check reports through the state it refreshes.
      })
      .finally(() => {
        if (checking === current) checking = null;
        set({ checking: false });
      });
    checking = current;
    return current;
  };

  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    start,
    checkAll,
    dismissRun: () => {
      if (snapshot.running || (snapshot.run === null && snapshot.result === null)) return;
      set({ run: null, result: null });
    },
  };
}
