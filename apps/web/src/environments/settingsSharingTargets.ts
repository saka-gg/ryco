import type { NodeSettingsTarget } from "@ryco/client-runtime/state/settings/nodeSettingsTargets";
import type { SettingsSharingNamespace } from "@ryco/client-runtime/state/settings/settingsSharingClock";
import type { SettingsSharingRunnerOptions } from "@ryco/client-runtime/state/settings/sharedDeviceSettingsRunner";

import { isHostedHubMode } from "../env";
import { subscribeHostedRpcCapabilities } from "../hostedHub/capabilities";
import { useHostedHubStore } from "../hostedHub/state";
import {
  readDesktopWorkspaceState,
  subscribeDesktopWorkspaceState,
} from "../platform/desktopWorkspace";
import {
  listKnownSettingsNodes,
  readNodeSettingsTarget,
  subscribeNodeSettingsTargets,
  type KnownSettingsNode,
} from "./nodeSettingsTargets";
import { readPrimaryEnvironmentDescriptor, subscribePrimaryEnvironmentDescriptor } from "./primary";
import { useSavedEnvironmentRegistryStore } from "./runtime";

/**
 * The web's devices for the shared-settings runner (`createSettingsSharingRunner`): every node
 * this client knows, each read as a write target at the moment it is asked for, so `canWrite`
 * is the node's own current capability (hosted: its environment session's grant now, never a
 * superseded generation's). Not started anywhere yet; the shared-settings UI decides where the
 * runner lives.
 */

/**
 * Whose devices this client's sharing state serves now: the signed-in Hub account, or this
 * app's own connections. Null while a hosted browser is not signed in (nothing to share then).
 */
export function readSettingsSharingNamespace(): SettingsSharingNamespace | null {
  if (!isHostedHubMode()) return { kind: "local" };
  const state = useHostedHubStore.getState();
  const accountId = state.accountStatus === "authenticated" ? state.account?.id : undefined;
  if (accountId === undefined || accountId.length === 0) return null;
  return { kind: "hosted", hubOrigin: window.location.origin, accountId };
}

/** Every node this client knows, read now (the non-hook {@link useKnownSettingsNodes}). */
export function readKnownSettingsNodes(): ReadonlyArray<KnownSettingsNode> {
  return listKnownSettingsNodes({
    hosted: isHostedHubMode(),
    primary: readPrimaryEnvironmentDescriptor(),
    hostedNodes: useHostedHubStore.getState().nodes,
    savedEnvironments: useSavedEnvironmentRegistryStore.getState().byId,
    desktopWorkspace: readDesktopWorkspaceState(),
  });
}

/** Every known node as a write target, as it is now. */
export function readSettingsSharingTargets(): ReadonlyArray<NodeSettingsTarget> {
  return readKnownSettingsNodes().map(readNodeSettingsTarget);
}

function sameNodes(
  a: ReadonlyArray<KnownSettingsNode>,
  b: ReadonlyArray<KnownSettingsNode>,
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (node, index) =>
        node.environmentId === b[index]?.environmentId && node.label === b[index]?.label,
    )
  );
}

/**
 * Calls `listener` whenever a target may have changed: the set of known nodes, a node's config,
 * connection or socket, or a hosted capability. Follows nodes added or removed.
 */
export function subscribeSettingsSharingTargets(listener: () => void): () => void {
  let nodes = readKnownSettingsNodes();
  let unsubscribeTargets = subscribeNodeSettingsTargets(
    nodes.map((node) => node.environmentId),
    listener,
  );
  const onSourcesChange = () => {
    const next = readKnownSettingsNodes();
    if (!sameNodes(nodes, next)) {
      nodes = next;
      unsubscribeTargets();
      unsubscribeTargets = subscribeNodeSettingsTargets(
        nodes.map((node) => node.environmentId),
        listener,
      );
    }
    listener();
  };
  const unsubscribes = [
    subscribePrimaryEnvironmentDescriptor(onSourcesChange),
    useHostedHubStore.subscribe(onSourcesChange),
    useSavedEnvironmentRegistryStore.subscribe(onSourcesChange),
    subscribeDesktopWorkspaceState(onSourcesChange),
    subscribeHostedRpcCapabilities(listener),
  ];
  return () => {
    unsubscribeTargets();
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** The runner's device options on the web; the caller adds its clock and cache. */
export const webSettingsSharingRunnerTargets: Pick<
  SettingsSharingRunnerOptions,
  "readTargets" | "subscribe"
> = {
  readTargets: readSettingsSharingTargets,
  subscribe: subscribeSettingsSharingTargets,
};
