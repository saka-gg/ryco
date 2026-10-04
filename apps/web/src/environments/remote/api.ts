import {
  createRemoteEnvironmentApi,
  isRemoteEnvironmentAuthHttpError,
} from "@ryco/client-runtime/connection";

import { webEndpoint } from "../../platform/endpoint";
import { webHttpClient } from "../../platform/httpClient";

export { isRemoteEnvironmentAuthHttpError };

function api() {
  return createRemoteEnvironmentApi(webHttpClient, webEndpoint.origin());
}

export const bootstrapRemoteBearerSession = (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
}) => api().bootstrapRemoteBearerSession(input);
export const fetchRemoteSessionState = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}) => api().fetchRemoteSessionState(input);
export const rotateRemoteBearerSession = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}) => api().rotateRemoteBearerSession(input);
export const fetchRemoteEnvironmentDescriptor = (input: { readonly httpBaseUrl: string }) =>
  api().fetchRemoteEnvironmentDescriptor(input);
export const issueRemoteWebSocketToken = (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}) => api().issueRemoteWebSocketToken(input);
export const resolveRemoteWebSocketConnectionUrl = (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
}) => api().resolveRemoteWebSocketConnectionUrl(input);
