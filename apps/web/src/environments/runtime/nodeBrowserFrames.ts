import type {
  NodeBrowserFrameRequest,
  NodeBrowserFrameSource,
  NodeBrowserFrameSourceHandlers,
} from "@ryco/client-runtime/connection/nodeBrowserFrameSource";
import type { SocketService } from "@ryco/client-runtime/platform";
import { NODE_BROWSER_FRAME_WS_PATH } from "@ryco/shared/nodeBrowserFrame";

/**
 * Node browser frames for a direct connection, which can open the frame socket.
 * The frame source loads with the first viewer, so the boot path carries only
 * this. `socketUrl` gives the frame socket's URL with a fresh socket token.
 */
export function directNodeBrowserFrames(
  socket: SocketService,
  socketUrl: (pathname: typeof NODE_BROWSER_FRAME_WS_PATH) => Promise<string>,
) {
  return (
    request: NodeBrowserFrameRequest,
    handlers: NodeBrowserFrameSourceHandlers,
  ): NodeBrowserFrameSource => {
    let source: NodeBrowserFrameSource | null = null;
    let closed = false;
    void import("@ryco/client-runtime/connection/nodeBrowserFrameSource").then(
      ({ createNodeBrowserFrameSource }) => {
        if (closed) return;
        source = createNodeBrowserFrameSource({
          request,
          handlers,
          socket,
          resolveUrl: () => socketUrl(NODE_BROWSER_FRAME_WS_PATH),
        });
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
