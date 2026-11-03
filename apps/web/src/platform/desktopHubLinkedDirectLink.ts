import type { EnvironmentId } from "@ryco/contracts";
import {
  isManuallyPairedEnvironment,
  resolveHubLinkedDirectTarget,
} from "@ryco/client-runtime/connection";
import { proveDirectRouteIdentity } from "@ryco/client-runtime/connection/directRouteIdentity";

import { fetchRemoteEnvironmentDescriptor } from "../environments/remote/api";
import { requestWebDirectRouteIdentityProof } from "./directRouteIdentityRequest";
import {
  addSavedEnvironment,
  connectDesktopWorkspaceEnvironment,
  listSavedEnvironmentRecords,
} from "../environments/runtime";
import type { DesktopHubLinkOutcome } from "./desktopHubLinkedDirectAccess";

const DEVICE_LABEL = "Ryco Desktop";

/**
 * Ask the machine over the Hub for a one-time code, find the address that
 * answers as the machine and proves its identity key, and save the link
 * (`desktopHubLinkedDirectAccess.ts`).
 */
export async function linkDesktopMachine(
  machine: {
    readonly environmentId: EnvironmentId;
    readonly label: string;
  },
  /** False once the links were forgotten meanwhile: nothing is saved then. */
  stillWanted: () => boolean = () => true,
): Promise<DesktopHubLinkOutcome> {
  const connection = await connectDesktopWorkspaceEnvironment(machine);
  const access = await connection.client.server.issueLinkedDirectAccess({
    deviceLabel: DEVICE_LABEL,
  });
  if (access.kind === "unavailable") return "no-direct-endpoint";
  // A machine the user paired by hand stays theirs: an environment of its own.
  if (isManuallyPairedEnvironment(listSavedEnvironmentRecords(), access.environmentId)) {
    return "already-paired";
  }
  if (access.nodeIdentityPublicKey === undefined) return "node-update-required";
  // The verifier loads here, not with the app: only linking and routes use it.
  const { proveDirectRouteIdentity } =
    await import("@ryco/client-runtime/connection/directRouteIdentity");
  const target = await resolveHubLinkedDirectTarget({
    access,
    fetchDescriptor: (httpBaseUrl) => fetchRemoteEnvironmentDescriptor({ httpBaseUrl }),
    proveIdentity: (input) =>
      proveDirectRouteIdentity({ ...input, requestProof: requestWebDirectRouteIdentityProof }),
  });
  if (target === null) return "unreachable";
  if (!stillWanted()) throw new Error("Direct access was removed while it was added.");
  await addSavedEnvironment({
    label: machine.label,
    host: target.httpBaseUrl,
    pairingCode: target.credential,
    hubLink: {
      hubEnvironmentId: machine.environmentId,
      linkedAt: new Date().toISOString(),
      nodeIdentityPublicKey: target.nodeIdentityPublicKey,
    },
  });
  return "linked";
}
