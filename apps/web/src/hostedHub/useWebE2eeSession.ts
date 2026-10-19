import type { EnvironmentId } from "@ryco/contracts";
import { useCallback, useSyncExternalStore } from "react";

import type { WebHostedE2eeChannelStatus } from "./connectionStatus";
import {
  subscribeWebE2eeSession,
  subscribeWebE2eeSessionFor,
  webE2eeSessionState,
  webE2eeSessionStateFor,
} from "./e2eeSession";

/**
 * React binding for this tier's §13 channel projection.
 *
 * `useSyncExternalStore` rather than a store library, for the reason the
 * projection is a plain subscribable module: every decision in it is assertable
 * from a node test without React, and `e2eeSession.test.ts` is where they are
 * asserted.
 */
const channelStatus = (): WebHostedE2eeChannelStatus => webE2eeSessionState().status;

/**
 * What `docs/relay-e2ee-protocol.md` §4.4 locked on the channel behind this
 * session, for the hosted status derivation. It is the displayed environment's
 * channel — the selected node's — and never another node's.
 *
 * EVERY HOSTED STATUS SURFACE TAKES IT, and §12.2 is why: "A client that falls
 * back MUST label the channel **legacy** in every user-facing surface and
 * diagnostic." A surface that reads its state from the transport alone renders a
 * plaintext downgrade and a locked NX channel identically — both `Online`, both
 * with the connected glyph — which is precisely the retained downgrade exposure
 * of the compatibility window going unlabeled.
 *
 * The return type is the tier-fenced union (`connectionStatus.ts`), so the two
 * native rows are not merely unused here but unrepresentable: §2.2's bottom row
 * may never be spelled by a client whose JavaScript the Hub serves.
 *
 * Narrowed to the one field so a change to any other part of the projection —
 * §13.5's code in particular — does not re-render a connection pill.
 */
export function useWebE2eeChannelStatus(): WebHostedE2eeChannelStatus {
  return useSyncExternalStore(subscribeWebE2eeSession, channelStatus, channelStatus);
}

/**
 * {@link useWebE2eeChannelStatus} for one environment's channel, displayed or
 * not, for a surface that describes a specific node rather than the selection.
 */
export function useWebE2eeChannelStatusFor(
  environmentId: EnvironmentId,
): WebHostedE2eeChannelStatus {
  const subscribe = useCallback(
    (listener: () => void) => subscribeWebE2eeSessionFor(environmentId, listener),
    [environmentId],
  );
  const status = useCallback(() => webE2eeSessionStateFor(environmentId).status, [environmentId]);
  return useSyncExternalStore(subscribe, status, status);
}

const verificationCode = (): string | null => webE2eeSessionState().verificationCode;

/**
 * §13.5's rendered code for the displayed environment's current session, or
 * `null`.
 *
 * Narrowed to the one field for the reason {@link useWebE2eeChannelStatus} is:
 * the two change on different events, and a surface drawing the code should not
 * re-render every connection pill on the page.
 *
 * IT IS DISPLAY STATE AND HAS NO OTHER SUPPLIER. §13.5 makes the string
 * "ephemeral display state: never logged, never persisted, never sent to
 * analytics", so it is read from the in-memory projection on every render and
 * there is no accessor that hands it to anything but a component. A caller
 * cannot say what channel the code belongs to from this hook alone — that is
 * {@link useWebE2eeChannelStatus}'s answer, and the surface gates on it, because
 * the §4.4 machine publishes the code from inside its own `e2ee` lock and the
 * projection is still reporting `negotiating` at that instant.
 */
export function useWebE2eeVerificationCode(): string | null {
  return useSyncExternalStore(subscribeWebE2eeSession, verificationCode, verificationCode);
}
