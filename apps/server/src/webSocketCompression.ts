/**
 * webSocketCompression - permessage-deflate policy for the public WebSocket
 * server.
 *
 * Shell snapshots, thread windows and the provider-heavy server config
 * compress about 8x, which matters on LAN, Tailscale, SSH and cellular links.
 * Level 1 with no context takeover keeps the CPU and per-connection memory
 * small, and messages under the threshold are sent as is. The desktop's own
 * renderer talks over loopback, where compression is pure CPU, so desktop
 * backends drop the extension offer from direct loopback peers (a local proxy
 * relaying a remote client keeps it). Other servers keep it for loopback too:
 * SSH port forwards arrive from there without forwarding headers.
 *
 * @module webSocketCompression
 */
import type * as Http from "node:http";
import { isIP } from "node:net";

export const WEBSOCKET_PER_MESSAGE_DEFLATE = {
  threshold: 16 * 1024,
  zlibDeflateOptions: { level: 1 },
  serverNoContextTakeover: true,
  clientNoContextTakeover: true,
} as const;

/**
 * Whether a peer address is anywhere in the loopback range (all of 127/8, or
 * `::1`, IPv4-mapped forms included). A compression heuristic only: access
 * decisions use the exact-match loopback checks of their own modules.
 */
export function isLoopbackRangeAddress(address: string | undefined): boolean {
  if (address === undefined) return false;
  const normalized = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (normalized === "::1") return true;
  return isIP(normalized) === 4 && normalized.startsWith("127.");
}

/**
 * Whether an upgrade comes straight from a local process rather than through a
 * local reverse proxy (Tailscale Serve, say) that relays a remote client and
 * marks it with forwarding headers. Spoofing a header only buys compression.
 */
export function isDirectLoopbackUpgrade(request: Http.IncomingMessage): boolean {
  return (
    isLoopbackRangeAddress(request.socket.remoteAddress) &&
    request.headers["x-forwarded-for"] === undefined &&
    request.headers.forwarded === undefined
  );
}

/**
 * Drops the `permessage-deflate` offer of direct loopback peers before the
 * WebSocket server negotiates, so those connections run uncompressed. Remote
 * clients relayed by a local proxy keep it. Register before any other
 * `upgrade` listener.
 */
export function skipWebSocketCompressionForLoopbackPeers(server: Http.Server): void {
  server.on("upgrade", (request: Http.IncomingMessage) => {
    if (isDirectLoopbackUpgrade(request)) {
      delete request.headers["sec-websocket-extensions"];
    }
  });
}
