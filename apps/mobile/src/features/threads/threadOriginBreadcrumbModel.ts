import {
  completionReturnPresentation,
  type AgentControlStatusTone,
} from "@ryco/client-runtime/state/agentControl";
import {
  DELEGATED_THREAD_RELATIONSHIP,
  FORKED_THREAD_RELATIONSHIP,
  type ThreadAvailability,
} from "@ryco/client-runtime/state/threads";
import type { ThreadId } from "@ryco/contracts";
import type { AgentControlCompletionReturn } from "@ryco/contracts/agent-control";
import type { ThreadLineage } from "@ryco/contracts/orchestration";

// The way back from a child thread to the thread it came from, at the top of the thread screen:
// web's delegation dock origin line ("Delegated from …", with the child's own result return), as
// one compact link. Forks name their source the same way; their timeline divider keeps the detail.

export interface ThreadOriginResult {
  readonly text: string;
  readonly tone: AgentControlStatusTone;
}

export interface ThreadOriginBreadcrumbModel {
  readonly kind: "delegated" | "forked";
  /** "From" or "Forked from", before the parent's title. */
  readonly lead: string;
  readonly parentTitle: string;
  /** The parent to open; null unless it is on this node. */
  readonly parentThreadId: ThreadId | null;
  /** Where this child's result to its parent stands; null without a result return. */
  readonly result: ThreadOriginResult | null;
  readonly accessibilityLabel: string;
}

/** A parent this device has no title for (a deleted one, or one not synced yet). */
const UNKNOWN_PARENT_TITLE = "another chat";

/**
 * The child's own result return, said from the child's side: it returns when it is done, it
 * returned, or how the return went wrong (the shared presentation's words).
 */
export function threadOriginResult(
  completionReturn: AgentControlCompletionReturn | null,
): ThreadOriginResult | null {
  if (completionReturn === null) return null;
  const presentation = completionReturnPresentation(completionReturn.status);
  switch (completionReturn.status) {
    case "waiting":
      return { text: "Returns when done", tone: presentation.tone };
    case "delivered":
      return { text: "Result returned", tone: presentation.tone };
    default:
      return { text: presentation.label, tone: presentation.tone };
  }
}

/** Null for a thread nothing delegated or forked (a root, or a relationship this app does not know). */
export function buildThreadOriginBreadcrumbModel(input: {
  readonly lineage: ThreadLineage | null | undefined;
  /** The parent's title as this device knows it. */
  readonly parentTitle: string | null | undefined;
  /** Whether the parent is on the node (`selectThreadAvailabilityByRef`). */
  readonly parentAvailability: ThreadAvailability;
  /** This child's result return to its parent (`findCompletionReturnForChild`). */
  readonly ownReturn: AgentControlCompletionReturn | null;
}): ThreadOriginBreadcrumbModel | null {
  const { lineage } = input;
  if (lineage === null || lineage === undefined) return null;
  const kind =
    lineage.relationship === DELEGATED_THREAD_RELATIONSHIP
      ? "delegated"
      : lineage.relationship === FORKED_THREAD_RELATIONSHIP
        ? "forked"
        : null;
  if (kind === null) return null;
  const title = input.parentTitle?.trim();
  const parentTitle = title ? title : UNKNOWN_PARENT_TITLE;
  // A fork's source gets no result from it.
  const result = kind === "delegated" ? threadOriginResult(input.ownReturn) : null;
  const opens = input.parentAvailability === "available";
  const spokenLead = kind === "delegated" ? "Delegated from" : "Forked from";
  return {
    kind,
    lead: kind === "delegated" ? "From" : "Forked from",
    parentTitle,
    parentThreadId: opens ? lineage.parentThreadId : null,
    result,
    accessibilityLabel: [`${spokenLead} ${parentTitle}`, result?.text]
      .filter((part): part is string => part !== undefined)
      .join(". "),
  };
}
