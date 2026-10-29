import {
  getThreadPriorityRefreshCoordinator,
  type ThreadPriorityManualRefreshResult,
  type ThreadPriorityRefreshConfig,
  type ThreadPriorityRefreshEnvironment,
} from "@ryco/client-runtime/state/threads";

import { readEnvironmentConnection } from "./environments/runtime";

const runtimeIdentity = {};
let environmentSnapshot: ReadonlyArray<ThreadPriorityRefreshEnvironment> = [];

const coordinator = getThreadPriorityRefreshCoordinator(runtimeIdentity, {
  nowMs: Date.now,
  timer: {
    set: (callback, delayMs) => setTimeout(callback, delayMs),
    clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
  },
  listEnvironments: () => environmentSnapshot,
  ensureCurrent: async (environmentId, input) => {
    const connection = readEnvironmentConnection(environmentId);
    if (!connection) throw new Error("The environment is no longer connected.");
    return await connection.client.threadPriority.ensureCurrent(input);
  },
  // Automatic failures are intentionally quiet. A later periodic or manual
  // check can recover without turning background ranking into notification noise.
});

export function setWebThreadPriorityRefreshEnvironments(
  environments: ReadonlyArray<ThreadPriorityRefreshEnvironment>,
): void {
  environmentSnapshot = environments;
}

export async function configureWebThreadPriorityRefresh(
  config: ThreadPriorityRefreshConfig,
): Promise<void> {
  await coordinator.configure(config);
}

export async function notifyWebThreadPriorityEnvironmentsChanged(): Promise<void> {
  await coordinator.environmentsChanged();
}

export function notifyWebThreadPriorityInputChanged(): void {
  coordinator.relevantInputChanged();
}

export async function setWebThreadPriorityForeground(foreground: boolean): Promise<void> {
  await coordinator.setForeground(foreground);
}

export async function refreshWebThreadPrioritiesNow(): Promise<ThreadPriorityManualRefreshResult> {
  return await coordinator.refreshNow();
}
