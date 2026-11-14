/**
 * Reads a whole HTTP request body up to a byte bound, for the small loopback MCP listeners
 * (Agent Control, external Agent Control, the provider device tool gateway). A leaf module: the
 * boot-loaded listeners and the lazily loaded external listener share it without pulling either
 * into the other's chunks.
 *
 * @module readBoundedBody
 */
import type { Readable } from "node:stream";

/**
 * Resolves the body as UTF-8, or `null` as soon as it grows past `maxBytes` (a body of exactly
 * `maxBytes` is accepted). Past the bound the rest of the body is drained and dropped, so the
 * caller can still answer (413, a JSON-RPC error) on the same request. Rejects with the stream's
 * error, which includes a client that aborts mid-body.
 */
export const readBoundedBody = (request: Readable, maxBytes: number): Promise<string | null> =>
  new Promise((resolve, reject) => {
    const chunks: Array<Buffer> = [];
    let total = 0;
    request.on("data", (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        request.removeAllListeners("data");
        request.removeAllListeners("end");
        resolve(null);
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", (error) => reject(error));
  });
