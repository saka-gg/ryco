import type { ThreadId, TurnId } from "@ryco/contracts";

import type { ProviderThreadSnapshot } from "./Services/ProviderAdapter.ts";

/**
 * The thread snapshot of an adapter that keeps no transcript in memory: its turn ids, each with no
 * items. Nothing in production reads adapter snapshots (the orchestration projection and
 * the provider's own store hold the transcript), so adapters must never retain message bodies,
 * tool input or output, prompts or stream deltas to fill `items`. Returns a fresh array, never the
 * adapter's live one.
 */
export function providerThreadSnapshotFromTurnIds(
  threadId: ThreadId,
  turnIds: ReadonlyArray<TurnId>,
): ProviderThreadSnapshot {
  return { threadId, turns: turnIds.map((id) => ({ id, items: [] })) };
}
