import type { EnvironmentId } from "@ryco/contracts";
import { isTagged } from "effect/Predicate";

import { readEnvironmentApi } from "~/environmentApi";
import { queryOptions } from "~/rpc/queryClient";

/** A node's hubs as last read by any surface; the Limits page seeds it with each of its reads. */
export function cliProxyHubsQueryKey(environmentId: EnvironmentId | null) {
  return ["cliProxy", "hubs", environmentId] as const;
}

/**
 * A node's CLIProxyAPI hubs for surfaces that read them only while open (the composer's usage
 * popup): a read is reused for 30s so reopening does not ask the node again, a failed read is
 * retried on the next open, and nothing polls. The node caches its hub and quota reads further.
 * A session the node refuses hub reads (not its owner) reads as having no hubs.
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
      try {
        return (await readHubs({})).hubs;
      } catch (cause) {
        if (isTagged(cause, "AuthRpcError")) return [];
        throw cause;
      }
    },
    enabled: environmentId !== null,
    staleTime: 30_000,
    retry: false,
  });
}
