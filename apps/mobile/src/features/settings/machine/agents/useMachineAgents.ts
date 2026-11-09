import { useEffect, useMemo, useSyncExternalStore } from "react";

import {
  createMachineAgentsController,
  type MachineAgentsApi,
  type MachineAgentsController,
  type MachineAgentsState,
} from "./machineAgentsController";

/**
 * One machine's Agents state, read once its api is there and again whenever its connection
 * changes (a new api is a new controller; the old one stops publishing).
 */
export function useMachineAgents(api: MachineAgentsApi | undefined): {
  readonly state: MachineAgentsState;
  readonly controller: MachineAgentsController;
} {
  const controller = useMemo(() => createMachineAgentsController(api), [api]);
  useEffect(() => {
    void controller.load();
    return controller.dispose;
  }, [controller]);
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot,
    controller.getSnapshot,
  );
  return { state, controller };
}
