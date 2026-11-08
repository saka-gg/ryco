import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";
import type { EnvironmentId } from "@ryco/contracts";
import type { NodeBrowserCapability, NodeBrowserTab } from "@ryco/contracts/node-browser";
import { useEffect, useState, useSyncExternalStore } from "react";

import { readRpcClient, subscribeEnvironmentApis } from "../../connection/environmentApi";

/** The node's browser RPCs on the environment's live connection, re-read when it changes. */
export function useNodeBrowserClient(environmentId: EnvironmentId | null) {
  return useSyncExternalStore(subscribeEnvironmentApis, () =>
    environmentId ? (readRpcClient(environmentId)?.nodeBrowser ?? null) : null,
  );
}

export type NodeBrowserClient = NonNullable<ReturnType<typeof useNodeBrowserClient>>;

/**
 * The node's tabs and whether its browser can run (`nodeBrowser.subscribe`):
 * the first events answer both, later ones follow every change.
 */
export function useNodeBrowserTabs(client: NodeBrowserClient | null) {
  const [tabs, setTabs] = useState<ReadonlyArray<NodeBrowserTab> | null>(null);
  const [capability, setCapability] = useState<NodeBrowserCapability | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!client) return;
    return client.subscribe(
      (event) => {
        if (isUnknownUnionMember(event)) return;
        if (event.type === "tabs") setTabs(event.tabs);
        else setCapability(event.capability);
      },
      {
        onError: () => setFailed(true),
        onResubscribe: () => setFailed(false),
      },
    );
  }, [client]);
  return { tabs, capability, failed };
}
