import type { DpopPublicJwk, DpopSigningKey } from "@ryco/client-runtime/relay/dpop";

import { derSignatureToRaw, uncompressedPointToJwk } from "./ecdsa";

/**
 * Builds a {@link DpopSigningKey} over the hardware device-key module.
 *
 * The native module is loaded lazily so importing the platform barrel never
 * touches the keystore, and the resulting key is memoized: the signer is built
 * once per key, never per request.
 *
 * Fails closed throughout. There is no software fallback — if the enclave or
 * StrongBox is unavailable the hosted plane must present an unavailable state
 * rather than sign with a weaker key.
 *
 * The same key is the relay E2EE client identity key: `docs/relay-e2ee-protocol.md`
 * §6.2 cross-signs the device's static agreement key with it, so the public point
 * is surfaced alongside the JWK. It never gains a second signing entry point —
 * §7.2's rule is that only a named encoder's output is ever signed.
 */

export type DeviceKeyBacking = "secure-enclave" | "strongbox" | "tee" | "unavailable";

type DeviceKeyModule = (typeof import("@ryco/mobile-device-key"))["default"];

const HARDWARE_BACKINGS: ReadonlySet<string> = new Set<DeviceKeyBacking>([
  "secure-enclave",
  "strongbox",
  "tee",
]);

const UNAVAILABLE = "A hardware-backed device key is unavailable on this device.";

/**
 * The loaded key: the public point exactly as the platform emitted it, and the
 * signer over it.
 *
 * The point is kept alongside the JWK because two consumers need two encodings
 * of the same key and neither can derive the other cheaply. DPoP needs the JWK
 * (its thumbprint binds the session); the relay E2EE client prekey certificate
 * needs the X9.63 uncompressed point verbatim, because that is what
 * `docs/relay-e2ee-protocol.md` §7.4 element 4 carries and what its
 * `ryco.client-key.v1` fingerprint is computed over (§7.1).
 */
interface LoadedDeviceKey {
  readonly publicKey: Uint8Array;
  readonly publicJwk: DpopPublicJwk;
  readonly backing: Exclude<DeviceKeyBacking, "unavailable">;
  readonly sign: (signingInput: Uint8Array) => Promise<Uint8Array>;
}

let modulePromise: Promise<DeviceKeyModule> | undefined;
let deviceKeyPromise: Promise<LoadedDeviceKey> | undefined;
let signingKeyPromise: Promise<DpopSigningKey> | undefined;

async function loadDeviceKeyModule(): Promise<DeviceKeyModule> {
  modulePromise ??= import("@ryco/mobile-device-key").then((module) => module.default);
  return await modulePromise;
}

/** Base64 (not base64url) is the native module's wire format for raw bytes. */
function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const decoded = atob(value);
  const bytes = new Uint8Array(decoded.length);
  for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
  return bytes;
}

/**
 * Resolve the hardware key, creating it on first use.
 *
 * Rejects with a stable, bounded message when hardware backing is missing. The
 * rejection is not memoized, so a later attempt (for example after the user
 * sets a device passcode) can still succeed.
 */
async function loadDeviceKey(): Promise<LoadedDeviceKey> {
  deviceKeyPromise ??= (async () => {
    const module = await loadDeviceKeyModule();
    const { publicKey, backing } = await module.ensureKey();
    if (!HARDWARE_BACKINGS.has(backing) || backing === "unavailable") throw new Error(UNAVAILABLE);
    const point = fromBase64(publicKey);
    // Rejects a wrong-length or wrong-prefix point, so the point memoized here
    // has already passed the same encoding check the JWK conversion applies.
    const publicJwk = uncompressedPointToJwk(point);
    return {
      publicKey: point,
      publicJwk,
      backing: backing as Exclude<DeviceKeyBacking, "unavailable">,
      sign: async (signingInput: Uint8Array): Promise<Uint8Array> => {
        const signature = await module.sign(toBase64(signingInput));
        // Both platforms return DER; JWS ES256 and §7.1's client signature
        // encoding both require the fixed-width raw `r ‖ s`.
        return derSignatureToRaw(fromBase64(signature));
      },
    };
  })().catch((cause: unknown) => {
    deviceKeyPromise = undefined;
    throw cause instanceof Error && cause.message === UNAVAILABLE ? cause : new Error(UNAVAILABLE);
  });
  return await deviceKeyPromise!;
}

/** The DPoP view of the device key: the JWK and the signer, never the point. */
export async function getMobileDeviceSigningKey(): Promise<DpopSigningKey> {
  signingKeyPromise ??= loadDeviceKey()
    .then(
      (key) =>
        ({
          algorithm: "ES256",
          publicJwk: key.publicJwk,
          sign: key.sign,
        }) satisfies DpopSigningKey,
    )
    .catch((cause: unknown) => {
      signingKeyPromise = undefined;
      throw cause;
    });
  return await signingKeyPromise;
}

/**
 * The device key's public half as an X9.63 uncompressed point
 * (`0x04 ‖ X(32) ‖ Y(32)`, `P256_PUBLIC_KEY_BYTES`).
 *
 * This is the client identity key of `docs/relay-e2ee-protocol.md` §7.4 element
 * 4. A COPY is returned each call: the memoized point outlives every caller, and
 * a caller that sliced or filled the shared buffer would corrupt every later
 * transcript signed under it.
 *
 * Read-only by construction. There is no signing entry point here — §7.2 forbids
 * ad-hoc to-be-signed bytes, so the only thing that reaches the device key's
 * signer under this protocol is a named encoder's output.
 */
export async function getMobileDeviceIdentityPublicKey(): Promise<Uint8Array> {
  const { publicKey } = await loadDeviceKey();
  return Uint8Array.from(publicKey);
}

/** The native module's measured backing, kept separate from the key's public bytes. */
export async function getMobileDeviceKeyBacking(): Promise<
  Exclude<DeviceKeyBacking, "unavailable">
> {
  return (await loadDeviceKey()).backing;
}

/** Whether a hardware key can be used, without surfacing why it cannot. */
export async function isMobileDeviceKeyAvailable(): Promise<boolean> {
  try {
    await getMobileDeviceSigningKey();
    return true;
  } catch {
    return false;
  }
}

/** Test seam: drop the memoized native module and signing key between cases. */
export function resetMobileDeviceKeyForTests(): void {
  modulePromise = undefined;
  deviceKeyPromise = undefined;
  signingKeyPromise = undefined;
}
