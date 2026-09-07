import type { RightPanelMode } from "./rightPanelRouteSearch";
import {
  findThreadSubagent,
  type ThreadSubagentStatus,
  type ThreadSubagentView,
} from "./threadWorkspaceViewModel";

export type WorkspaceTab =
  | {
      key: "files" | "review" | "terminal" | "simulator" | "browser" | "agents";
      label: string;
      mode: Exclude<RightPanelMode, "agent">;
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
  if (openedModes.has("agents") || (input.groupAgents && input.activeAgentKey)) {
    tabs.push({ key: "agents", label: "Agents", mode: "agents" });
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
