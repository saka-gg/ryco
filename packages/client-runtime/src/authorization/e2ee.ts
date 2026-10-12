// Native E2EE enrollment, node trust resolution, and cross-device trust
// onboarding: the part of the authorization runtime that needs the relay E2EE
// primitives (curves, hashes, CBOR transcripts). Native clients load it with
// their hosted runtime through `@ryco/client-runtime/authorization/e2ee`; the
// root barrel does not re-export it, so importing the barrel keeps those
// primitives off a boot path (Metro does not tree-shake;
// `test/lightSubpaths.test.ts` guards the barrel).
export * from "./nativeE2eeEnrollment.ts";
export * from "./nativeE2eeTrustResolver.ts";
export * from "./nativeTrustOnboarding.ts";
