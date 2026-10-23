import { normalizeWorkspaceRelativePath } from "@ryco/client-runtime/state/files";
import { EnvironmentId } from "@ryco/contracts";

import { randomUUID } from "./lib/utils";

/** A workspace file dragged out of the Files panel tree; the composer takes it as a mention. */
export const WORKSPACE_FILE_DRAG_TYPE = "application/x-ryco-workspace-file";

export interface WorkspaceFileDragPayload {
  readonly environmentId: EnvironmentId;
  /** The directory `path` is relative to (the thread's worktree or project). */
  readonly workspaceRoot: string;
  /** Workspace-relative, `a/b/c` form. */
  readonly path: string;
}

/** The payload a drag carried, or null when it is not (or no longer) one. */
export function decodeWorkspaceFileDragPayload(value: unknown): WorkspaceFileDragPayload | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.environmentId !== "string" ||
    record.environmentId.length === 0 ||
    typeof record.workspaceRoot !== "string" ||
    record.workspaceRoot.length === 0 ||
    typeof record.path !== "string"
  ) {
    return null;
  }
  const path = normalizeWorkspaceRelativePath(record.path);
  return path === null
    ? null
    : {
        environmentId: EnvironmentId.make(record.environmentId),
        workspaceRoot: record.workspaceRoot,
        path,
      };
}

// Browsers hide drag data until the drop, so a drop target's preview could not
// tell which file is coming. In-app drags record what they carry, under an id
// the drag itself also carries as a type (types stay readable mid-drag).
let draggedWorkspaceFile: {
  readonly payload: WorkspaceFileDragPayload;
  readonly idType: string;
} | null = null;

const WORKSPACE_FILE_DRAG_ID_TYPE_PREFIX = "application/x-ryco-workspace-file-drag-";

/**
 * Starts a file drag. Plain text carries the path too, so a drop on an
 * ordinary text field (or another app) still lands something useful.
 */
export function startWorkspaceFileDrag(
  transfer: DataTransfer,
  payload: WorkspaceFileDragPayload,
): void {
  const idType = `${WORKSPACE_FILE_DRAG_ID_TYPE_PREFIX}${randomUUID()}`;
  transfer.setData(WORKSPACE_FILE_DRAG_TYPE, JSON.stringify(payload));
  transfer.setData("text/plain", payload.path);
  transfer.setData(idType, "1");
  transfer.effectAllowed = "copy";
  draggedWorkspaceFile = { payload, idType };
}

export function endWorkspaceFileDrag(): void {
  draggedWorkspaceFile = null;
}

/**
 * The in-app file `transfer` is dragging; null for drags from another window.
 * `dragend` can be lost (its row unmounted mid-drag), so the record counts
 * only for the drag that carries its id.
 */
export function readWorkspaceFileDragSource(
  transfer: Pick<DataTransfer, "types">,
): WorkspaceFileDragPayload | null {
  const current = draggedWorkspaceFile;
  return current && transfer.types.includes(current.idType) ? current.payload : null;
}

export function isWorkspaceFileDrag(transfer: Pick<DataTransfer, "types">): boolean {
  return transfer.types.includes(WORKSPACE_FILE_DRAG_TYPE);
}

/** The dropped file; null for any other drag or a malformed payload. */
export function readWorkspaceFileDrop(
  transfer: Pick<DataTransfer, "getData" | "types">,
): WorkspaceFileDragPayload | null {
  if (!isWorkspaceFileDrag(transfer)) return null;
  try {
    return decodeWorkspaceFileDragPayload(JSON.parse(transfer.getData(WORKSPACE_FILE_DRAG_TYPE)));
  } catch {
    return null;
  }
}

export type WorkspaceFileDropVerdict =
  | { readonly kind: "mention" }
  | { readonly kind: "refused"; readonly reason: "environment" | "workspace" | "unavailable" };

/**
 * What dropping `source` on a composer working in `workspaceRoot` would do: a
 * path only means something inside the workspace it is relative to.
 */
export function resolveWorkspaceFileDrop(input: {
  readonly source: WorkspaceFileDragPayload | null;
  readonly environmentId: EnvironmentId;
  readonly workspaceRoot: string | null;
  readonly disabled: boolean;
}): WorkspaceFileDropVerdict {
  if (input.disabled || input.workspaceRoot === null) {
    return { kind: "refused", reason: "unavailable" };
  }
  // Drags from another window carry an unknown file; the drop decides.
  if (!input.source) return { kind: "mention" };
  if (input.source.environmentId !== input.environmentId) {
    return { kind: "refused", reason: "environment" };
  }
  if (input.source.workspaceRoot !== input.workspaceRoot) {
    return { kind: "refused", reason: "workspace" };
  }
  return { kind: "mention" };
}

export function workspaceFileDropLabel(verdict: WorkspaceFileDropVerdict): string {
  if (verdict.kind === "mention") return "Mention file";
  switch (verdict.reason) {
    case "environment":
      return "Only files from the same machine can be mentioned";
    case "workspace":
      return "This file is in another workspace";
    case "unavailable":
      return "The composer can’t take a mention right now";
  }
}
