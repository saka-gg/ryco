import type { EnvironmentId, ThreadPriorityEnsureCurrentResult } from "@ryco/contracts";
import type { AiFocusRefreshIntervalMs } from "@ryco/contracts/settings";

export const THREAD_PRIORITY_DEFAULT_REFRESH_INTERVAL_MS = 600_000;
export const THREAD_PRIORITY_CHANGE_QUIET_MS = 1_000;

export interface ThreadPriorityRefreshEnvironment {
  readonly environmentId: EnvironmentId;
  readonly generation: number;
  readonly connected: boolean;
  readonly supported: boolean;
  readonly lastSuccessfulCheckAtMs?: number | undefined;
}

export interface ThreadPriorityRefreshTimer {
  readonly set: (callback: () => void, delayMs: number) => unknown;
  readonly clear: (handle: unknown) => void;
}

export interface ThreadPriorityRefreshDependencies {
  readonly nowMs: () => number;
  readonly timer: ThreadPriorityRefreshTimer;
  readonly listEnvironments: () => ReadonlyArray<ThreadPriorityRefreshEnvironment>;
  readonly ensureCurrent: (
    environmentId: EnvironmentId,
    input: { readonly force: boolean },
  ) => Promise<ThreadPriorityEnsureCurrentResult>;
  readonly onAutomaticFailure?: (environmentId: EnvironmentId, error: unknown) => void | undefined;
  readonly initialForeground?: boolean | undefined;
}

export interface ThreadPriorityRefreshConfig {
  readonly enabled: boolean;
  readonly intervalMs: AiFocusRefreshIntervalMs;
}

export interface ThreadPriorityManualRefreshResult {
  readonly attempted: ReadonlyArray<EnvironmentId>;
  readonly succeeded: ReadonlyArray<EnvironmentId>;
  readonly failures: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly error: unknown;
  }>;
}

interface GenerationTimestamp {
  readonly generation: number;
  readonly atMs: number;
}

export interface ThreadPriorityRefreshCoordinator {
  readonly configure: (config: ThreadPriorityRefreshConfig) => Promise<void>;
  readonly setForeground: (foreground: boolean) => Promise<void>;
  readonly environmentsChanged: () => Promise<void>;
  readonly relevantInputChanged: () => void;
  readonly refreshNow: () => Promise<ThreadPriorityManualRefreshResult>;
  readonly getLastSuccessfulCheckAtMs: (environmentId: EnvironmentId) => number | null;
  readonly dispose: () => void;
}

function isEligible(environment: ThreadPriorityRefreshEnvironment): boolean {
  return environment.connected && environment.supported;
}

/**
 * Whether two environment lists carry the same fields the coordinator decides
 * on, in the same order. A caller that rebuilds the list on every socket status
 * write uses it to call `environmentsChanged` only when something it reads
 * changed, not on each retry-timer, error or online-flag update.
 */
export function sameThreadPriorityRefreshEnvironments(
  left: ReadonlyArray<ThreadPriorityRefreshEnvironment>,
  right: ReadonlyArray<ThreadPriorityRefreshEnvironment>,
): boolean {
  return (
    left.length === right.length &&
    left.every((environment, index) => {
      const other = right[index]!;
      return (
        environment.environmentId === other.environmentId &&
        environment.generation === other.generation &&
        environment.connected === other.connected &&
        environment.supported === other.supported &&
        environment.lastSuccessfulCheckAtMs === other.lastSuccessfulCheckAtMs
      );
    })
  );
}

function makeThreadPriorityRefreshCoordinator(
  dependencies: ThreadPriorityRefreshDependencies,
): ThreadPriorityRefreshCoordinator {
  let config: ThreadPriorityRefreshConfig = {
    enabled: false,
    intervalMs: THREAD_PRIORITY_DEFAULT_REFRESH_INTERVAL_MS,
  };
  let foreground = dependencies.initialForeground ?? true;
  let periodicTimer: unknown = null;
  let changeTimer: unknown = null;
  let disposed = false;
  const lastSuccessful = new Map<EnvironmentId, GenerationTimestamp>();
  const lastAttempt = new Map<EnvironmentId, GenerationTimestamp>();
  const inFlight = new Map<
    EnvironmentId,
    { readonly generation: number; readonly run: Promise<void> }
  >();

  const clearPeriodic = () => {
    if (periodicTimer !== null) dependencies.timer.clear(periodicTimer);
    periodicTimer = null;
  };
  const clearChange = () => {
    if (changeTimer !== null) dependencies.timer.clear(changeTimer);
    changeTimer = null;
  };

  const currentEnvironment = (
    environmentId: EnvironmentId,
  ): ThreadPriorityRefreshEnvironment | undefined =>
    dependencies
      .listEnvironments()
      .find((environment) => environment.environmentId === environmentId);

  const internalTimestamp = (
    values: ReadonlyMap<EnvironmentId, GenerationTimestamp>,
    environment: ThreadPriorityRefreshEnvironment,
  ): number | null => {
    const value = values.get(environment.environmentId);
    return value?.generation === environment.generation ? value.atMs : null;
  };

  const successfulAt = (environment: ThreadPriorityRefreshEnvironment): number | null => {
    const internal = internalTimestamp(lastSuccessful, environment);
    const external = environment.lastSuccessfulCheckAtMs;
    if (internal === null) return external ?? null;
    if (external === undefined) return internal;
    return Math.max(internal, external);
  };

  const stale = (environment: ThreadPriorityRefreshEnvironment, nowMs: number): boolean => {
    if (config.intervalMs === 0) return false;
    const successful = successfulAt(environment);
    return successful === null || nowMs - successful >= config.intervalMs;
  };

  const runEnvironment = (
    environment: ThreadPriorityRefreshEnvironment,
    force: boolean,
    automatic: boolean,
  ): Promise<void> => {
    const existing = inFlight.get(environment.environmentId);
    if (existing?.generation === environment.generation) return existing.run;

    const requestedAt = dependencies.nowMs();
    if (!force) {
      lastAttempt.set(environment.environmentId, {
        generation: environment.generation,
        atMs: requestedAt,
      });
    }
    const run = dependencies
      .ensureCurrent(environment.environmentId, { force })
      .then(() => {
        const current = currentEnvironment(environment.environmentId);
        if (
          disposed ||
          current === undefined ||
          current.generation !== environment.generation ||
          !isEligible(current)
        ) {
          return;
        }
        lastSuccessful.set(environment.environmentId, {
          generation: environment.generation,
          atMs: dependencies.nowMs(),
        });
      })
      .catch((error: unknown) => {
        if (automatic) dependencies.onAutomaticFailure?.(environment.environmentId, error);
        throw error;
      })
      .finally(() => {
        const current = inFlight.get(environment.environmentId);
        if (current?.run === run) inFlight.delete(environment.environmentId);
      });
    inFlight.set(environment.environmentId, { generation: environment.generation, run });
    return run;
  };

  const refreshAutomatic = async (input: {
    readonly onlyStale: boolean;
    readonly initial: boolean;
  }): Promise<void> => {
    if (disposed || !config.enabled || !foreground) return;
    const nowMs = dependencies.nowMs();
    const environments = dependencies.listEnvironments().filter(isEligible);
    await Promise.allSettled(
      environments.flatMap((environment) => {
        if (input.onlyStale && !stale(environment, nowMs)) return [];
        const attempted = internalTimestamp(lastAttempt, environment);
        if (
          !input.initial &&
          config.intervalMs > 0 &&
          attempted !== null &&
          nowMs - attempted < config.intervalMs
        ) {
          return [];
        }
        return [runEnvironment(environment, false, true)];
      }),
    );
  };

  const schedulePeriodic = () => {
    clearPeriodic();
    if (disposed || !config.enabled || !foreground || config.intervalMs === 0) return;
    const nowMs = dependencies.nowMs();
    const environments = dependencies.listEnvironments().filter(isEligible);
    const delays = environments.map((environment) => {
      const successful = successfulAt(environment);
      const attempted = internalTimestamp(lastAttempt, environment);
      const last =
        successful === null
          ? attempted
          : attempted === null
            ? successful
            : Math.max(successful, attempted);
      return last === null ? 0 : Math.max(0, config.intervalMs - (nowMs - last));
    });
    const delay = delays.length === 0 ? config.intervalMs : Math.min(...delays);
    periodicTimer = dependencies.timer.set(() => {
      periodicTimer = null;
      void refreshAutomatic({ onlyStale: true, initial: false }).finally(schedulePeriodic);
    }, delay);
  };

  return {
    configure: async (nextConfig) => {
      if (disposed) return;
      const enabled = !config.enabled && nextConfig.enabled;
      config = nextConfig;
      if (!config.enabled) {
        clearPeriodic();
        clearChange();
        return;
      }
      if (enabled && foreground) {
        await refreshAutomatic({ onlyStale: false, initial: true });
      }
      schedulePeriodic();
    },
    setForeground: async (nextForeground) => {
      if (disposed || foreground === nextForeground) return;
      foreground = nextForeground;
      if (!foreground) {
        clearPeriodic();
        clearChange();
        return;
      }
      if (config.enabled && config.intervalMs > 0) {
        await refreshAutomatic({ onlyStale: true, initial: false });
      }
      schedulePeriodic();
    },
    environmentsChanged: async () => {
      if (disposed || !config.enabled || !foreground) return;
      if (config.intervalMs > 0) {
        await refreshAutomatic({ onlyStale: true, initial: false });
      }
      schedulePeriodic();
    },
    relevantInputChanged: () => {
      if (disposed || !config.enabled || !foreground || config.intervalMs === 0) return;
      clearChange();
      changeTimer = dependencies.timer.set(() => {
        changeTimer = null;
        void refreshAutomatic({ onlyStale: true, initial: false }).finally(schedulePeriodic);
      }, THREAD_PRIORITY_CHANGE_QUIET_MS);
    },
    refreshNow: async () => {
      const environments = dependencies.listEnvironments().filter(isEligible);
      const settled = await Promise.allSettled(
        environments.map((environment) => runEnvironment(environment, true, false)),
      );
      const succeeded: EnvironmentId[] = [];
      const failures: Array<{ environmentId: EnvironmentId; error: unknown }> = [];
      settled.forEach((result, index) => {
        const environmentId = environments[index]!.environmentId;
        if (result.status === "fulfilled") succeeded.push(environmentId);
        else failures.push({ environmentId, error: result.reason });
      });
      schedulePeriodic();
      return {
        attempted: environments.map((environment) => environment.environmentId),
        succeeded,
        failures,
      };
    },
    getLastSuccessfulCheckAtMs: (environmentId) => {
      const environment = currentEnvironment(environmentId);
      if (environment === undefined) return null;
      return successfulAt(environment);
    },
    dispose: () => {
      disposed = true;
      clearPeriodic();
      clearChange();
      inFlight.clear();
    },
  };
}

const coordinatorByRuntime = new WeakMap<object, ThreadPriorityRefreshCoordinator>();

export function getThreadPriorityRefreshCoordinator(
  runtime: object,
  dependencies: ThreadPriorityRefreshDependencies,
): ThreadPriorityRefreshCoordinator {
  const existing = coordinatorByRuntime.get(runtime);
  if (existing !== undefined) return existing;
  const base = makeThreadPriorityRefreshCoordinator(dependencies);
  const coordinator: ThreadPriorityRefreshCoordinator = {
    ...base,
    dispose: () => {
      base.dispose();
      if (coordinatorByRuntime.get(runtime) === coordinator) coordinatorByRuntime.delete(runtime);
    },
  };
  coordinatorByRuntime.set(runtime, coordinator);
  return coordinator;
}
