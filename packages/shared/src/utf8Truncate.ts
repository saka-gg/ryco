/**
 * Byte-bounded UTF-8 text: cut at a byte limit without splitting a character. One rule for the
 * server, desktop and clients.
 *
 * @module utf8Truncate
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8");

/**
 * At most `maxBytes` of UTF-8 from `bytes`, cut before the character that crosses the limit.
 * Never throws: invalid sequences decode to U+FFFD.
 */
export function truncateUtf8Bytes(
  bytes: Uint8Array,
  maxBytes: number,
): { readonly text: string; readonly truncated: boolean } {
  if (bytes.length <= maxBytes) return { text: decoder.decode(bytes), truncated: false };
  let end = Math.max(0, maxBytes);
  // Back up over continuation bytes to the start of the character that crosses the limit.
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  return { text: decoder.decode(bytes.subarray(0, end)), truncated: true };
}

/** `value` cut to at most `maxBytes` of UTF-8, before the character that would not fit. */
export function truncateUtf8(
  value: string,
  maxBytes: number,
): { readonly value: string; readonly truncated: boolean } {
  // Each UTF-16 unit needs at most 3 bytes; shorter strings fit without encoding them.
  if (value.length * 3 <= maxBytes) return { value, truncated: false };
  const bytes = encoder.encode(value);
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  return { value: truncateUtf8Bytes(bytes, maxBytes).text, truncated: true };
}
