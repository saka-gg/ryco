import {
  completionReturnPresentation,
  type AgentControlStatusTone,
} from "@ryco/client-runtime/state/agentControl";
import { isDelegatedThreadLineage } from "@ryco/client-runtime/state/threads";
import type { ThreadId } from "@ryco/contracts";
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";
import type { ThreadLineage } from "@ryco/contracts/orchestration";

import type { ThreadHeaderModel } from "./threadHeaderModel";

/** The dot in the title pill and the context sheet's status word share one tone. */
export type ThreadStatusTone = "working" | "attention" | "ready" | "muted";

export function threadStatusTone(statusLabel: ThreadHeaderModel["statusLabel"]): ThreadStatusTone {
  switch (statusLabel) {
    case "Running":
      return "working";
    case "Needs approval":
    case "Input needed":
      return "attention";
    case "Ready":
      return "ready";
    case "Archived":
    case "Offline":
      return "muted";
  }
}

/** The pill's spoken label: title, status and where it works. */
/** What the header's title pill shows: kept this small so the header only rebuilds for it. */
export type ThreadTitlePillView = Pick<
  ThreadHeaderModel,
  "title" | "statusLabel" | "projectLabel" | "worktreeLabel"
>;

export function threadTitlePillAccessibilityLabel(model: ThreadTitlePillView): string {
  return `${model.title}. ${model.statusLabel}. ${model.projectLabel}, ${model.worktreeLabel}. Show details.`;
}

/** A delegated chat's way back to the chat that started it, and where its result stands. */
export interface ThreadParentLink {
  readonly threadId: ThreadId;
  readonly title: string;
  /** "Returned", "Result pending"…: null when the parent's proposals are not known here. */
  readonly resultLabel: string | null;
  readonly resultTone: AgentControlStatusTone | null;
}

export function buildThreadParentLink(input: {
  readonly lineage: ThreadLineage | null | undefined;
  /** The parent's title as this node lists it; null while its row is not loaded. */
  readonly parentTitle: string | null;
  /** This chat's result return, from the parent's Agent Control proposals. */
  readonly completionReturn: AgentControlCompletionReturn | undefined;
}): ThreadParentLink | null {
  if (!isDelegatedThreadLineage(input.lineage)) return null;
  const result =
    input.completionReturn === undefined
      ? null
      : completionReturnPresentation(input.completionReturn.status);
  return {
    threadId: input.lineage.parentThreadId,
    title: input.parentTitle?.trim() || "Parent chat",
    resultLabel: result?.label ?? null,
    resultTone: result?.tone ?? null,
  };
}
