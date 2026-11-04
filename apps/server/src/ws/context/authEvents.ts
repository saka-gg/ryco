import type { AuthAccessStreamEvent, AuthSessionId } from "@ryco/contracts";

import { OWNER_BOOTSTRAP_PAIRING_SUBJECT } from "../../auth/Services/AuthControlPlane.ts";
import type { BootstrapCredentialChange } from "../../auth/Services/BootstrapCredentialService.ts";
import type { SessionCredentialChange } from "../../auth/Services/SessionCredentialService.ts";

/**
 * Whether a change belongs on the auth access stream. The startup owner link is
 * left out live as it is from the snapshot (`ServerAuth.listPairingLinks`).
 */
export function isListedAuthAccessChange(
  change: BootstrapCredentialChange | SessionCredentialChange,
): boolean {
  return (
    change.type !== "pairingLinkUpserted" ||
    change.pairingLink.subject !== OWNER_BOOTSTRAP_PAIRING_SUBJECT
  );
}

export function toAuthAccessStreamEvent(
  change: BootstrapCredentialChange | SessionCredentialChange,
  revision: number,
  currentSessionId: AuthSessionId,
): AuthAccessStreamEvent {
  switch (change.type) {
    case "pairingLinkUpserted":
      return {
        version: 1,
        revision,
        type: "pairingLinkUpserted",
        payload: change.pairingLink,
      };
    case "pairingLinkRemoved":
      return {
        version: 1,
        revision,
        type: "pairingLinkRemoved",
        payload: { id: change.id },
      };
    case "clientUpserted":
      return {
        version: 1,
        revision,
        type: "clientUpserted",
        payload: {
          ...change.clientSession,
          current: change.clientSession.sessionId === currentSessionId,
        },
      };
    case "clientRemoved":
      return {
        version: 1,
        revision,
        type: "clientRemoved",
        payload: { sessionId: change.sessionId },
      };
  }
}
