/**
 * The web "Add a device" dialog's props. What the dialog shows for the code it
 * minted, and which code "New code" may withdraw, is shared with the phone in
 * `@ryco/client-runtime/machineAccess/addDeviceCode`.
 */
import type { AdvertisedEndpoint } from "@ryco/contracts";

import type {
  ServerClientSessionRecord,
  ServerPairingLinkRecord,
} from "@ryco/client-runtime/connection";
import type { AddDeviceOperations } from "@ryco/client-runtime/machineAccess/addDeviceCode";

export interface AddDeviceDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Counts openings; each one mints its own code. */
  readonly opening: number;
  readonly operations: AddDeviceOperations;
  /** From the parent's access subscription: the dialog opens none of its own. */
  readonly pairingLinks: ReadonlyArray<ServerPairingLinkRecord>;
  readonly clientSessions: ReadonlyArray<ServerClientSessionRecord>;
  readonly endpoints: ReadonlyArray<AdvertisedEndpoint>;
  readonly defaultEndpointKey: string | null;
  /**
   * Opens the parent's network-access confirmation. Null where this app cannot
   * change it (a browser-served node is configured where it is launched).
   */
  readonly onTurnOnNetworkAccess: (() => void) | null;
}
