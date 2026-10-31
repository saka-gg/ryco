import { useAtomValue } from "@effect/atom-react";
import { serverConfigAtom } from "@ryco/client-runtime/rpc";
import {
  CLI_PROXY_HUB_POLL_INTERVAL_MS,
  CLI_PROXY_HUBS_UNSUPPORTED_MESSAGE,
  cliProxyHubsSupported,
  readCliProxyHubsOutcome,
  UsageRequestGeneration,
  type CliProxyHubRead,
} from "@ryco/client-runtime/usage";
import type { EnvironmentId, ServerProvider } from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { usePrimaryEnvironmentId } from "~/environments/primary";
import { useSavedEnvironmentRuntimeStore } from "~/environments/runtime";
import { createVisibilityAwarePoller } from "~/lib/visibilityPolling";
import { webAppLifecycle } from "~/platform/appLifecycle";
import { useQueryClient } from "~/rpc/queryClient";

import { cliProxyHubsQueryKey } from "../../usage/cliProxyHubsQuery";
import { selectConnections, useConnectedEnvironments } from "../useConnectedEnvironments";

const NO_PROVIDERS: readonly ServerProvider[] = [];

/** One environment's hub read, by the shared hub-read policy (`usage/cliProxyHubReads`). */
interface HubReadResult extends CliProxyHubRead {
  readonly environmentId: EnvironmentId;
}

/** One selected environment's last hub read, with its provider snapshots as they are now. */
export interface LimitsEnvironmentResult extends Omit<HubReadResult, "status" | "receivedAtMs"> {
  readonly label: string;
  /** `loading`: no hub read has answered for it yet, so it lists no hubs. */
  readonly status: HubReadResult["status"] | "loading";
  readonly connected: boolean;
  /** Live provider snapshots; their `rateLimits` are the accounts the node signs in to itself. */
  readonly providers: readonly ServerProvider[];
}

export interface UseSubscriptionLimitsResult {
  /** Every connected environment, whether or not the current filter selects it. */
  readonly availableEnvironments: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly environments: readonly LimitsEnvironmentResult[];
  readonly loading: boolean;
  readonly refreshing: boolean;
  /** When the current hub reads arrived; hub snapshot times are never later than this. */
  readonly receivedAtMs: number;
  /** Re-read every hub, asking nodes to bypass their caches (within their upstream floor). */
  readonly refresh: () => void;
}

/**
 * What the Limits view shows for the selected environments: their CLIProxyAPI hubs, polled, and
 * their provider snapshots, live.
 */
export function useSubscriptionLimits(input: {
  readonly environmentIds?: readonly string[] | undefined;
}): UseSubscriptionLimitsResult {
  // Uncompiled on purpose: Babel's React Compiler never compiled this function
  // (it bails on value blocks inside try/catch). Oxc can, but its render reads
  // have not been audited for purity yet. Remove after that audit.
  "use no memo";
  const queryClient = useQueryClient();
  const connections = useConnectedEnvironments();
  const selected = useMemo(
    () => selectConnections(connections, input.environmentIds),
    [connections, input.environmentIds],
  );
  const availableEnvironments = useMemo(
    () =>
      connections
        .map((connection) => ({
          environmentId: connection.environmentId,
          label: connection.knownEnvironment.label,
        }))
        .toSorted((left, right) => left.label.localeCompare(right.label)),
    [connections],
  );
  // Nodes whose config says they predate hubs. A node whose config is not known yet is asked.
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryConfig = useAtomValue(serverConfigAtom);
  const savedRuntimeById = useSavedEnvironmentRuntimeStore((state) => state.byId);
  const unsupportedKey = selected
    .filter((connection) => {
      const config =
        connection.environmentId === primaryEnvironmentId
          ? primaryConfig
          : (savedRuntimeById[connection.environmentId]?.serverConfig ?? null);
      return !cliProxyHubsSupported(config);
    })
    .map((connection) => connection.environmentId)
    .toSorted()
    .join("\0");
  const unsupported = useMemo(
    () => new Set(unsupportedKey.split("\0").filter(Boolean)),
    [unsupportedKey],
  );
  const [hubResults, setHubResults] = useState<readonly HubReadResult[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [receivedAtMs, setReceivedAtMs] = useState(0);
  const generations = useRef(new UsageRequestGeneration());
  const pollerRef = useRef<{ readonly refresh: () => Promise<void> } | null>(null);
  const forceNextRef = useRef(false);

  const load = useCallback(async () => {
    const generation = generations.current.next();
    const refresh = forceNextRef.current;
    forceNextRef.current = false;
    setRefreshing(true);
    const results = await Promise.all(
      selected.map(async (connection): Promise<HubReadResult> => {
        const base = { environmentId: connection.environmentId };
        if (unsupported.has(connection.environmentId)) {
          return {
            ...base,
            status: "unsupported",
            hubs: [],
            message: CLI_PROXY_HUBS_UNSUPPORTED_MESSAGE,
            receivedAtMs: Date.now(),
          };
        }
        const read = await readCliProxyHubsOutcome(() =>
          connection.client.server.readCliProxyHubs(refresh ? { refresh: true } : {}),
        );
        return { ...base, ...read };
      }),
    );
    if (!generations.current.isCurrent(generation)) return;
    for (const result of results) {
      if (result.status === "ok") {
        queryClient.setQueryData(cliProxyHubsQueryKey(result.environmentId), result.hubs);
      }
    }
    setHubResults(results);
    setReceivedAtMs(Date.now());
    setLoading(false);
    setRefreshing(false);
  }, [queryClient, selected, unsupported]);

  useEffect(() => {
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: load,
      // The node caches hub reads and floors upstream quota calls; this only bounds how stale
      // an open Limits page gets. Foregrounding the app refreshes immediately.
      resolveDelayMs: () => CLI_PROXY_HUB_POLL_INTERVAL_MS,
      jitterRatio: 0.1,
    });
    pollerRef.current = poller;
    return () => {
      poller.stop();
      if (pollerRef.current === poller) pollerRef.current = null;
    };
  }, [load]);

  const refresh = useCallback(() => {
    forceNextRef.current = true;
    void pollerRef.current?.refresh();
  }, []);

  // Every selected environment shows its live providers at once; its hubs join when read.
  const environments = useMemo(() => {
    const hubReads = new Map(hubResults.map((result) => [result.environmentId, result]));
    return selected.map((connection): LimitsEnvironmentResult => {
      const { environmentId } = connection;
      const primary = environmentId === primaryEnvironmentId;
      const runtime = savedRuntimeById[environmentId];
      const config = primary ? primaryConfig : (runtime?.serverConfig ?? null);
      return {
        ...(hubReads.get(environmentId) ?? { environmentId, status: "loading", hubs: [] }),
        label: connection.knownEnvironment.label,
        connected: primary || runtime?.connectionState === "connected",
        providers: config?.providers ?? NO_PROVIDERS,
      };
    });
  }, [hubResults, primaryConfig, primaryEnvironmentId, savedRuntimeById, selected]);

  return { availableEnvironments, environments, loading, refreshing, receivedAtMs, refresh };
}
