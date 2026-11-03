import { CLI_PROXY_HUB_READ_REUSE_MS, readCliProxyHubsOutcome } from "@ryco/client-runtime/usage";
import type { EnvironmentId } from "@ryco/contracts";

import { readEnvironmentApi } from "~/environmentApi";
import { queryOptions } from "~/rpc/queryClient";

/** A node's hubs as last read by any surface; the Limits page seeds it with each of its reads. */
export function cliProxyHubsQueryKey(environmentId: EnvironmentId | null) {
  return ["cliProxy", "hubs", environmentId] as const;
}

/**
 * A node's CLIProxyAPI hubs for surfaces that read them only while open (the composer's usage
 * popup), by the shared hub-read policy (`usage/cliProxyHubReads`): a read is reused for 30s so
 * reopening does not ask the node again, a failed read is retried on the next open, and nothing
 * polls. The node caches its hub and quota reads further. A session the node refuses hub reads
 * (not its owner) reads as having no hubs.
 */
export function cliProxyHubsQueryOptions(environmentId: EnvironmentId | null) {
  return queryOptions({
    queryKey: cliProxyHubsQueryKey(environmentId),
    environmentId,
    queryFn: async () => {
      const readHubs = environmentId
        ? readEnvironmentApi(environmentId)?.server?.readCliProxyHubs
        : undefined;
      if (!readHubs) throw new Error("This node is not connected.");
      const read = await readCliProxyHubsOutcome(() => readHubs({}));
      if (read.status !== "ok") throw new Error(read.message);
      return read.hubs;
    },
    enabled: environmentId !== null,
    staleTime: CLI_PROXY_HUB_READ_REUSE_MS,
    retry: false,
  });
}
