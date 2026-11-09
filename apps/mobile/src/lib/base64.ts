export function estimateBase64ByteSize(base64: string): number {
  const padding = base64.endsWith("==") ? 2 : base64.endsWith("=") ? 1 : 0;
  return Math.floor((base64.length * 3) / 4) - padding;
}

const BASE64_CHUNK_BYTES = 0x8000;

/** Standard base64 of `bytes`, in chunks so a large file does not overflow the call stack. */
export function encodeBytesBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += BASE64_CHUNK_BYTES) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + BASE64_CHUNK_BYTES));
  }
  return btoa(binary);
}
