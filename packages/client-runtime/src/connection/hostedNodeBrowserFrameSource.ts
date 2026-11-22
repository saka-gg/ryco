import type { HostedDeviceFrameSourceOptions } from "./hostedDeviceFrameSource.ts";
import type {
  NodeBrowserFrameRequest,
  NodeBrowserFrameSource,
  NodeBrowserFrameSourceHandlers,
} from "./nodeBrowserFrameSource.ts";

/** The relay channel and session readiness, as for device frames. */
export type HostedNodeBrowserFrameSourceOptions = HostedDeviceFrameSourceOptions;

/**
 * `openHandoffFrameSource` for a hosted connection: frames of a handed-off
 * desktop tab through the relay channel's frame tunnel. Ordinary node tabs
 * never ride it. The tunnel and the frame source load with the first viewer,
 * so the boot path carries only this.
 */
export function hostedNodeBrowserFrameSources(options: HostedNodeBrowserFrameSourceOptions) {
  return (
    request: NodeBrowserFrameRequest,
    handlers: NodeBrowserFrameSourceHandlers,
  ): NodeBrowserFrameSource => {
    let source: NodeBrowserFrameSource | null = null;
    let closed = false;
    void import("./hostedNodeBrowserFrameTunnel.ts").then(
      ({ openHostedNodeBrowserFrameSource }) => {
        if (closed) return;
        source = openHostedNodeBrowserFrameSource(request, handlers, options);
      },
      () => {
        if (!closed) handlers.onStop({ reason: "refused" });
      },
    );
    return {
      close: () => {
        closed = true;
        source?.close();
      },
    };
  };
}
