import { NODE_BROWSER_WS_METHODS } from "@ryco/contracts/node-browser";
import type { RelayEffectiveRole } from "@ryco/contracts/relay";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";

/**
 * Which browser the Browser panel shows: the desktop app's own tabs
 * (`native`), tabs that run on the node and stream here (`node`), or a
 * sandboxed frame (`iframe`).
 */
export type BrowserMode = "native" | "node" | "iframe";

/** Where the desktop app opens pages for a remote environment: on the node or on this computer. */
export type BrowserSide = "node" | "computer";

export interface BrowserModeInput {
  /** The desktop app's own browser is there. */
  readonly nativeBrowser: boolean;
  /** The environment is the desktop app's own backend, whose localhost is this computer. */
  readonly ownBackend: boolean;
  /** The node advertises `nodeBrowser.available`. */
  readonly nodeBrowserAvailable: boolean;
  /** This client's role on the node, in the Hub's terms. */
  readonly role: RelayEffectiveRole | null;
  /** The connection can open the frame socket: a direct one. Hub relays cannot (yet). */
  readonly frameSocket: boolean;
  readonly side: BrowserSide;
}

/**
 * The panel's browser, and whether to offer the choice between the node and
 * this computer. Node tabs need a node that runs them, a role that may drive
 * them (operators: viewers never see them) and a direct connection. The
 * desktop app keeps its own tabs for its own backend; for a remote one it
 * offers both and starts on the node, where `localhost` is the project's.
 */
export function resolveBrowserMode(input: BrowserModeInput): {
  readonly mode: BrowserMode;
  readonly choice: boolean;
} {
  const nodeTabs =
    input.nodeBrowserAvailable &&
    input.frameSocket &&
    hostedRoleAllows(input.role, NODE_BROWSER_WS_METHODS.input);
  if (input.nativeBrowser && (input.ownBackend || !nodeTabs)) {
    return { mode: "native", choice: false };
  }
  if (input.nativeBrowser) {
    return { mode: input.side === "computer" ? "native" : "node", choice: true };
  }
  return { mode: nodeTabs ? "node" : "iframe", choice: false };
}
