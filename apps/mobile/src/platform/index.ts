export { mobileAppLifecycle } from "./appLifecycle";
export { mobileAttachmentCodec, type MobileAttachmentInput } from "./attachmentCodec";
export {
  readMobileClientRuntimeConfig,
  readMobileHostedConfig,
  type MobileHostedConfig,
} from "./config";
export { createMobileEndpoint } from "./endpoint";
export { mobileClock, mobileFrameScheduler } from "./frame";
export { createMobileHttpClient } from "./httpClient";
export { createMobileKV, mobileKV, type AsyncKeyValueStore } from "./kv";
export {
  createMobileNativeAuthorization,
  mobileAuthorizationCallbackUri,
  mobileNativeAuthorization,
  type MobileNativeAuthorizationDependencies,
} from "./nativeAuthorization";
export { mobileObservability } from "./observability";
export {
  isMobilePasskeySupported,
  mobilePasskeyCeremony,
  resetPasskeyModuleForTests,
} from "./passkeyCeremony";
export { derSignatureToRaw, ecPublicKeyJwk, uncompressedPointToJwk } from "./ecdsa";
export {
  getMobileDeviceIdentityPublicKey,
  getMobileDeviceSigningKey,
  isMobileDeviceKeyAvailable,
  resetMobileDeviceKeyForTests,
  type DeviceKeyBacking,
} from "./deviceKey";
// `./e2eeSecureStore`, `./e2eeAgreementKey`, and `./e2eeClientPrekey` are
// DELIBERATELY ABSENT. This barrel is on the app's bootstrap path, Metro does not
// tree-shake, and those modules pull in the curve, hash, and canonical-CBOR
// packages — a startup cost every launch would pay whether or not the device ever
// runs E2EE. The E2EE client imports them by path.
export {
  assertHostedRuntimeGlobals,
  createMobileDpopSigner,
  resetMobileDpopSignerForTests,
} from "./dpopSigner";
export { assertE2eeRuntimeGlobals, type E2eeRuntimeHost } from "./e2eeRuntime";
export {
  clearMobileHostedSessionToken,
  createMobileSessionCredentials,
  hydrateMobileHostedSessionToken,
  mobileSessionCredentials,
  HOSTED_SESSION_TOKEN_KEY,
  type MobileSessionCredentials,
} from "./sessionCredentials";
export {
  createMobileSecretKV,
  mobileSecretKV,
  sanitizeSecretKey,
  type SecureStoreLike,
} from "./secretKv";
export { mobileSocket } from "./socket";
