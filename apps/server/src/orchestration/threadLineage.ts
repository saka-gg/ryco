/**
 * Server-owned thread lineage helpers (spec 12, delegation-lineage).
 *
 * Lineage is provenance only: it records which thread a thread was created from
 * (delegated on behalf of, or forked from). It grants nothing and must never be
 * read by Agent Control policy, validation, approvals or return delivery.
 *
 * Pure functions, no Effect services.
 */
import type {
  MessageId,
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
  ThreadLineage,
  TurnId,
} from "@ryco/contracts";
import { FORKED_THREAD_RELATIONSHIP } from "@ryco/shared/threadFork";

import type { ProjectionThread } from "../persistence/Services/ProjectionThreads.ts";
import { findThreadById } from "./commandInvariants.ts";

/** One definition, shared with clients (`threadHasConversation`, lineage display). */
export { FORKED_THREAD_RELATIONSHIP };

export const DELEGATED_THREAD_RELATIONSHIP = "delegated" as const;
export const MAX_THREAD_LINEAGE_DEPTH = 64;

type ProjectionLineageColumns = Pick<
  ProjectionThread,
  | "lineageParentThreadId"
  | "lineageRootThreadId"
  | "lineageRelationship"
  | "lineageSourceMessageId"
  | "lineageSourceTurnId"
>;

/** Reads lineage from projection columns. Partial rows are treated as no lineage. */
export function projectionThreadLineage(row: ProjectionLineageColumns): ThreadLineage | null {
  if (
    row.lineageParentThreadId === null ||
    row.lineageRootThreadId === null ||
    row.lineageRelationship === null ||
    row.lineageRelationship.trim().length === 0
  ) {
    return null;
  }
  return {
    parentThreadId: row.lineageParentThreadId,
    rootThreadId: row.lineageRootThreadId,
    relationship: row.lineageRelationship,
    ...(row.lineageSourceMessageId !== null ? { sourceMessageId: row.lineageSourceMessageId } : {}),
    ...(row.lineageSourceTurnId !== null ? { sourceTurnId: row.lineageSourceTurnId } : {}),
  };
}

/** Projection columns for a lineage, or nulls for root threads. */
export function projectionLineageColumns(
  lineage: ThreadLineage | null | undefined,
): ProjectionLineageColumns {
  if (lineage === null || lineage === undefined) {
    return {
      lineageParentThreadId: null,
      lineageRootThreadId: null,
      lineageRelationship: null,
      lineageSourceMessageId: null,
      lineageSourceTurnId: null,
    };
  }
  return {
    lineageParentThreadId: lineage.parentThreadId,
    lineageRootThreadId: lineage.rootThreadId,
    lineageRelationship: lineage.relationship,
    lineageSourceMessageId: lineage.sourceMessageId ?? null,
    lineageSourceTurnId: lineage.sourceTurnId ?? null,
  };
}

/**
 * Adds `lineage` only when present. Every thread/shell builder uses this so the
 * "root threads have no lineage key" rule lives in one place.
 */
export function withThreadLineage<T extends object>(
  target: T,
  lineage: ThreadLineage | null | undefined,
): T & { lineage?: ThreadLineage } {
  if (lineage === null || lineage === undefined) {
    return target;
  }
  return { ...target, lineage };
}

/** How a new thread relates to the thread it is created from. */
export type ChildThreadLink =
  | { readonly relationship: typeof DELEGATED_THREAD_RELATIONSHIP }
  | {
      readonly relationship: typeof FORKED_THREAD_RELATIONSHIP;
      /** The parent's message the fork's inherited history ends at (inclusive). */
      readonly sourceMessageId: MessageId;
      /** The parent's completed turn that message ends. */
      readonly sourceTurnId: TurnId;
    };

export type ResolveChildThreadLineageResult =
  | { readonly ok: true; readonly lineage: ThreadLineage }
  | { readonly ok: false; readonly detail: string };

const LINK_WORDING = {
  [DELEGATED_THREAD_RELATIONSHIP]: { verb: "delegated", action: "delegation" },
  [FORKED_THREAD_RELATIONSHIP]: { verb: "forked", action: "forking" },
} as const;

/**
 * The root a new child of `parent` records.
 *
 * - Delegated: the root of the parent's delegation tree. A delegation tree starts at the nearest
 *   thread that was not itself delegated, so a fork (or any non-delegated thread) is the root of
 *   everything delegated from it. Clients nest delegated threads under that root; inheriting a
 *   fork's own root would fold the child under the thread the fork was copied from, which never
 *   delegated anything.
 * - Forked: the parent's root, or the parent when it has none (provenance of the whole chain).
 */
function childRootThreadId(parent: OrchestrationThread, link: ChildThreadLink): ThreadId {
  if (link.relationship === DELEGATED_THREAD_RELATIONSHIP) {
    return parent.lineage?.relationship === DELEGATED_THREAD_RELATIONSHIP
      ? parent.lineage.rootThreadId
      : parent.id;
  }
  return parent.lineage?.rootThreadId ?? parent.id;
}

/**
 * Computes the lineage of a new thread created from `parent` (delegated or forked).
 *
 * Walks the parent's full ancestor chain (deleted rows included, the read model
 * keeps them) so that a re-created soft-deleted id can never become its own
 * ancestor at any depth, and caps the depth.
 */
export function resolveChildThreadLineage(input: {
  readonly readModel: OrchestrationReadModel;
  readonly parent: OrchestrationThread;
  readonly childThreadId: ThreadId;
  readonly link: ChildThreadLink;
}): ResolveChildThreadLineageResult {
  const { readModel, parent, childThreadId, link } = input;
  const wording = LINK_WORDING[link.relationship];
  if (parent.id === childThreadId) {
    return {
      ok: false,
      detail: `Thread '${childThreadId}' cannot be ${wording.verb} from itself.`,
    };
  }
  const rootThreadId = childRootThreadId(parent, link);
  let cursor: OrchestrationThread | undefined = parent;
  let depth = 0;
  while (cursor !== undefined) {
    depth += 1;
    if (depth > MAX_THREAD_LINEAGE_DEPTH) {
      return {
        ok: false,
        detail: `Thread lineage for '${childThreadId}' would exceed the maximum depth of ${MAX_THREAD_LINEAGE_DEPTH}.`,
      };
    }
    const lineage: ThreadLineage | null | undefined = cursor.lineage;
    if (lineage === null || lineage === undefined) {
      break;
    }
    if (lineage.parentThreadId === childThreadId || lineage.rootThreadId === childThreadId) {
      return {
        ok: false,
        detail: `Thread '${childThreadId}' is already an ancestor of parent thread '${parent.id}'; ${wording.action} would create a cycle.`,
      };
    }
    cursor = findThreadById(readModel, lineage.parentThreadId);
  }
  return {
    ok: true,
    lineage:
      link.relationship === FORKED_THREAD_RELATIONSHIP
        ? {
            parentThreadId: parent.id,
            rootThreadId,
            relationship: link.relationship,
            sourceMessageId: link.sourceMessageId,
            sourceTurnId: link.sourceTurnId,
          }
        : { parentThreadId: parent.id, rootThreadId, relationship: link.relationship },
  };
}
