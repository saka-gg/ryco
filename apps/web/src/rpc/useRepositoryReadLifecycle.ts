import { appAtomRegistry, wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";
import { useEffect } from "react";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { webAppLifecycle } from "../platform/appLifecycle";
import { gitScopeKey, subscribeInvalidationScope } from "./gitAtoms";

export function useRepositoryReadLifecycle(
  controller: { invalidate: (clearData?: boolean) => void; refresh: () => Promise<void> },
  environmentId: EnvironmentId | null,
  cwd: string | null,
  enabled: boolean,
  start: () => Promise<void>,
) {
  useEffect(() => {
    if (!enabled || !environmentId || !cwd) return;
    void start();
    const refresh = () => {
      if (webAppLifecycle.isForeground() && webAppLifecycle.isOnline()) void controller.refresh();
    };
    const unsubscribeGit = subscribeInvalidationScope(gitScopeKey(cwd), () => {
      controller.invalidate(false);
      refresh();
    });
    // Background, offline and a new connection keep the review on screen and
    // only drop a read in flight: the next read sends its revision, and a node
    // with nothing new answers `unchanged` without the patches (up to 2 MB each).
    const unsubscribeLifecycle = webAppLifecycle.subscribe((event) => {
      if (event === "offline" || event === "background") controller.invalidate(false);
      else refresh();
    });
    let client = readEnvironmentConnection(environmentId)?.client;
    const unsubscribeConnection = subscribeEnvironmentConnections(() => {
      const next = readEnvironmentConnection(environmentId)?.client;
      if (client === next) return;
      client = next;
      controller.invalidate(false);
      if (next) refresh();
    });
    const statusAtom = wsConnectionStatusForEnvironmentAtom(environmentId);
    let connectionStatus = appAtomRegistry.get(statusAtom);
    const unsubscribeStatus = appAtomRegistry.subscribe(statusAtom, (next) => {
      if (
        next.phase === connectionStatus.phase &&
        next.connectedAt === connectionStatus.connectedAt
      )
        return;
      connectionStatus = next;
      controller.invalidate(false);
      if (next.phase === "connected") refresh();
    });
    return () => {
      controller.invalidate();
      unsubscribeGit();
      unsubscribeLifecycle();
      unsubscribeConnection();
      unsubscribeStatus();
    };
  }, [controller, enabled, environmentId, cwd, start]);
}
