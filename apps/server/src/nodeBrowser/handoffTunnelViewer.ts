/**
 * A relay frame tunnel stream as a viewer of a handed-off desktop tab (`handoffTabs.ts`): the
 * tunnel host's `nodeBrowserFrames.serve`. Loaded with the tunnel host (`relayFrameTunnelHost.ts`),
 * never at boot: it needs `effect/socket`'s close events and the frame socket's close codes.
 *
 * @module nodeBrowser/handoffTunnelViewer
 */
import {
  RELAY_FRAME_TUNNEL_CLOSE,
  type RelayFrameTunnelNodeBrowserTarget,
} from "@ryco/shared/relayFrameTunnel";
import { NODE_BROWSER_FRAME_CLOSE } from "@ryco/shared/nodeBrowserFrame";
import { Effect, Fiber } from "effect";
import { Socket } from "effect/socket";

import { handoffTabSource } from "./handoffTabs.ts";
import type { ViewerSocket } from "./nodeBrowserViewerSocket.ts";

/** Serves the target to the tunnelled viewer socket; returns the cancel the host calls once. */
export function serveHandoffTunnelViewer(
  target: RelayFrameTunnelNodeBrowserTarget,
  socket: ViewerSocket,
): () => void {
  const source = handoffTabSource();
  const params = new URLSearchParams({ tab: target.tabId });
  if (target.maxWidth !== undefined) params.set("maxWidth", String(target.maxWidth));
  if (target.maxHeight !== undefined) params.set("maxHeight", String(target.maxHeight));
  if (target.quality !== undefined) params.set("quality", String(target.quality));
  const serve =
    source === undefined
      ? socket.write(
          new Socket.CloseEvent(
            NODE_BROWSER_FRAME_CLOSE.unavailable,
            "Remote view is unavailable on this node.",
          ),
        )
      : Effect.scoped(Effect.flatMap(source, (loaded) => loaded.serveViewer(socket, params))).pipe(
          // A viewer that ends without a close still ends the stream, as the direct socket
          // closes with its handler.
          Effect.ensuring(
            Effect.ignore(socket.write(new Socket.CloseEvent(RELAY_FRAME_TUNNEL_CLOSE.normal, ""))),
          ),
        );
  const fiber = Effect.runFork(Effect.ignore(serve));
  // Forked, never inline: the host calls this from the viewer's own writes.
  return () => void Effect.runFork(Fiber.interrupt(fiber));
}
