import { appAtomRegistry, wsConnectionStatusForEnvironmentAtom } from "@ryco/client-runtime/rpc";
import type { EnvironmentId } from "@ryco/contracts";
import {
  createComparisonController,
  comparisonStorageKey,
} from "@ryco/client-runtime/state/comparison";
import { useEffect, useMemo, useSyncExternalStore } from "react";
import { ensureEnvironmentApi } from "../environmentApi";
import {
  readEnvironmentConnection,
  subscribeEnvironmentConnections,
} from "../environments/runtime";
import { webKV } from "../platform/kv";
import { webAppLifecycle } from "../platform/appLifecycle";
import { gitScopeKey, subscribeInvalidationScope } from "./gitAtoms";

export function useComparison(input: {
  environmentId: EnvironmentId | null;
  repositoryPath: string | null;
  cwd: string | null;
  ignoreWhitespace: boolean;
  enabled: boolean;
}) {
  const { environmentId, repositoryPath, cwd, ignoreWhitespace, enabled } = input;
  const controller = useMemo(
    () =>
      createComparisonController({
        storage: webKV,
        storageKey: comparisonStorageKey(environmentId ?? "", repositoryPath ?? ""),
        read: (selection) => {
          if (!environmentId || !cwd) return Promise.reject(new Error("Repository unavailable."));
          return ensureEnvironmentApi(environmentId).vcs.readComparison({
            cwd,
            selection,
            ignoreWhitespace,
          });
        },
      }),
    [environmentId, repositoryPath, cwd, ignoreWhitespace],
  );
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot);
  useEffect(() => {
    if (!enabled || !environmentId || !cwd || !repositoryPath) return;
    void controller.hydrate();
    const refresh = () => {
      if (webAppLifecycle.isForeground() && webAppLifecycle.isOnline()) void controller.refresh();
    };
    const unsubscribeGit = subscribeInvalidationScope(gitScopeKey(cwd), () => {
      controller.invalidate(false);
      refresh();
    });
    const unsubscribeLifecycle = webAppLifecycle.subscribe((event) => {
      if (event === "offline" || event === "background") controller.invalidate();
      else refresh();
    });
    let client = readEnvironmentConnection(environmentId)?.client;
    const unsubscribeConnection = subscribeEnvironmentConnections(() => {
      const next = readEnvironmentConnection(environmentId)?.client;
      if (client === next) return;
      client = next;
      controller.invalidate();
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
      controller.invalidate();
      if (next.phase === "connected") refresh();
    });
    return () => {
      controller.invalidate();
      unsubscribeGit();
      unsubscribeLifecycle();
      unsubscribeConnection();
      unsubscribeStatus();
    };
  }, [controller, enabled, environmentId, cwd, repositoryPath]);
  return { ...state, setSelection: controller.setSelection, refresh: controller.refresh };
}
