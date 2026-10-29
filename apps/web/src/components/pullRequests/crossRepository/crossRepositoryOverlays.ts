import type { SourceControlChangeRequestDetail } from "@ryco/contracts";

import {
  CROSS_REPOSITORY_OVERLAY_TTL_MS,
  crossRepositoryOverlayFromDetail,
  type CrossRepositoryOverlay,
} from "./crossRepositoryList.logic";

/**
 * Fresh details of rows opened from All repositories (every mutation writes the reader's
 * detail), kept for one server cache lifetime so a merged, closed or reviewed row leaves
 * or moves at once, whatever a node's cached answer still says. Memory only.
 */

export interface CrossRepositoryOverlaySnapshot {
  readonly overlays: ReadonlyArray<CrossRepositoryOverlay>;
  /** When the overlays last changed; every overlay in the snapshot is fresh then. */
  readonly nowMs: number;
}

const overlays = new Map<string, CrossRepositoryOverlay>();
const listeners = new Set<() => void>();
let snapshot: CrossRepositoryOverlaySnapshot = { overlays: [], nowMs: 0 };
let pruneTimer: ReturnType<typeof setTimeout> | null = null;

function sameOverlay(left: CrossRepositoryOverlay, right: CrossRepositoryOverlay): boolean {
  if (left.updatedAtMs !== right.updatedAtMs) return false;
  const fields = Object.keys(right.fields) as Array<keyof CrossRepositoryOverlay["fields"]>;
  return (
    fields.length === Object.keys(left.fields).length &&
    fields.every((field) => field === "updatedAt" || left.fields[field] === right.fields[field])
  );
}

function publish(nowMs: number): void {
  for (const [rowKey, overlay] of overlays) {
    if (nowMs - overlay.recordedAtMs >= CROSS_REPOSITORY_OVERLAY_TTL_MS) overlays.delete(rowKey);
  }
  snapshot = { overlays: [...overlays.values()], nowMs };
  if (pruneTimer !== null) clearTimeout(pruneTimer);
  pruneTimer = null;
  const oldest = Math.min(...snapshot.overlays.map((overlay) => overlay.recordedAtMs));
  if (Number.isFinite(oldest)) {
    pruneTimer = setTimeout(
      () => publish(Date.now()),
      Math.max(1, oldest + CROSS_REPOSITORY_OVERLAY_TTL_MS - nowMs),
    );
  }
  for (const listener of listeners) listener();
}

/** Records what a fresh detail says about its row (a repeat of the same values is ignored). */
export function recordCrossRepositoryDetail(detail: SourceControlChangeRequestDetail): void {
  const nowMs = Date.now();
  const overlay = crossRepositoryOverlayFromDetail(detail, nowMs);
  if (overlay === null) return;
  const existing = overlays.get(overlay.rowKey);
  if (existing !== undefined && sameOverlay(existing, overlay)) return;
  overlays.set(overlay.rowKey, overlay);
  publish(nowMs);
}

export function subscribeCrossRepositoryOverlays(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getCrossRepositoryOverlays(): CrossRepositoryOverlaySnapshot {
  return snapshot;
}

export function resetCrossRepositoryOverlaysForTests(): void {
  overlays.clear();
  if (pruneTimer !== null) clearTimeout(pruneTimer);
  pruneTimer = null;
  snapshot = { overlays: [], nowMs: 0 };
}
