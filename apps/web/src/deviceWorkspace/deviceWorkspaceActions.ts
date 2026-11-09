import { scopedThreadKey, scopeThreadRef } from "@ryco/client-runtime/scoped";
import { useDeviceStateStore } from "@ryco/client-runtime/state/device";
import { threadAttachments } from "@ryco/client-runtime/state/device/threadAttachments";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";

import { readEnvironmentApi } from "../environmentApi";
import { activeDeviceTab } from "./deviceTabs.logic";
import { selectThreadDeviceTabs, useDeviceTabsStore } from "./deviceTabsStore";
import { floatingDeviceUdid, useWorkspaceMiniPlayerStore } from "./workspaceMiniPlayerStore";

/*
 * What the device tabs, the device panel and the floating window do to each
 * other. A device is shown in at most one place per thread, and the server
 * attachment follows what the user can see: closing the last place a device
 * is shown detaches it (the device keeps running), while an agent's own
 * attachment is left for the agent.
 */

export interface DeviceWorkspaceThread {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

export function deviceWorkspaceThreadKey(thread: DeviceWorkspaceThread): string {
  return scopedThreadKey(scopeThreadRef(thread.environmentId, thread.threadId));
}

function attachmentSource(thread: DeviceWorkspaceThread, udid: string): "user" | "agent" | null {
  const state = useDeviceStateStore.getState().threadByKey[deviceWorkspaceThreadKey(thread)];
  return threadAttachments(state).find((entry) => entry.udid === udid)?.source ?? null;
}

/**
 * Devices this client stopped watching, per thread. The detach is in flight
 * until the server's snapshot arrives, and the panel must not adopt the still
 * listed attachment back into a tab meanwhile (see `adoptableUdids`).
 */
const releasedByThreadKey = new Map<string, Set<string>>();

/**
 * Attachments a thread without tabs may open as tabs: a person's, except
 * those this client closed.
 */
export function adoptableUdids(
  threadKey: string,
  attachments: ReadonlyArray<{ readonly udid: string; readonly source: "user" | "agent" }>,
): string[] {
  const released = releasedByThreadKey.get(threadKey);
  return attachments
    .filter((entry) => entry.source === "user" && !released?.has(entry.udid))
    .map((entry) => entry.udid);
}

/** A device the user opens again is theirs to adopt again. */
export function forgetReleasedDevice(threadKey: string, udid: string): void {
  releasedByThreadKey.get(threadKey)?.delete(udid);
}

/** Stop watching a device nothing on this client shows any more. */
function releaseIfUnshown(thread: DeviceWorkspaceThread, udid: string): void {
  const threadKey = deviceWorkspaceThreadKey(thread);
  const tabs = selectThreadDeviceTabs(useDeviceTabsStore.getState().byThreadKey, threadKey);
  if (tabs.tabs.some((tab) => tab.udid === udid)) return;
  if (floatingDeviceUdid(useWorkspaceMiniPlayerStore.getState().byThreadKey, threadKey) === udid)
    return;
  // An agent's attachment is the agent's: it holds nothing, and its tools may need it.
  if (attachmentSource(thread, udid) !== "user") return;
  const released = releasedByThreadKey.get(threadKey) ?? new Set<string>();
  released.add(udid);
  releasedByThreadKey.set(threadKey, released);
  void readEnvironmentApi(thread.environmentId)
    ?.device?.detach({ threadId: thread.threadId, udid })
    .catch(() => undefined);
}

/**
 * Close a device tab. The device keeps running; the thread stops watching it
 * unless it still floats over the chat. Returns how many device tabs remain.
 */
export function closeWorkspaceDeviceTab(thread: DeviceWorkspaceThread, tabId: string): number {
  const threadKey = deviceWorkspaceThreadKey(thread);
  const store = useDeviceTabsStore.getState();
  const tab = selectThreadDeviceTabs(store.byThreadKey, threadKey).tabs.find(
    (candidate) => candidate.id === tabId,
  );
  store.close(threadKey, tabId);
  if (tab?.udid) releaseIfUnshown(thread, tab.udid);
  return selectThreadDeviceTabs(useDeviceTabsStore.getState().byThreadKey, threadKey).tabs.length;
}

/** Float a device over the chat; the panel shows a placeholder for it meanwhile. */
export function floatWorkspaceDevice(thread: DeviceWorkspaceThread, udid: string): void {
  const threadKey = deviceWorkspaceThreadKey(thread);
  const previous = floatingDeviceUdid(
    useWorkspaceMiniPlayerStore.getState().byThreadKey,
    threadKey,
  );
  useWorkspaceMiniPlayerStore.getState().open(threadKey, { kind: "device", udid });
  // The thread has one floating window: a device it replaces stops being
  // watched unless a tab still shows it.
  if (previous !== null && previous !== udid) releaseIfUnshown(thread, previous);
}

/**
 * Bring the floating device back into the right panel, in its tab. Returns
 * the device, so the caller can open the panel on it.
 */
export function dockFloatingDevice(thread: DeviceWorkspaceThread): string | null {
  const threadKey = deviceWorkspaceThreadKey(thread);
  const udid = floatingDeviceUdid(useWorkspaceMiniPlayerStore.getState().byThreadKey, threadKey);
  if (udid === null) return null;
  useDeviceTabsStore.getState().openDevice(threadKey, udid);
  useWorkspaceMiniPlayerStore.getState().close(threadKey);
  return udid;
}

/** Close the floating window. A device no tab shows stops being watched. */
export function closeFloatingDevice(thread: DeviceWorkspaceThread): void {
  const threadKey = deviceWorkspaceThreadKey(thread);
  const udid = floatingDeviceUdid(useWorkspaceMiniPlayerStore.getState().byThreadKey, threadKey);
  useWorkspaceMiniPlayerStore.getState().close(threadKey);
  if (udid !== null) releaseIfUnshown(thread, udid);
}

/**
 * An agent opened a device in this thread: float it over the chat, or, with
 * floating turned off, open its tab. Nothing happens when the visible panel
 * already shows it. Returns "tab" when the caller should open the panel.
 */
export function showAgentOpenedDevice(input: {
  readonly thread: DeviceWorkspaceThread;
  readonly udid: string;
  readonly floating: boolean;
  /** Whether the workspace panel is open on its device tabs. */
  readonly devicePanelVisible: boolean;
}): "float" | "tab" | "none" {
  const threadKey = deviceWorkspaceThreadKey(input.thread);
  const tabs = selectThreadDeviceTabs(useDeviceTabsStore.getState().byThreadKey, threadKey);
  if (input.devicePanelVisible && activeDeviceTab(tabs)?.udid === input.udid) return "none";
  if (input.floating) {
    floatWorkspaceDevice(input.thread, input.udid);
    return "float";
  }
  useDeviceTabsStore.getState().openDevice(threadKey, input.udid);
  return "tab";
}
