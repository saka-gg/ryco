import {
  BootstrapHttpError,
  createPrimaryAuth,
  type ServerAuthGateState,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
} from "@ryco/client-runtime/connection";

import { webEndpoint } from "../../platform/endpoint";
import { webHttpClient } from "../../platform/httpClient";
import { webPairingCredentialSource } from "../../platform/pairingCredentialSource";
import { webSessionCredentials } from "../../platform/sessionCredentials";
import { stripPairingTokenFromUrl } from "./pairingCredential";

export {
  peekPairingTokenFromUrl,
  stripPairingTokenFromUrl,
  takePairingTokenFromUrl,
} from "./pairingCredential";

export {
  BootstrapHttpError,
  type ServerAuthGateState,
  type ServerClientSessionRecord,
  type ServerPairingLinkRecord,
};

const auth = createPrimaryAuth({
  endpoint: webEndpoint,
  httpClient: webHttpClient,
  pairingCredentialSource: webPairingCredentialSource,
  readBootstrapCredential: () => {
    const bootstrap = window.desktopBridge?.getLocalEnvironmentBootstrap();
    return typeof bootstrap?.bootstrapToken === "string" && bootstrap.bootstrapToken.length > 0
      ? bootstrap.bootstrapToken
      : null;
  },
  sessionCredentials: webSessionCredentials,
});

export const fetchSessionState = auth.fetchSessionState;
export const issuePrimaryWebSocketToken = auth.issuePrimaryWebSocketToken;
export const prefetchPrimaryWebSocketToken = auth.prefetchPrimaryWebSocketToken;
export const discardPrefetchedPrimaryWebSocketToken = auth.discardPrefetchedPrimaryWebSocketToken;
export const retryTransientBootstrap = auth.retryTransientBootstrap;
export const createServerPairingCredential = auth.createServerPairingCredential;
export const listServerPairingLinks = auth.listServerPairingLinks;
export const revokeServerPairingLink = auth.revokeServerPairingLink;
export const listServerClientSessions = auth.listServerClientSessions;
export const revokeServerClientSession = auth.revokeServerClientSession;
export const revokeOtherServerClientSessions = auth.revokeOtherServerClientSessions;
export const fetchHubStatus = auth.fetchHubStatus;
export const fetchHubIdentity = auth.fetchHubIdentity;
export const fetchHubEnrollment = auth.fetchHubEnrollment;
export const startHubEnrollment = auth.startHubEnrollment;
export const cancelHubEnrollment = auth.cancelHubEnrollment;
export const resumeHubConnector = auth.resumeHubConnector;
export const leaveHub = auth.leaveHub;

// The node's E2EE operator surface. Local-only by construction: `webEndpoint`
// resolves node HTTP through `resolvePrimaryEnvironmentHttpUrl`, which throws in
// hosted Hub mode, so none of these can leave a hosted browser.
export const fetchNodeE2eeClients = auth.fetchNodeE2eeClients;
export const applyNodeE2eeAuthorization = auth.applyNodeE2eeAuthorization;
export const createNodeE2eeClientApprovalQr = auth.createNodeE2eeClientApprovalQr;
export const setNodeE2eePairingWindow = auth.setNodeE2eePairingWindow;
export const clearNodeE2eeRefusals = auth.clearNodeE2eeRefusals;
export const fetchNodeE2eeSessions = auth.fetchNodeE2eeSessions;
export const fetchNodeE2eePolicy = auth.fetchNodeE2eePolicy;
export const previewNodeE2eePolicy = auth.previewNodeE2eePolicy;
export const applyNodeE2eePolicy = auth.applyNodeE2eePolicy;
export const recoverNodeE2eePolicyGeneration = auth.recoverNodeE2eePolicyGeneration;
export const fetchNodeE2eePrekey = auth.fetchNodeE2eePrekey;
export const rotateNodeE2eePrekey = auth.rotateNodeE2eePrekey;
export const fetchNodeE2eeContinuity = auth.fetchNodeE2eeContinuity;
export const applyNodeE2eeContinuity = auth.applyNodeE2eeContinuity;
export const fetchNodeE2eeFallback = auth.fetchNodeE2eeFallback;
export const resetNodeE2eeFallback = auth.resetNodeE2eeFallback;
export const resolveInitialServerAuthGateState = auth.resolveInitialServerAuthGateState;
export const __resetServerAuthBootstrapForTests = auth.resetForTests;

export async function submitServerAuthCredential(credential: string): Promise<void> {
  await auth.submitServerAuthCredential(credential);
  stripPairingTokenFromUrl();
}
