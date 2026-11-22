/**
 * Handed-off desktop tabs as node-browser tabs: while an agent's hand-off of a Ryco browser tab is
 * pending (a user action request with `remoteView`), its owner can view and drive that one tab
 * from the phone or another browser through the node browser's own paths (the frame socket, the
 * relay frame tunnel, `nodeBrowser.read` stills and `nodeBrowser.input`), under the tab id
 * `handoff-<32 hex>` (`userActionRemoteViewTabId`).
 *
 * Those paths route such an id here, in front of the headless-Chrome runtime, and only for the
 * owner role. The source itself (frames and input from the desktop's hand-off bridge, gated by the
 * request on the node and by the desktop's own pending hand-off) registers when the desktop bridge
 * is configured and loads on first use. Tiny and on the boot path on purpose, like
 * `userActionRequests/surfaceHooks.ts`.
 *
 * @module nodeBrowser/handoffTabs
 */
import type {
  NodeBrowserCommandResult,
  NodeBrowserInputRequest,
  NodeBrowserRpcError,
  NodeBrowserStill,
} from "@ryco/contracts/node-browser";
import type { Effect, Scope } from "effect";

import type { ViewerSocket } from "./nodeBrowserViewerSocket.ts";

/**
 * Whether a node-browser tab id stands for a handed-off desktop tab (the pattern of
 * `userActionRemoteViewTabId`, repeated here so the boot path does not load the copy module).
 */
export const isHandoffTabId = (tabId: string): boolean => /^handoff-[0-9a-f]{32}$/u.test(tabId);

export interface HandoffTabSource {
  /** One frame of the tab, as the phone's viewer polls it. */
  readonly still: (request: {
    readonly tabId: string;
    readonly maxWidth: number;
    readonly maxHeight: number;
    readonly quality: number;
  }) => Effect.Effect<NodeBrowserStill, NodeBrowserRpcError>;
  readonly input: (request: NodeBrowserInputRequest) => Effect.Effect<void, NodeBrowserRpcError>;
  /**
   * A viewer's command on the tab: `resize` answers the tab as it is (a remote viewer never
   * resizes the user's desktop tab); navigation, history, reload and close stay on the desktop.
   */
  readonly command: (
    tabId: string,
    type: string,
  ) => Effect.Effect<NodeBrowserCommandResult, NodeBrowserRpcError>;
  /** Streams the tab to one viewer socket (direct or tunnelled) until it leaves or the hand-off ends. */
  readonly serveViewer: (
    socket: ViewerSocket,
    params: URLSearchParams,
  ) => Effect.Effect<void, never, Scope.Scope>;
}

/** Loads the source (on first use, then the same one). */
export type HandoffTabSourceLoad = Effect.Effect<HandoffTabSource>;

let source: HandoffTabSourceLoad | undefined;

/** Sets the source (the desktop bridge's); returns its removal. */
export function registerHandoffTabSource(next: HandoffTabSourceLoad): () => void {
  source = next;
  return () => {
    if (source === next) source = undefined;
  };
}

export function handoffTabSource(): HandoffTabSourceLoad | undefined {
  return source;
}
