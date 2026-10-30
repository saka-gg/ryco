import { appAtomRegistry, wsConnectionOpenedCountAtom } from "@ryco/client-runtime/rpc";

import { mobileKV } from "../../platform/kv";
import { useStore } from "../../state/threadsRuntime";
import { readThreadOutboxEnvironment } from "../../state/use-thread-outbox-drain";
import { createNewTaskLaunchDeps } from "./newTaskLaunchRuntime";
import { createNewTaskOutboxPersistence, drainNewTaskOutbox } from "./newTaskOutbox";

const DRAIN_DEBOUNCE_MS = 50;

/**
 * Load the New Task outbox, then start queued tasks whenever a machine's
 * socket opens or the threads store changes (its live shell snapshot lands
 * after the socket opens, and only then is the machine ready). Returns the
 * stop. Loaded after launch by `useNewTaskOutboxDrain`.
 */
export function startNewTaskOutboxDrain(): () => void {
  const persistence = createNewTaskOutboxPersistence(mobileKV);
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;
  const drain = () => {
    if (disposed) return;
    drainNewTaskOutbox({
      isEnvironmentReady: (environmentId) =>
        readThreadOutboxEnvironment(environmentId).mutationReady,
      depsFor: createNewTaskLaunchDeps,
    });
  };
  const schedule = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      drain();
    }, DRAIN_DEBOUNCE_MS);
  };
  void persistence.hydrate().then(drain);
  const unsubscribers = [
    useStore.subscribe(schedule),
    appAtomRegistry.subscribe(wsConnectionOpenedCountAtom, schedule),
  ];
  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    for (const unsubscribe of unsubscribers) unsubscribe();
    persistence.dispose();
  };
}
