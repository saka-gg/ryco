import type { DpopSignerService } from "@ryco/client-runtime/platform";
import { createDpopProofSigner } from "@ryco/client-runtime/relay/dpop";

import { getMobileDeviceSigningKey } from "./deviceKey";

/**
 * The mobile DPoP proof signer.
 *
 * Proof construction itself lives in the runtime (`createDpopProofSigner`);
 * this module supplies only the platform primitives it needs — the hardware
 * key, a bound clock, a fresh jti, and a digest — and memoizes the signer so it
 * is built once per key rather than per request.
 *
 * `expo-crypto` is imported lazily: it reaches into `expo-modules-core` at
 * module scope, which pulls the native bridge into every consumer of the
 * platform barrel — including the direct plane, which never mints a proof.
 */

type CryptoModule = typeof import("expo-crypto");

/**
 * React Native has no `crypto.subtle`, and `atob`/`btoa` are not guaranteed
 * present in every Hermes build. The runtime's base64url codecs depend on them,
 * so a missing global must surface here as a clear hosted-unavailable state
 * rather than an unexplained failure deep inside the signer.
 */
export function assertHostedRuntimeGlobals(): void {
  if (typeof globalThis.atob !== "function" || typeof globalThis.btoa !== "function") {
    throw new Error("Hosted mode requires base64 support that is missing on this device.");
  }
}

let signerPromise: Promise<DpopSignerService> | undefined;

/**
 * Build (or return) the memoized DPoP signer.
 *
 * Rejects when no hardware key is available; the caller must then leave hosted
 * mode unconfigured rather than proceeding without proof capability.
 */
export async function createMobileDpopSigner(): Promise<DpopSignerService> {
  signerPromise ??= (async () => {
    assertHostedRuntimeGlobals();
    const crypto: CryptoModule = await import("expo-crypto");
    const key = await getMobileDeviceSigningKey();
    return createDpopProofSigner(key, {
      // Bound wrappers: unbound platform methods throw "Illegal invocation".
      now: () => Date.now(),
      randomJti: () => crypto.randomUUID(),
      sha256: async (bytes) =>
        new Uint8Array(
          await crypto.digest(
            crypto.CryptoDigestAlgorithm.SHA256,
            bytes as unknown as BufferSource,
          ),
        ),
    });
  })().catch((cause: unknown) => {
    signerPromise = undefined;
    throw cause;
  });
  return await signerPromise;
}

/** Test seam: drop the memoized signer between cases. */
export function resetMobileDpopSignerForTests(): void {
  signerPromise = undefined;
}
