/**
 * Raw DEFLATE for tests, through the platform `CompressionStream` (Node built-ins
 * are off limits in this package, tests included). Produces what the node's
 * `node:zlib` produces: a raw RFC 1951 stream.
 */
export async function deflateRaw(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as Uint8Array<ArrayBuffer>])
    .stream()
    .pipeThrough(new CompressionStream("deflate-raw"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}
