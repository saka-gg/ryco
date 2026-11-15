/**
 * The app window's renderer document owns the workspace's live machine state
 * in main: the scope leases it retains, the connections main asked it to make
 * (the demand state records them as made), and the relay transports whose
 * opaque handles only it holds. When that document goes away, nothing of it
 * tells main so: a reload (View → Reload), a crashed renderer and its
 * recovery, and a window closed (and later reopened on macOS) all leave main
 * believing the connections still stand. The new document then retains again,
 * the planner sends no connect command for "connected" machines, and other
 * machines stay disconnected; the old transports stay open, forward to a
 * document that drops them and use up the transport limit.
 *
 * This module turns the window's lifecycle into one "renderer gone" signal and
 * resets both owners from it, so the two cannot drift apart:
 *
 * - a main-frame navigation to another document committed (`did-navigate`): the
 *   document that held the state is gone, and the new one has not run yet;
 * - the render process is gone, or the window closed.
 *
 * A navigation that only started is not a signal: one that becomes a download
 * or is cancelled leaves the document where it was, and resetting under a live
 * document would end sockets it still uses. A reset with nothing held changes
 * nothing.
 *
 * @module desktopWorkspaceRendererLifetime
 */

/** The subset of Electron's `BrowserWindow` this wiring needs. */
export interface DesktopWorkspaceRendererWindow {
  on(event: "closed", listener: () => void): unknown;
  readonly webContents: {
    on(event: "did-navigate" | "render-process-gone", listener: () => void): unknown;
  };
}

/** Call `onGone` whenever the window's renderer document is replaced or gone. */
export function watchDesktopWorkspaceRenderer(
  window: DesktopWorkspaceRendererWindow,
  onGone: () => void,
): void {
  // Emitted when a main-frame navigation to another document is done, never for
  // an in-page one (the app's own routing).
  window.webContents.on("did-navigate", () => onGone());
  window.webContents.on("render-process-gone", () => onGone());
  window.on("closed", () => onGone());
}

/** What the reset needs of the workspace client and the relay manager, when they exist. */
export interface DesktopWorkspaceRendererOwners {
  readonly client: { readonly resetRenderer: () => unknown } | null;
  readonly relay: { readonly closeAll: () => void } | null;
}

/**
 * Close the gone document's transports, then drop its leases and connections.
 * Neither owner is created for this: one that does not exist holds nothing.
 */
export function resetDesktopWorkspaceRenderer(owners: DesktopWorkspaceRendererOwners): void {
  try {
    owners.relay?.closeAll();
  } finally {
    owners.client?.resetRenderer();
  }
}
