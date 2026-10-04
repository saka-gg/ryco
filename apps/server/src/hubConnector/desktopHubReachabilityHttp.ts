import type { HubConnectorStatus, HubIdentitySummary } from "@ryco/contracts";
import {
  DESKTOP_HUB_REACHABILITY_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION,
  type DesktopHubReachabilityResponse,
} from "@ryco/contracts/desktop-native-node-claim";
import { Effect } from "effect";
import { HttpRouter, HttpServerResponse } from "effect/unstable/http";

import { HubConnectorService } from "./HubConnectorLive.ts";
import {
  DESKTOP_LOCAL_NO_STORE_HEADERS,
  requireDesktopLocalControl,
} from "./localIntroductionHttp.ts";

/**
 * Whether other devices can reach this node through the Hub now, or will once
 * a transient outage passes.
 *
 * Only an enrolled identity counts: an enrollment still waiting for approval,
 * a connector that is off or revoked, and a failure waiting on the operator
 * leave nothing to reach, so they must not keep the machine awake.
 */
export function hubConnectorIsReachable(
  status: HubConnectorStatus,
  enrolled: HubIdentitySummary["enrolled"],
): boolean {
  if (enrolled !== "active") return false;
  switch (status.state) {
    case "online":
    case "connecting":
    case "authenticating":
      return true;
    case "degraded":
      return status.degradedMode === "backing_off";
    default:
      return false;
  }
}

export const desktopHubReachabilityRouteLayer = HttpRouter.add(
  "POST",
  DESKTOP_HUB_REACHABILITY_PATH,
  Effect.gen(function* () {
    yield* requireDesktopLocalControl;
    const connector = yield* HubConnectorService;
    const status = connector.status();
    // Probed every minute: answer from the state files and never open key
    // custody, which only the fingerprint would need.
    const identity = yield* Effect.promise(() =>
      connector
        .identitySummary({ fingerprint: false })
        .catch(() => ({ enrolled: "unknown" as const })),
    );
    const body: DesktopHubReachabilityResponse = {
      protocolVersion: DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION,
      reachable: hubConnectorIsReachable(status, identity.enrolled),
      connectorEnabled: connector.connectorEnabled,
    };
    return HttpServerResponse.jsonUnsafe(body, {
      status: 200,
      headers: DESKTOP_LOCAL_NO_STORE_HEADERS,
    });
  }).pipe(
    // Refused like every other local-control route: nothing about the node.
    Effect.catch(() =>
      Effect.succeed(
        HttpServerResponse.jsonUnsafe({}, { status: 404, headers: DESKTOP_LOCAL_NO_STORE_HEADERS }),
      ),
    ),
  ),
);
