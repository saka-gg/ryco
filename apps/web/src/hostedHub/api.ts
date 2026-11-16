import { HostedHubApi as RuntimeHostedHubApi } from "@ryco/client-runtime/authorization";

import { webEndpoint } from "../platform/endpoint";
import { webHttpClient } from "../platform/httpClient";
import { webPasskeyCeremony } from "../platform/passkeyCeremony";
import { webSessionCredentials } from "../platform/sessionCredentials";

export { HostedHubApiError } from "@ryco/client-runtime/authorization";

export class HostedHubApi extends RuntimeHostedHubApi {
  constructor() {
    super({
      endpoint: webEndpoint,
      httpClient: webHttpClient,
      passkeyCeremony: webPasskeyCeremony,
      sessionCredentials: webSessionCredentials,
    });
  }
}

/** The app's one hosted Hub API: browser fetch, cookie and passkey primitives over the shared client-runtime policy. Use it instead of constructing another HostedHubApi. */
export const hostedHubApi = new HostedHubApi();
