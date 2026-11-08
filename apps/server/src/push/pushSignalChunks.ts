/**
 * pushSignalChunks - Splits one pass's entries over as many Hub signals as the
 * 32-entry limit asks for; shared by the attention and Live Activity signals.
 *
 * @module push/pushSignalChunks
 */
import { PUSH_ATTENTION_MAX_DELIVERIES } from "@ryco/contracts/push-hub";

export function chunkForSignals<T>(entries: ReadonlyArray<T>): ReadonlyArray<ReadonlyArray<T>> {
  const chunks: T[][] = [];
  for (let index = 0; index < entries.length; index += PUSH_ATTENTION_MAX_DELIVERIES) {
    chunks.push(entries.slice(index, index + PUSH_ATTENTION_MAX_DELIVERIES));
  }
  return chunks;
}
