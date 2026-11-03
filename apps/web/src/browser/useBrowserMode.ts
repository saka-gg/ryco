import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";

import { relayRoleOf, useNodeRole } from "../environments/nodeRole";
import { getEnvironmentHttpBaseUrl, readEnvironmentConnection } from "../environments/runtime";
import { useEnvironmentServerConfigSelector } from "../hooks/useChatsAvailability";
import { type BrowserSide, resolveBrowserMode } from "./browserMode";

/** The node's tabs over a connection that can open their frame socket. */
export type NodeBrowserViewerClient = WsRpcClient["nodeBrowser"] & {
  readonly openFrameSource: NonNullable<WsRpcClient["nodeBrowser"]["openFrameSource"]>;
};

const canStream = (
  client: WsRpcClient["nodeBrowser"] | undefined,
): client is NodeBrowserViewerClient => client?.openFrameSource !== undefined;

// Module level, so unrelated config pushes never re-render.
const selectNodeBrowserAvailable = (config: ServerConfig | null) =>
  config?.nodeBrowser?.available === true;

/**
 * Whether the environment is the desktop app's own backend, judged by exact
 * endpoint: only then is its localhost this computer. Without a desktop
 * bridge, or without evidence, it is not.
 */
export function isDesktopOwnBackend(environmentId: EnvironmentId | null): boolean {
  try {
    const localUrl = window.desktopBridge?.getLocalEnvironmentBootstrap()?.httpBaseUrl;
    if (!localUrl) return false;
    if (environmentId === null) return true;
    const environmentUrl = getEnvironmentHttpBaseUrl(environmentId);
    return Boolean(environmentUrl) && new URL(localUrl).origin === new URL(environmentUrl!).origin;
  } catch {
    return false;
  }
}

/** The Browser panel's browser for the environment (`resolveBrowserMode`), and the node's tabs client. */
export function useBrowserMode(environmentId: EnvironmentId | null, side: BrowserSide) {
  const nodeBrowserAvailable = useEnvironmentServerConfigSelector(
    environmentId,
    selectNodeBrowserAvailable,
  );
  const role = relayRoleOf(useNodeRole(environmentId));
  const client =
    environmentId === null
      ? undefined
      : readEnvironmentConnection(environmentId)?.client.nodeBrowser;
  const resolved = resolveBrowserMode({
    nativeBrowser: Boolean(window.desktopBridge?.browser),
    ownBackend: isDesktopOwnBackend(environmentId),
    nodeBrowserAvailable,
    role,
    frameSocket: canStream(client),
    side,
  });
  // The connection's own object, so it stays the same across renders.
  return { ...resolved, nodeClient: canStream(client) ? client : null };
}
