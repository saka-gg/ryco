/**
 * Server-owned thread lineage helpers (spec 12, delegation-lineage).
 *
 * Lineage is provenance only: it records which thread a delegated thread was
 * created on behalf of. It grants nothing and must never be read by Agent
 * Control policy, validation, approvals or return delivery.
 *
 * Pure functions, no Effect services.
 */
import type {
  OrchestrationReadModel,
  OrchestrationThread,
  ThreadId,
  ThreadLineage,
} from "@ryco/contracts";

import type { ProjectionThread } from "../persistence/Services/ProjectionThreads.ts";
import { findThreadById } from "./commandInvariants.ts";

export const DELEGATED_THREAD_RELATIONSHIP = "delegated" as const;
export const MAX_THREAD_LINEAGE_DEPTH = 64;

type ProjectionLineageColumns = Pick<
  ProjectionThread,
  "lineageParentThreadId" | "lineageRootThreadId" | "lineageRelationship"
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
    };
  }
  return {
    lineageParentThreadId: lineage.parentThreadId,
    lineageRootThreadId: lineage.rootThreadId,
    lineageRelationship: lineage.relationship,
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

export type ResolveDelegatedChildLineageResult =
  | { readonly ok: true; readonly lineage: ThreadLineage }
  | { readonly ok: false; readonly detail: string };

/**
 * Computes the lineage of a new delegated child of `parent`.
 *
 * Walks the parent's full ancestor chain (deleted rows included, the read model
 * keeps them) so that a re-created soft-deleted id can never become its own
 * ancestor at any depth, and caps the depth.
 */
export function resolveDelegatedChildLineage(input: {
  readonly readModel: OrchestrationReadModel;
  readonly parent: OrchestrationThread;
  readonly childThreadId: ThreadId;
}): ResolveDelegatedChildLineageResult {
  const { readModel, parent, childThreadId } = input;
  if (parent.id === childThreadId) {
    return { ok: false, detail: `Thread '${childThreadId}' cannot be delegated from itself.` };
  }
  const rootThreadId = parent.lineage?.rootThreadId ?? parent.id;
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
        detail: `Thread '${childThreadId}' is already an ancestor of parent thread '${parent.id}'; delegation would create a cycle.`,
      };
    }
    cursor = findThreadById(readModel, lineage.parentThreadId);
  }
  return {
    ok: true,
    lineage: {
      parentThreadId: parent.id,
      rootThreadId,
      relationship: DELEGATED_THREAD_RELATIONSHIP,
    },
  };
}
