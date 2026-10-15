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

/**
 * Each wrapper takes exactly its shared call's input, so an option the shared
 * call gains — such as the attempt `signal` that abandons a request — reaches
 * it from here too, and cannot be dropped by a narrower local type.
 */
type RemoteEnvironmentApi = ReturnType<typeof createRemoteEnvironmentApi>;
type InputOf<K extends keyof RemoteEnvironmentApi> = Parameters<RemoteEnvironmentApi[K]>[0];

export const bootstrapRemoteBearerSession = (input: InputOf<"bootstrapRemoteBearerSession">) =>
  api().bootstrapRemoteBearerSession(input);
export const fetchRemoteSessionState = (input: InputOf<"fetchRemoteSessionState">) =>
  api().fetchRemoteSessionState(input);
export const rotateRemoteBearerSession = (input: InputOf<"rotateRemoteBearerSession">) =>
  api().rotateRemoteBearerSession(input);
export const fetchRemoteEnvironmentDescriptor = (
  input: InputOf<"fetchRemoteEnvironmentDescriptor">,
) => api().fetchRemoteEnvironmentDescriptor(input);
export const issueRemoteWebSocketToken = (input: InputOf<"issueRemoteWebSocketToken">) =>
  api().issueRemoteWebSocketToken(input);
export const resolveRemoteWebSocketConnectionUrl = (
  input: InputOf<"resolveRemoteWebSocketConnectionUrl">,
) => api().resolveRemoteWebSocketConnectionUrl(input);
