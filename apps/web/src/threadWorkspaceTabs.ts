import type { RightPanelMode } from "./rightPanelRouteSearch";
import {
  findThreadSubagent,
  type ThreadSubagentStatus,
  type ThreadSubagentView,
} from "./threadWorkspaceViewModel";

export type WorkspaceTab =
  | {
      key:
        | "files"
        | "review"
        | "terminal"
        | "simulator"
        | "browser"
        | "pullRequest"
        | "agents"
        | "artifacts";
      label: string;
      mode: Exclude<RightPanelMode, "agent" | "render">;
    }
  | {
      /** One of the thread's device tabs; they all show the simulator mode. */
      key: string;
      label: string;
      mode: "simulator";
      deviceTabId: string;
    }
  | {
      /** One page tab: it shows one HTML render of the thread at a time. */
      key: "render";
      label: string;
      mode: "render";
      renderKey: string;
    }
  | {
      key: string;
      label: string;
      mode: "agent";
      agentKey: string;
      status: ThreadSubagentStatus;
      avatarKey?: string;
    };

export function buildTabs(input: {
  subagents: ReadonlyArray<ThreadSubagentView>;
  activeAgentKey: string | null;
  openedAgentKeys: ReadonlyArray<string>;
  openedPanelModes: ReadonlyArray<RightPanelMode>;
  groupAgents?: boolean;
  /** Names the pull request tab after the change request it shows. */
  pullRequestNumber?: number | null;
  /** The page tab, named after the page it shows. */
  render?: { readonly renderKey: string; readonly title: string } | null;
}): WorkspaceTab[] {
  const tabs: WorkspaceTab[] = [];
  const openedModes = new Set(input.openedPanelModes);
  if (openedModes.has("files")) {
    tabs.push({ key: "files", label: "Files", mode: "files" });
  }
  if (openedModes.has("review")) {
    tabs.push({ key: "review", label: "Review", mode: "review" });
  }
  if (openedModes.has("terminal")) {
    tabs.push({ key: "terminal", label: "Terminal", mode: "terminal" });
  }
  if (openedModes.has("browser")) tabs.push({ key: "browser", label: "Browser", mode: "browser" });
  if (openedModes.has("simulator")) {
    tabs.push({ key: "simulator", label: "Simulator", mode: "simulator" });
  }
  if (openedModes.has("pullRequest")) {
    tabs.push({
      key: "pullRequest",
      label: input.pullRequestNumber != null ? `PR #${input.pullRequestNumber}` : "Pull request",
      mode: "pullRequest",
    });
  }
  if (openedModes.has("agents") || (input.groupAgents && input.activeAgentKey)) {
    tabs.push({ key: "agents", label: "Agents", mode: "agents" });
  }
  if (openedModes.has("artifacts")) {
    tabs.push({ key: "artifacts", label: "Artifacts", mode: "artifacts" });
  }
  if (input.render) {
    tabs.push({
      key: "render",
      label: input.render.title,
      mode: "render",
      renderKey: input.render.renderKey,
    });
  }

  if (input.groupAgents) return tabs;

  const visibleAgentKeys = [
    ...new Set([...input.openedAgentKeys, ...(input.activeAgentKey ? [input.activeAgentKey] : [])]),
  ];

  for (const agentKey of visibleAgentKeys) {
    const subagent = findThreadSubagent(input.subagents, agentKey) ?? {
      key: agentKey,
      name: "Subagent",
      status: "idle" as const,
      origin: null,
      capability: null,
      tool: null,
      detail: null,
      providerThreadIds: [],
      providerSessionIds: [],
      startedAt: "",
      updatedAt: "",
      entries: [],
      messages: [],
    };
    tabs.push({
      key: subagent.key,
      label: subagent.name,
      mode: "agent",
      agentKey: subagent.key,
      status: subagent.status,
      avatarKey: subagent.avatarKey ?? subagent.key,
    });
  }

  return tabs;
}

/** The device tab a workspace tab is, if it is one. */
export function workspaceDeviceTabId(tab: WorkspaceTab): string | undefined {
  return "deviceTabId" in tab ? tab.deviceTabId : undefined;
}

/** The tab key of one device tab. */
export function deviceWorkspaceTabKey(deviceTabId: string): string {
  return `device:${deviceTabId}`;
}

/**
 * The simulator mode as the strip shows it: one tab per device tab, named by
 * the user or after its device. With no device tabs yet, the mode keeps one
 * "Device" tab, which shows the picker.
 */
export function expandDeviceTabs(
  tabs: readonly WorkspaceTab[],
  deviceTabs: ReadonlyArray<{
    readonly id: string;
    readonly udid: string | null;
    readonly title: string | null;
  }>,
  deviceName: (udid: string) => string | undefined,
): WorkspaceTab[] {
  return tabs.flatMap((tab): WorkspaceTab[] => {
    if (tab.mode !== "simulator") return [tab];
    if (deviceTabs.length === 0) return [{ ...tab, label: "Device" }];
    return deviceTabs.map((deviceTab) => ({
      key: deviceWorkspaceTabKey(deviceTab.id),
      label:
        deviceTab.title ?? (deviceTab.udid ? deviceName(deviceTab.udid) : undefined) ?? "Device",
      mode: "simulator",
      deviceTabId: deviceTab.id,
    }));
  });
}
