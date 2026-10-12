/**
 * The Hub account, E2EE and remote-workspace stack, loaded on first use.
 *
 * It pulls in the client-runtime authorization and relay code, the Noise/E2EE
 * primitives and their crypto dependencies — most of the main bundle — yet is
 * only reachable once a Hub origin is configured and something asks for it.
 * `main.ts` imports this module dynamically; never import it statically there
 * (`desktopMainBundleSplitting.test.ts` guards that).
 */
export {
  createNativeSecurityHelperRunner,
  desktopNativeInstallationNamespace,
  DesktopNativeSecurityHelper,
  desktopNativeSecurityNamespace,
  resolveDesktopNativeSecurityHelperPath,
} from "./nativeSecurityHelper.ts";
export {
  createDesktopHostedSessionCredentials,
  getOrCreateDesktopInstallationId,
} from "./hostedCredentials.ts";
export {
  createDesktopDpopSigner,
  createDesktopHostedHubApi,
  DesktopHostedIdentityCoordinator,
  shouldEnableDesktopHubConnectorForAccountSetup,
} from "./desktopHostedIdentity.ts";
export { DesktopE2eeTrustStore } from "./desktopE2eeTrust.ts";
export { DesktopE2eePrekeyIssuer } from "./desktopE2eePrekey.ts";
export { createDesktopNativeE2eePlatform } from "./desktopNativeE2ee.ts";
export { DesktopNativeE2eeHandshakeService } from "./desktopNativeE2eeHandshake.ts";
export { createDesktopNativeSecretStore } from "./nativeSecretStore.ts";
export { createDesktopWorkspaceMetadataCache } from "./desktopWorkspaceCache.ts";
export { DesktopWorkspaceClient } from "./desktopWorkspaceClient.ts";
export {
  createDesktopWorkspaceIpcHandlers,
  projectDesktopWorkspaceState,
} from "./desktopWorkspaceIpc.ts";
export {
  DESKTOP_WORKSPACE_MAX_RPC_FRAME_BYTES,
  DesktopWorkspaceRelayManager,
} from "./desktopWorkspaceRelay.ts";
