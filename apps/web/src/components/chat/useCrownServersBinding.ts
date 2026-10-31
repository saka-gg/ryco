import {
  describeThreadLocalServerStopFailure,
  watchThreadLocalServers,
} from "@ryco/client-runtime/rpc/threadLocalServers";
import {
  type EnvironmentId,
  type ServerConfig,
  type ThreadId,
  type ThreadLocalServer,
  type ThreadLocalServerList,
  WS_METHODS,
} from "@ryco/contracts";
import { useCallback, useEffect, useMemo, useState } from "react";

import { normalizeBrowserUrl, projectBrowserKey, useBrowserUi } from "~/browser/browserState";
import { readEnvironmentApi } from "~/environmentApi";
import { isLoopbackHostname } from "~/environments/primary";
import { getEnvironmentHttpBaseUrl } from "~/environments/runtime";
import { readHostedRpcCapability, useHostedRpcCapability } from "~/hostedHub/capabilities";
import { useDocumentVisible } from "~/hooks/useDocumentVisible";
import { useEnvironmentServerConfigSelector } from "~/hooks/useChatsAvailability";
import { openExternalLink } from "~/lib/openExternalLink";

import { stackedThreadToast, toastManager } from "../ui/toast";
import type { CrownServersBinding } from "../overview/crown/crownTypes";
import { serverDisplayName } from "../overview/crown/details/ServersDetail";

const NO_SERVERS: ReadonlyArray<ThreadLocalServer> = [];
const NOT_STOPPING: ReadonlySet<number> = new Set();

const selectListsThreadServers = (config: ServerConfig | null) =>
  config?.environment.capabilities.threadLocalServers === true;
const selectStopsThreadServers = (config: ServerConfig | null) =>
  config?.environment.capabilities.threadLocalServerStop === true;
const selectNodeLabel = (config: ServerConfig | null) => config?.environment.label ?? null;

/** Whether this client reaches the node over loopback, so its `localhost` is this computer's. */
function nodeIsThisComputer(environmentId: EnvironmentId): boolean {
  try {
    const url = getEnvironmentHttpBaseUrl(environmentId);
    return url !== null && isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/**
 * The crown's Servers section for one thread: the servers its agents and terminals started, from
 * `threads.subscribeLocalServers`, followed only while the crown is open and the page visible, on
 * nodes that list them and for roles that may. Undefined when the section cannot show.
 *
 * `openInBrowserPanel` is set when the thread runs on this desktop's own backend: Open then puts
 * the page in a Browser panel tab for the thread's workspace (`cwd`) and shows that panel.
 */
export function useCrownServersBinding(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly cwd: string | null;
  readonly enabled: boolean;
  readonly openInBrowserPanel: (() => void) | null;
}): CrownServersBinding | undefined {
  const { environmentId, threadId, cwd, openInBrowserPanel } = input;
  const listsServers = useEnvironmentServerConfigSelector(environmentId, selectListsThreadServers);
  const stopsServers = useEnvironmentServerConfigSelector(environmentId, selectStopsThreadServers);
  const nodeLabel = useEnvironmentServerConfigSelector(environmentId, selectNodeLabel);
  const listCapability = useHostedRpcCapability(
    WS_METHODS.threadsSubscribeLocalServers,
    environmentId,
  );
  const stopCapability = useHostedRpcCapability(WS_METHODS.threadsStopLocalServer, environmentId);
  const visible = useDocumentVisible();
  const [list, setList] = useState<ThreadLocalServerList | null>(null);
  const [stopping, setStopping] = useState<ReadonlySet<number>>(NOT_STOPPING);

  const following =
    input.enabled &&
    visible &&
    listsServers &&
    listCapability.allowed &&
    environmentId !== null &&
    threadId !== null;
  useEffect(() => {
    if (!following || environmentId === null || threadId === null) return;
    const subscribe = readEnvironmentApi(environmentId)?.threads?.subscribeLocalServers;
    if (subscribe === undefined) return;
    return watchThreadLocalServers(subscribe, threadId, setList);
  }, [environmentId, following, threadId]);

  const servers =
    listsServers && listCapability.allowed && list !== null && list.threadId === threadId
      ? list.servers
      : NO_SERVERS;
  const browserPanel = openInBrowserPanel !== null && window.desktopBridge?.browser !== undefined;
  const thisComputer =
    environmentId !== null && (browserPanel || nodeIsThisComputer(environmentId));

  const open = useCallback(
    (server: ThreadLocalServer) => {
      // Built here from the port, never taken from the node: Open only ever goes to localhost.
      const url = `http://localhost:${server.port}/`;
      const api = window.desktopBridge?.browser;
      if (!browserPanel || api === undefined || openInBrowserPanel === null) {
        openExternalLink(url, "Could not open the server");
        return;
      }
      const project = projectBrowserKey(environmentId, cwd);
      void api
        .open({ url: normalizeBrowserUrl(url), project })
        .then((tab) => {
          useBrowserUi.getState().select(project, tab);
          openInBrowserPanel();
        })
        .catch((error: unknown) =>
          toastManager.add({
            type: "error",
            title: "Could not open the server",
            description: error instanceof Error ? error.message : "The Browser panel refused it.",
          }),
        );
    },
    [browserPanel, cwd, environmentId, openInBrowserPanel],
  );

  const canStop = stopsServers && stopCapability.allowed;
  const stop = useCallback(
    (server: ThreadLocalServer) => {
      if (environmentId === null || threadId === null) return;
      // Re-read at click time, so a stale render cannot get past a role change.
      const capability = readHostedRpcCapability(WS_METHODS.threadsStopLocalServer, environmentId);
      const stopServer = readEnvironmentApi(environmentId)?.threads?.stopLocalServer;
      const threadRef = { environmentId, threadId };
      if (!capability.allowed || stopServer === undefined) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not stop the server",
            description: capability.reason ?? "This node cannot stop servers.",
            data: { threadRef },
          }),
        );
        return;
      }
      setStopping((current) => new Set(current).add(server.pid));
      void stopServer({
        threadId,
        pid: server.pid,
        startTimeMs: server.startTimeMs,
        port: server.port,
      })
        .then((result) => {
          if (result.stopped) return;
          toastManager.add(
            stackedThreadToast({
              type: "warning",
              title: `${serverDisplayName(server)} is still running`,
              description: "It did not stop in time. You can try again.",
              data: { threadRef },
            }),
          );
        })
        .catch((error: unknown) =>
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: `Could not stop ${serverDisplayName(server)}`,
              description: describeThreadLocalServerStopFailure(error),
              data: { threadRef },
            }),
          ),
        )
        .finally(() =>
          setStopping((current) => {
            const next = new Set(current);
            next.delete(server.pid);
            return next;
          }),
        );
    },
    [environmentId, threadId],
  );

  return useMemo<CrownServersBinding | undefined>(
    () =>
      servers.length === 0
        ? undefined
        : {
            servers,
            open,
            opensIn: browserPanel ? "browser-panel" : "external",
            remoteNodeLabel: thisComputer ? null : (nodeLabel ?? "the node's computer"),
            stop: canStop ? stop : null,
            stopping,
          },
    [browserPanel, canStop, nodeLabel, open, servers, stop, stopping, thisComputer],
  );
}
