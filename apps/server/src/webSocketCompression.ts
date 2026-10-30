/**
 * webSocketCompression - permessage-deflate policy for the public WebSocket
 * server.
 *
 * Shell snapshots, thread windows and the provider-heavy server config
 * compress about 8x, which matters on LAN, Tailscale, SSH and cellular links.
 * Live frames (streamed deltas, activity and shell events, mostly 0.3-2 KiB)
 * compress about 2x on their own, so everything from 512 B is compressed;
 * below that the saving is a few bytes. Level 1 keeps the CPU small.
 *
 * Compressing before encryption makes a message's length depend on how its
 * content repeats itself: the CRIME/BREACH length side channel, against anyone
 * who sees encrypted lengths (on the path of a TLS, Tailscale or SSH link; a
 * plain `ws://` link is readable anyway). Every message is compressed with a
 * fresh context on both sides (no context takeover), so a message's length
 * never depends on earlier messages and no message can probe another. Within
 * one message the channel remains: unlike the relay (docs/relay-e2ee-protocol.md
 * §4.6.6), the direct socket has no allowlist and no padding, so events,
 * deltas, terminal output and thread windows compress at their exact lengths.
 * A guess and a secret must then share one message, next to a known prefix,
 * over hundreds of observed messages; that residual risk is accepted for
 * direct links. A context shared across messages would shrink live frames
 * about twice as much again but would let one message probe another, so it
 * stays off. permessage-deflate runs on libuv's thread pool and holds the
 * socket's later frames until it finishes, which is one more reason the
 * server sizes that pool (bin.ts). The desktop's own
 * renderer talks over loopback, where compression is pure CPU, so desktop
 * backends drop the extension offer from direct loopback peers (a local proxy
 * relaying a remote client keeps it). Other servers keep it for loopback too:
 * SSH port forwards arrive from there without forwarding headers. The device
 * frame socket never negotiates it, in any mode: H.264 is already compressed.
 *
 * @module webSocketCompression
 */
import type * as Http from "node:http";
import { isIP } from "node:net";

import { DEVICE_FRAME_WS_PATH } from "@ryco/shared/deviceFrame";

export const WEBSOCKET_PER_MESSAGE_DEFLATE = {
  threshold: 512,
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

/** Upgrade paths whose payloads are already compressed, so deflate only costs CPU. */
const UNCOMPRESSED_WEBSOCKET_PATHS: ReadonlySet<string> = new Set([DEVICE_FRAME_WS_PATH]);

function upgradePathname(request: Http.IncomingMessage): string | null {
  try {
    return new URL(request.url ?? "/", "http://localhost").pathname;
  } catch {
    return null;
  }
}

/**
 * Whether an upgrade must run uncompressed: the device frame socket always,
 * and direct loopback peers when `skipDirectLoopback` is set.
 */
export function shouldSkipWebSocketCompression(
  request: Http.IncomingMessage,
  options: { readonly skipDirectLoopback: boolean },
): boolean {
  const pathname = upgradePathname(request);
  if (pathname !== null && UNCOMPRESSED_WEBSOCKET_PATHS.has(pathname)) return true;
  return options.skipDirectLoopback && isDirectLoopbackUpgrade(request);
}

/**
 * Drops the `permessage-deflate` offer of upgrades that must run uncompressed
 * (see {@link shouldSkipWebSocketCompression}) before the WebSocket server
 * negotiates. Install on every server, before any other `upgrade` listener.
 */
export function installWebSocketCompressionPolicy(
  server: Http.Server,
  options: { readonly skipDirectLoopback: boolean },
): void {
  server.on("upgrade", (request: Http.IncomingMessage) => {
    if (shouldSkipWebSocketCompression(request, options)) {
      delete request.headers["sec-websocket-extensions"];
    }
  });
}
