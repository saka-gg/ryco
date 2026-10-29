import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import type { ServerConfig } from "@ryco/contracts";
import { useEffect, useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";

import {
  listEnvironmentConnections,
  subscribeEnvironmentConnections,
  useSavedEnvironmentRuntimeStore,
} from "../environments/runtime";
import { getPrimaryKnownEnvironment } from "../environments/primary";
import { useSettings } from "../hooks/useSettings";
import { webAppLifecycle } from "../platform/appLifecycle";
import { useServerConfigSelector } from "../rpc/serverState";
import { useWsConnectionOpenedCount } from "../rpc/wsConnectionState";
import { selectSidebarThreadsAcrossEnvironments, useStore } from "../store";
import {
  configureWebThreadPriorityRefresh,
  notifyWebThreadPriorityEnvironmentsChanged,
  notifyWebThreadPriorityInputChanged,
  setWebThreadPriorityForeground,
  setWebThreadPriorityRefreshEnvironments,
} from "../threadPriorityRefreshRuntime";

// Ranking support is all the bridge reads from a config: provider-status and
// settings pushes must not re-run the environments-changed refresh.
const selectRankingSupported = (config: ServerConfig | null) =>
  config?.environment.capabilities.threadPriorityRanking === true;
const selectSavedRankingSupport = (state: {
  readonly byId: Readonly<
    Record<string, { readonly serverConfig?: ServerConfig | null } | undefined>
  >;
}): Record<string, boolean> => {
  const support: Record<string, boolean> = {};
  for (const [environmentId, runtime] of Object.entries(state.byId)) {
    support[environmentId] = selectRankingSupported(runtime?.serverConfig ?? null);
  }
  return support;
};

function useConnections() {
  const [connections, setConnections] = useState(() => listEnvironmentConnections());
  useEffect(
    () =>
      subscribeEnvironmentConnections(() => {
        setConnections(listEnvironmentConnections());
      }),
    [],
  );
  return connections;
}

/** Connects the platform-neutral ranking coordinator to browser lifecycle and live nodes. */
export function ThreadPriorityRefreshBridge() {
  const enabled = useSettings((settings) => settings.aiFocusEnabled);
  const intervalMs = useSettings((settings) => settings.aiFocusRefreshIntervalMs);
  const connections = useConnections();
  const connectionOpenedCount = useWsConnectionOpenedCount();
  const primarySupported = useServerConfigSelector(selectRankingSupported);
  const savedSupportById = useSavedEnvironmentRuntimeStore(useShallow(selectSavedRankingSupport));
  const threads = useStore(useShallow(selectSidebarThreadsAcrossEnvironments));

  const environments = useMemo(() => {
    // The opened counter is the cross-environment edge signal. Reading it here
    // recomputes keyed status even when the supervisor's connection list is unchanged.
    void connectionOpenedCount;
    return connections.map((connection) => {
      const environmentId = connection.environmentId;
      const status = getWsConnectionStatusForEnvironment(environmentId);
      const supported =
        getPrimaryKnownEnvironment()?.environmentId === environmentId
          ? primarySupported
          : savedSupportById[environmentId] === true;
      return {
        environmentId,
        generation: status.attemptCount,
        connected: status.phase === "connected",
        supported,
      };
    });
  }, [connections, connectionOpenedCount, primarySupported, savedSupportById]);

  useEffect(() => {
    setWebThreadPriorityRefreshEnvironments(environments);
    void notifyWebThreadPriorityEnvironmentsChanged();
  }, [environments]);

  useEffect(() => {
    void configureWebThreadPriorityRefresh({ enabled, intervalMs });
  }, [enabled, intervalMs]);

  useEffect(() => {
    notifyWebThreadPriorityInputChanged();
  }, [threads]);

  useEffect(() => {
    void setWebThreadPriorityForeground(webAppLifecycle.isForeground());
    return webAppLifecycle.subscribe((event) => {
      if (event === "background") void setWebThreadPriorityForeground(false);
      if (event === "foreground" || event === "resume") {
        void setWebThreadPriorityForeground(true);
      }
    });
  }, []);

  return null;
}
