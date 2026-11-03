import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import * as Clipboard from "expo-clipboard";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import { mobileHostedConnectionScopes } from "../../connection/hostedConnectionScopes";
import { useEnvironmentApi } from "../../connection/useEnvironmentApi";
import { uuidv4 } from "../../lib/uuid";
import { mobileAppLifecycle, mobileFrameScheduler } from "../../platform";
import { useTerminalStateStore } from "../../state/terminalStateStore";
import { useHomeEnvironments } from "../home/useHomeEnvironments";
import { terminalEnvironmentAccess } from "./terminalAccess";
import { TerminalController, type TerminalControllerPorts } from "./terminalController";
import { createMobileTerminalId } from "./terminalSessionModel";

const PORTS: TerminalControllerPorts = {
  store: useTerminalStateStore,
  clipboard: {
    getString: () => Clipboard.getStringAsync(),
    setString: (text) => Clipboard.setStringAsync(text),
  },
  lifecycle: {
    isForeground: () => mobileAppLifecycle.isForeground(),
    subscribe: (listener) =>
      mobileAppLifecycle.subscribe((event) => {
        if (event === "background") listener(false);
        else if (event === "foreground") listener(true);
      }),
  },
  createTerminalId: () => createMobileTerminalId(uuidv4()),
  scheduleFrame: (callback) => mobileFrameScheduler.scheduleFrame(callback),
  setTimer: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/**
 * One thread's terminal controller for the mounted screen. While mounted it
 * counts as thread work in the hosted warm set (the same retention a mounted
 * thread view has); unmounting stops observing and drops in-flight work, and
 * never closes a session on the node.
 */
export function useTerminalController(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | null;
  readonly worktreePath: string | null;
  readonly fontSize: number;
}) {
  const { environmentId, threadId, cwd, worktreePath, fontSize } = input;
  const controller = useMemo(
    () => new TerminalController(environmentId, threadId, PORTS),
    [environmentId, threadId],
  );
  const api = useEnvironmentApi(environmentId);
  const environments = useHomeEnvironments();
  const environment = environments.find((row) => row.environmentId === environmentId);
  const access = terminalEnvironmentAccess(environment);

  // Inputs first: the attach below opens the active session with them.
  useEffect(() => {
    controller.update({
      cwd,
      worktreePath,
      api,
      connectionState: access.connectionState,
      mutationReady: access.mutationReady,
      fontSize,
    });
  }, [access.connectionState, access.mutationReady, api, controller, cwd, fontSize, worktreePath]);

  useEffect(() => controller.attach(), [controller]);

  useEffect(
    () => mobileHostedConnectionScopes.retain(environmentId, { type: "terminal", threadId }),
    [environmentId, threadId],
  );

  const view = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  return { controller, view };
}
