/**
 * Process-scoped command ids: ids that embed a UUID minted for one emission, so only the process
 * that minted it can ever dispatch them, and only right after minting (a retry within seconds).
 *
 * - `provider:<uuid>:…` - commands derived from one provider runtime event. Adapters mint every
 *   runtime event id with `crypto.randomUUID()` and runtime events are never replayed after a
 *   restart.
 * - `history:<uuid>` - one history-recovery command.
 *
 * Nothing outside the engine looks their receipts up: client outbox replays, restart
 * continuations, delegation returns and local task starts all use their own deterministic ids.
 * So the engine keeps their outcomes in memory ({@link makeProcessScopedReceipts}) instead of
 * writing a receipt row per streamed event that retention deletes later.
 *
 * @module processScopedCommandIds
 */
import type { CommandId } from "@ryco/contracts";

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const PROCESS_SCOPED_COMMAND_ID = new RegExp(`^(?:provider:${UUID}:|history:${UUID}$)`, "i");

/** Whether only this process, right after minting it, can dispatch `commandId`. */
export const isProcessScopedCommandId = (commandId: string): boolean =>
  PROCESS_SCOPED_COMMAND_ID.test(commandId);

export type ProcessScopedReceipt =
  | { readonly status: "accepted"; readonly resultSequence: number }
  | { readonly status: "rejected"; readonly error: string | null };

export interface ProcessScopedReceipts {
  readonly get: (commandId: CommandId) => ProcessScopedReceipt | undefined;
  /** Call once the outcome is final: after the commit, or after the rejection. */
  readonly record: (commandId: CommandId, receipt: ProcessScopedReceipt) => void;
}

/**
 * Re-dispatches of a process-scoped id arrive within seconds, so the most recent outcomes are
 * enough; the bound only keeps memory flat over a long-running server.
 */
export const PROCESS_SCOPED_RECEIPT_CAPACITY = 20_000;

export const makeProcessScopedReceipts = (
  capacity: number = PROCESS_SCOPED_RECEIPT_CAPACITY,
): ProcessScopedReceipts => {
  const receipts = new Map<CommandId, ProcessScopedReceipt>();
  return {
    get: (commandId) => receipts.get(commandId),
    record: (commandId, receipt) => {
      receipts.delete(commandId);
      receipts.set(commandId, receipt);
      if (receipts.size > capacity) {
        const oldest = receipts.keys().next();
        if (!oldest.done) receipts.delete(oldest.value);
      }
    },
  };
};
