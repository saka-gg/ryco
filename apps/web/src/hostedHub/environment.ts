import {
  activateHostedNode,
  clearHostedNodeScopedState as clearCoreHostedNodeScopedState,
  deactivateHostedNode,
  suspendHostedNode,
} from "@ryco/client-runtime/authorization";
import type { EnvironmentId } from "@ryco/contracts";

import { useComposerDraftStore } from "../composerDraftStore";
import { useCommandPaletteStore } from "../commandPaletteStore";
import { useMessageQueueStore } from "../messageQueueStore";
import { setModelPickerOpen } from "../modelPickerOpenState";
import { clearKeyedQueriesForEnvironment } from "../rpc/keyedQuery";
import { clearProjectAtomState } from "../rpc/projectAtoms";
import { clearGitAtomState } from "../rpc/gitAtoms";
import { clearCheckpointDiffState } from "../rpc/providerAtoms";
import { clearServerState } from "../rpc/serverState";
import { defaultQueryClient } from "../rpc/queryClient";
import { useSettingsDialogStore } from "../settingsDialogStore";
import { clearShortcutModifierState } from "../shortcutModifierState";
import { useStore } from "../store";
import { useTerminalStateStore } from "../terminalStateStore";
import { useThreadSelectionStore } from "../threadSelectionStore";
import { useUiStateStore } from "../uiStateStore";
import { resetWebE2eeSession } from "./e2eeSession";

/** Browser/UI clearing catalog only. Core lifecycle owns the call ordering. */
export function clearWebHostedNodeScopedState(environmentId: EnvironmentId): void {
  // docs/relay-e2ee-protocol.md §13's per-channel projection is node-scoped and
  // belongs here: a status that outlives the channel that earned it describes a
  // connection that no longer exists.
  //
  // §12.1'S LATCH DELIBERATELY DOES NOT. It is APPLICATION-SESSION state, and
  // this catalog runs on every node teardown — `deactivateCurrentHostedNode`
  // calls it on the node being left, including on the A→B switch that
  // `activateHostedNode` performs. Clearing here therefore returned every
  // already-latched selection to `legacy-eligible`, which RELAXES §12.1.1's
  // classification rather than tightening it: a Hub that then withholds the §5.3
  // carrier past `T_ADV` takes row K13 instead of row K14, and the buffered
  // application sends go onto the relay as plaintext on a selection that had
  // already proven the node speaks §4 in this same session. The latch ends where
  // §12.1 says it ends — with the application session — and
  // `watchWebHostedSessionForE2ee` is what ends it, on sign-out.
  resetWebE2eeSession();
  clearKeyedQueriesForEnvironment(environmentId);
  clearProjectAtomState();
  clearGitAtomState();
  clearCheckpointDiffState();
  // A hosted node switch is a transport disposal, not account teardown. Keep
  // list-safe rows and environment-keyed drafts/UI while stripping live
  // sessions and liveness from only the environment that lost its channel.
  useStore.getState().demoteEnvironmentStateToCachedSnapshot(environmentId, Date.now());
  clearServerState();
}

/** Account-session teardown. Unlike a node switch, this may clear every environment-keyed UI. */
export function clearWebHostedAccountScopedState(): void {
  for (const environmentId of Object.keys(useStore.getState().environmentStateById)) {
    useStore.getState().removeEnvironmentState(environmentId as EnvironmentId);
  }
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    stickyModelSelectionByProvider: {},
    stickyActiveProvider: null,
  });
  useTerminalStateStore.setState({
    terminalStateByThreadKey: {},
    terminalLaunchContextByThreadKey: {},
    terminalEventEntriesByKey: {},
    nextTerminalEventId: 1,
  });
  // `reset` bumps the queue epoch; the drain coordinator observes it and drops
  // in-flight completions from the previous account.
  useMessageQueueStore.getState().reset();
  useCommandPaletteStore.getState().setOpen(false);
  useSettingsDialogStore.getState().closeSettings();
  setModelPickerOpen(false);
  clearShortcutModifierState();
  useThreadSelectionStore.getState().clearSelection();
  useUiStateStore.setState({
    projectExpandedById: {},
    projectOrder: [],
    projectFoldersById: {},
    projectFolderOrder: [],
    projectTreeOrder: [],
    pinnedThreadKeys: {},
    threadLastVisitedAtById: {},
    threadChangedFilesExpandedById: {},
    threadWorkEntryExpandedById: {},
    defaultAdvertisedEndpointKey: null,
  });
  defaultQueryClient.clear();
  clearServerState();
}

export {
  activateHostedNode,
  deactivateHostedNode,
  suspendHostedNode,
  clearCoreHostedNodeScopedState as clearHostedNodeScopedState,
};
