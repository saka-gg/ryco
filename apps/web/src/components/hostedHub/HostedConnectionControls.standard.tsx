/**
 * Standard-build stand-in for `./HostedConnectionControls` (wired by
 * `src/clientModeSeams.ts`). Every hosted connection control renders nothing
 * outside a hosted session, and a standard build never has one, so the
 * controls are null components here and the relay, E2EE, and mobile sheet
 * code behind them stays out of the standard bundle. Props and hook results are
 * pinned to the real module below.
 */
type Hosted = typeof import("./HostedConnectionControls");
type RendersNothing<Component extends (...args: never[]) => unknown> = (
  ...args: Parameters<Component>
) => null;

const renderNothing = () => null;

export const NodePresence: RendersNothing<Hosted["NodePresence"]> = renderNothing;
export const HostedThreadConnectionBadge: RendersNothing<Hosted["HostedThreadConnectionBadge"]> =
  renderNothing;
export const HostedConnectionSheet: RendersNothing<Hosted["HostedConnectionSheet"]> = renderNothing;
export const HostedConnectionPill: RendersNothing<Hosted["HostedConnectionPill"]> = renderNothing;
export const HostedConnectionControl: RendersNothing<Hosted["HostedConnectionControl"]> =
  renderNothing;

const settled = (): Promise<void> => Promise.resolve();

export const useHostedConnectionActions: Hosted["useHostedConnectionActions"] = () => ({
  switchNode: settled,
  switchNodeInPlace: settled,
  returnToAllNodes: settled,
});
