import { getRouteApi } from "@tanstack/react-router";
import type { ReactElement } from "react";

import { HostedNativeAuthorizationRoute } from "../hostedHub/HostedNativeAuthorizationRoute";

const nativeAuthorizationRouteApi = getRouteApi("/native/authorize/$handoffId");

/**
 * The `/native/authorize/$handoffId` route body, loaded by the route file
 * through `lazyRouteComponent`.
 */
export function NativeAuthorizationRoute(): ReactElement {
  const handoffId = nativeAuthorizationRouteApi.useParams({
    select: (params) => params.handoffId,
  });
  return <HostedNativeAuthorizationRoute handoffId={handoffId} />;
}
