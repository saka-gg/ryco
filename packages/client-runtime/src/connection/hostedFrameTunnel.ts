import { RelayFrameTunnelClient } from "../relay/relayFrameTunnel.ts";
import type { HostedFrameTunnelChannel } from "../relay/transport.ts";

/**
 * A placeholder a hosted frame source resolves instead of a socket URL; the
 * tunnel's sockets are opened by name, never by address.
 */
export const HOSTED_FRAME_TUNNEL_URL = "ryco-relay-tunnel://node/";

/** One tunnel per relay channel, bound on its first stream, whatever it streams. */
const tunnels = new WeakMap<object, RelayFrameTunnelClient>();

/**
 * The frame tunnel of `channel`, shared by the device and node browser frame
 * sources of one connection. Null where the channel will not bind: already
 * bound by a tunnel this module no longer holds, or not `e2ee`.
 */
export function hostedFrameTunnelFor(
  channel: HostedFrameTunnelChannel,
): RelayFrameTunnelClient | null {
  const existing = tunnels.get(channel.socket);
  if (existing && !existing.closed) return existing;
  let send: ((bytes: Uint8Array) => boolean) | null = null;
  const client = new RelayFrameTunnelClient({
    send: (bytes) => send?.(bytes) ?? false,
    queueMicrotask: (callback) => void Promise.resolve().then(callback),
  });
  send = channel.bind(client);
  if (send === null) return null;
  tunnels.set(channel.socket, client);
  return client;
}
