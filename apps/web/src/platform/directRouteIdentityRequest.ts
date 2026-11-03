import { requestDirectRouteIdentityProof } from "@ryco/client-runtime/connection/directRouteIdentity";

import { webHttpClient } from "./httpClient";

/**
 * Desktop's identity challenge to a Hub machine's direct address. Only the
 * lazily loaded link and route code import this, so the verifier stays off boot.
 */
export const requestWebDirectRouteIdentityProof = (
  input: Parameters<typeof requestDirectRouteIdentityProof>[1],
) => requestDirectRouteIdentityProof(webHttpClient, input);
