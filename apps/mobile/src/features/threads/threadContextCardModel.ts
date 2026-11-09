import type { SFSymbol } from "expo-symbols";

import type { ThreadParentLink } from "./threadContextSheetModel";
import type { ThreadHeaderModel } from "./threadHeaderModel";

// The minimal context card the title pill drops: which quick buttons apply and which compact
// rows the chat's extras (goal, delegation, cache, Agent Control, pull request watch) need.
// Everything else stays one tap away in the full context sheet ("More details").

export type ThreadContextCardQuickId = "files" | "changes" | "pr";

export interface ThreadContextCardQuick {
  readonly id: ThreadContextCardQuickId;
  readonly label: string;
  readonly icon: SFSymbol;
}

/** Files when the chat has a workspace, Changes when a turn changed files, PR when there is one. */
export function threadContextCardQuickButtons(
  model: Pick<ThreadHeaderModel, "filesVisible" | "reviewVisible" | "changeRequest">,
): ReadonlyArray<ThreadContextCardQuick> {
  const buttons: ThreadContextCardQuick[] = [];
  if (model.filesVisible) buttons.push({ id: "files", label: "Files", icon: "folder" });
  if (model.reviewVisible)
    buttons.push({ id: "changes", label: "Changes", icon: "arrow.triangle.branch" });
  if (model.changeRequest) buttons.push({ id: "pr", label: "PR", icon: "arrow.triangle.pull" });
  return buttons;
}

/** Where a compact row leads: the full sheet, or straight to its own place. */
export type ThreadContextCardRowTarget = "details" | "parent" | "agents" | "cache";

export interface ThreadContextCardRow {
  readonly id: "goal" | "parent" | "delegated" | "agents" | "cache" | "receipts" | "watch";
  readonly icon: SFSymbol;
  readonly label: string;
  readonly detail: string | null;
  readonly target: ThreadContextCardRowTarget;
}

const GOAL_DETAIL: Readonly<Record<string, string>> = {
  active: "Pursuing",
  paused: "Paused",
  blocked: "Blocked",
  usageLimited: "Usage limit",
  budgetLimited: "Budget reached",
  complete: "Achieved",
};

/** The chat's extras, in the sheet's order, only those it has. */
export function threadContextCardRows(input: {
  readonly goal: { readonly objective: string; readonly status: string } | null;
  readonly parent: Pick<ThreadParentLink, "title" | "resultLabel"> | null;
  readonly delegatedCount: number;
  /** The chat's own subagents' entry, shown when it delegated no chats. */
  readonly agents: { readonly label: string } | null;
  readonly cacheSummary: string | null;
  readonly receiptCount: number;
  readonly watchLabel: string | null;
}): ReadonlyArray<ThreadContextCardRow> {
  const rows: ThreadContextCardRow[] = [];
  if (input.goal)
    rows.push({
      id: "goal",
      icon: input.goal.status === "complete" ? "checkmark.circle" : "scope",
      label: input.goal.objective.trim() || "Goal",
      detail: GOAL_DETAIL[input.goal.status] ?? null,
      target: "details",
    });
  if (input.parent)
    rows.push({
      id: "parent",
      icon: "arrow.turn.left.up",
      label: `From ${input.parent.title}`,
      detail: input.parent.resultLabel,
      target: "parent",
    });
  if (input.delegatedCount > 0)
    rows.push({
      id: "delegated",
      icon: "arrow.triangle.branch",
      label:
        input.delegatedCount === 1 ? "1 delegated chat" : `${input.delegatedCount} delegated chats`,
      detail: null,
      target: "details",
    });
  else if (input.agents)
    rows.push({
      id: "agents",
      icon: "person.2",
      label: input.agents.label,
      detail: null,
      target: "agents",
    });
  if (input.cacheSummary !== null)
    rows.push({
      id: "cache",
      icon: "info.circle",
      label: "Claude cache",
      detail: input.cacheSummary,
      target: "cache",
    });
  if (input.watchLabel !== null)
    rows.push({
      id: "watch",
      icon: "eye",
      label: "Pull request watch",
      detail: input.watchLabel,
      target: "details",
    });
  if (input.receiptCount > 0)
    rows.push({
      id: "receipts",
      icon: "checklist",
      label: "Agent Control",
      detail: String(input.receiptCount),
      target: "details",
    });
  return rows;
}

/** The context ring's whole percent, 0–100; null without a known limit. */
export function contextRingPercent(fraction: number | null): number | null {
  if (fraction === null || !Number.isFinite(fraction)) return null;
  return Math.round(Math.min(1, Math.max(0, fraction)) * 100);
}

export type MachineStatusTone = "online" | "connecting" | "offline";

/** The machine's dot: green when connected, amber while connecting, grey otherwise. */
export function machineStatusTone(state: string): MachineStatusTone {
  if (state === "connected") return "online";
  if (state === "connecting" || state === "reconnecting") return "connecting";
  return "offline";
}
