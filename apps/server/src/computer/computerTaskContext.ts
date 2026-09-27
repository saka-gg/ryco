// Adapted from Synara v0.9.1; see docs/licenses/synara-computer-use.txt.
import { AsyncLocalStorage } from "node:async_hooks";
import type { CuaComputerTask } from "@ryco/shared/cuaDriverProtocol";

const tasks = new AsyncLocalStorage<{ task: CuaComputerTask; active: boolean }>();

export function currentComputerTask(): CuaComputerTask | undefined {
  const scope = tasks.getStore();
  return scope?.active ? scope.task : undefined;
}

/** Task attribution is local IPC metadata, never additional model context. */
export async function withComputerTask<A>(
  task: CuaComputerTask,
  run: () => Promise<A>,
): Promise<A> {
  const scope = { task, active: true };
  try {
    return await tasks.run(scope, run);
  } finally {
    scope.active = false;
  }
}
