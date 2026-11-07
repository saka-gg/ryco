import type { DeviceUdid } from "@ryco/contracts";

import type { HostedFrameTunnelChannel } from "../relay/transport.ts";
import type { DeviceFrameSource, DeviceFrameSourceHandlers } from "./deviceFrameSource.ts";

export interface HostedDeviceFrameSourceOptions {
  /** The current attempt's relay channel (`HostedRelayAttemptFactory.currentFrameTunnelChannel`). */
  readonly channel: () => HostedFrameTunnelChannel | null;
  /**
   * Whether this connection's session may stream now: its generation is the
   * environment's current one and it accepted a current snapshot
   * (`hostedEnvironmentResumeReadiness`).
   */
  readonly readiness: {
    readonly read: () => boolean;
    readonly subscribe: (listener: () => void) => () => void;
  };
}

/**
 * `openFrameSource` for a hosted connection. The tunnel and its codec load
 * with the first viewer, so the boot path carries only this.
 */
export function hostedDeviceFrameSources(options: HostedDeviceFrameSourceOptions) {
  return (udid: DeviceUdid, handlers: DeviceFrameSourceHandlers): DeviceFrameSource => {
    let source: DeviceFrameSource | null = null;
    let closed = false;
    let resyncWanted = false;
    void import("./hostedDeviceFrameTunnel.ts").then(
      ({ openHostedDeviceFrameSource }) => {
        if (closed) return;
        source = openHostedDeviceFrameSource(udid, handlers, options);
        if (resyncWanted) source.requestResync();
      },
      () => {
        if (!closed) handlers.onReset("error", { generation: 0, retryInMs: null });
      },
    );
    return {
      requestResync: () => {
        if (source) return source.requestResync();
        resyncWanted = true;
        return false;
      },
      sendText: (text) => source?.sendText(text) ?? false,
      close: () => {
        closed = true;
        source?.close();
      },
    };
  };
}
