/**
 * pushSignalChunks - Splits one pass's entries over as many Hub signals as the
 * 32-entry limit asks for, and alerts with large sealed payloads further so a
 * signal's body stays under the Hub's limit; shared by the attention and Live
 * Activity signals.
 *
 * @module push/pushSignalChunks
 */
import { PUSH_ATTENTION_MAX_DELIVERIES } from "@ryco/contracts/push-hub";

export function chunkForSignals<T>(
  entries: ReadonlyArray<T>,
  perSignal: number = PUSH_ATTENTION_MAX_DELIVERIES,
): ReadonlyArray<ReadonlyArray<T>> {
  const size = Math.max(1, Math.min(PUSH_ATTENTION_MAX_DELIVERIES, Math.floor(perSignal)));
  const chunks: T[][] = [];
  for (let index = 0; index < entries.length; index += size) {
    chunks.push(entries.slice(index, index + size));
  }
  return chunks;
}

/** A signal body stays near this many bytes, under every Hub's 64 KiB body limit. */
export const PUSH_SIGNAL_BODY_TARGET_BYTES = 56_000;
/** A delivery's JSON beside its sealed blob: the enrollment id, the collapse id, the keys. */
const DELIVERY_OVERHEAD_BYTES = 160;

/** How many deliveries of at most `sealedMaxLength` one signal carries. */
export function deliveriesPerSignal(sealedMaxLength: number): number {
  return Math.min(
    PUSH_ATTENTION_MAX_DELIVERIES,
    Math.max(
      1,
      Math.floor(PUSH_SIGNAL_BODY_TARGET_BYTES / (sealedMaxLength + DELIVERY_OVERHEAD_BYTES)),
    ),
  );
}
