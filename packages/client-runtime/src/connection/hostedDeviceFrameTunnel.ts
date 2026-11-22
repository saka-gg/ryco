import type { DeviceUdid } from "@ryco/contracts";
import { RELAY_FRAME_TUNNEL_DEVICE_FRAMES } from "@ryco/shared/relayFrameTunnel";

import type { RelayFrameTunnelSocket } from "../relay/relayFrameTunnel.ts";
import {
  createDeviceFrameSource,
  DeviceFrameSourceUnavailableError,
  type DeviceFrameSource,
  type DeviceFrameSourceHandlers,
} from "./deviceFrameSource.ts";
import type { HostedDeviceFrameSourceOptions } from "./hostedDeviceFrameSource.ts";
import { HOSTED_FRAME_TUNNEL_URL, hostedFrameTunnelFor } from "./hostedFrameTunnel.ts";

/**
 * Device frames over the hosted relay: the direct path's frame source,
 * supervised the same way (generations, backoff, resync), with each socket a
 * stream of the current relay channel's frame tunnel. A socket opens only
 * while the session is ready — a current attempt that accepted a current
 * snapshot — and closes the moment it stops being, so a stale or suspended
 * session neither shows frames nor drives the device.
 */
export function openHostedDeviceFrameSource(
  udid: DeviceUdid,
  handlers: DeviceFrameSourceHandlers,
  options: HostedDeviceFrameSourceOptions,
): DeviceFrameSource {
  let current: RelayFrameTunnelSocket | null = null;
  const source = createDeviceFrameSource({
    udid,
    handlers,
    resolveUrl: async () => {
      if (!options.readiness.read()) throw new Error("The hosted session is not ready.");
      return HOSTED_FRAME_TUNNEL_URL;
    },
    socket: {
      webSocketConstructor: () => {
        const channel = options.readiness.read() ? options.channel() : null;
        if (channel === null) throw new Error("No relay channel is ready.");
        const tunnel = hostedFrameTunnelFor(channel);
        // A ready session's channel is locked: one that will not bind is a
        // `legacy` channel, which never carries the tunnel (it is plaintext to
        // the Hub). The viewer falls back to screenshots for this connection.
        if (tunnel === null) {
          throw new DeviceFrameSourceUnavailableError(
            "This relay channel uses the legacy format, so it cannot carry device video.",
          );
        }
        current = tunnel.openSocket({ target: RELAY_FRAME_TUNNEL_DEVICE_FRAMES, udid });
        return current;
      },
    },
  });
  const unsubscribe = options.readiness.subscribe(() => {
    if (options.readiness.read()) return;
    const socket = current;
    current = null;
    socket?.close();
  });
  return {
    requestResync: source.requestResync,
    sendText: source.sendText,
    close: () => {
      unsubscribe();
      current = null;
      source.close();
    },
  };
}
