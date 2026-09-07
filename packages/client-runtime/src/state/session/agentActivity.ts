import type { ThreadSubagentMessageView, ThreadSubagentView } from "./threadWorkspaceViewModel.ts";
import type { WorkLogEntry } from "./session-logic.ts";

export type AgentTimelineEntry =
  | {
      readonly kind: "message";
      readonly id: string;
      readonly at: string;
      readonly sequence?: number;
      readonly message: ThreadSubagentMessageView;
    }
  | {
      readonly kind: "tool";
      readonly id: string;
      readonly at: string;
      readonly sequence?: number;
      readonly tool: WorkLogEntry;
    };

/** Tools stay at their start, even when their result arrives after another message. */
export function deriveAgentTimeline(
  agent: Pick<ThreadSubagentView, "messages" | "entries">,
): ReadonlyArray<AgentTimelineEntry> {
  const rows: AgentTimelineEntry[] = [
    ...agent.messages.map((message): AgentTimelineEntry => ({
      kind: "message",
      id: `message:${message.id}`,
      at: message.createdAt,
      ...(message.sequence !== undefined ? { sequence: message.sequence } : {}),
      message,
    })),
    ...agent.entries.map((tool): AgentTimelineEntry => ({
      kind: "tool",
      id: `tool:${tool.id}`,
      at: tool.startedAt ?? tool.createdAt,
      ...(tool.sequence !== undefined ? { sequence: tool.sequence } : {}),
      tool,
    })),
  ];
  const allSequenced = rows.every((row) => row.sequence !== undefined);
  return rows.toSorted((a, b) => {
    if (
      allSequenced &&
      a.sequence !== undefined &&
      b.sequence !== undefined &&
      a.sequence !== b.sequence
    )
      return a.sequence - b.sequence;
    return a.at.localeCompare(b.at) || a.id.localeCompare(b.id);
  });
}
