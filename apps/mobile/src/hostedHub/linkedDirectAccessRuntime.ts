import { requestDirectRouteIdentityProof } from "@ryco/client-runtime/connection/directRouteIdentity";
import { describeHubLinkOutcome, type BetterRouteTrigger } from "@ryco/client-runtime/connection";
import type { EnvironmentId } from "@ryco/contracts";

import { subscribeAppStateResume } from "../connection/appStateResume";
import { subscribeNetworkPathChange } from "../connection/networkPathChange";
import { isRemoteEnvironmentAuthHttpError } from "../connection/remoteApi";
import { getMobileHttpClient } from "../connection/runtimeConfig";
import { createMobileConnectionRegistry } from "../runtime/bootstrap";
import {
  createMobileLinkedDirectAccess,
  MOBILE_ROUTE_CHECK_INTERVAL_MS,
  type MobileLinkedDirectAccess,
} from "./linkedDirectAccess";
import {
  setMobileLinkedHubs,
  setMobileLinkNotice,
  setMobileLinking,
} from "./linkedDirectAccessState";

/** How the node's owner sees this device under Connections. */
const DEVICE_LABEL = "Ryco phone";

let instance: MobileLinkedDirectAccess | null = null;

/**
 * The app's linked direct access (`linkedDirectAccess.ts`), over the app's
 * saved catalog, remote API and hosted connections. Loaded with the hosted
 * runtime, never at launch.
 */
export function mobileLinkedDirectAccess(): MobileLinkedDirectAccess {
  if (instance !== null) return instance;
  const registry = createMobileConnectionRegistry();
  instance = createMobileLinkedDirectAccess({
    catalog: registry.catalog,
    remoteApi: registry.remoteApi,
    requestProof: (request) => requestDirectRouteIdentityProof(getMobileHttpClient(), request),
    isBearerRefused: isRemoteEnvironmentAuthHttpError,
    // Only a relay channel may ask: the node refuses the request on any other.
    issueLinkedDirectAccess: (hubEnvironmentId) =>
      registry.driver.supervisor
        .require(hubEnvironmentId)
        .client.server.issueLinkedDirectAccess({ deviceLabel: DEVICE_LABEL }),
  });
  // The rows learn which machines are linked from here, never from the catalog.
  const publishLinked = () =>
    setMobileLinkedHubs(
      registry.catalog
        .listLinked()
        .flatMap((record) => (record.hubLink ? [record.hubLink.hubEnvironmentId] : [])),
    );
  registry.catalog.registryStore.subscribe(publishLinked);
  void registry.catalog.waitForHydration().then(publishLinked);
  return instance;
}

/** The owner's "Add direct access" on a Hub machine's row. */
export async function addMobileDirectAccess(machine: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}): Promise<void> {
  setMobileLinkNotice(machine.environmentId, null);
  setMobileLinking(machine.environmentId, true);
  try {
    const outcome = await mobileLinkedDirectAccess().link(machine);
    setMobileLinkNotice(machine.environmentId, describeHubLinkOutcome(machine.label, outcome));
  } catch {
    setMobileLinkNotice(machine.environmentId, describeHubLinkOutcome(machine.label, "failed"));
  } finally {
    setMobileLinking(machine.environmentId, false);
  }
}

/** The owner's "Remove direct access": the link and its bearer go, the relay carries the machine. */
export async function removeMobileDirectAccess(hubEnvironmentId: EnvironmentId): Promise<void> {
  setMobileLinkNotice(hubEnvironmentId, null);
  await mobileLinkedDirectAccess().forget(hubEnvironmentId);
}

/** Route checks while the app runs: every minute, on a network change, and on resume. */
export function subscribeMobileRouteTriggers(
  trigger: (reason: BetterRouteTrigger) => void,
): () => void {
  const interval = setInterval(() => trigger("interval"), MOBILE_ROUTE_CHECK_INTERVAL_MS);
  const stopNetwork = subscribeNetworkPathChange(() => trigger("network-changed"));
  const stopResume = subscribeAppStateResume(() => trigger("resume"));
  return () => {
    clearInterval(interval);
    stopNetwork();
    stopResume();
  };
}
