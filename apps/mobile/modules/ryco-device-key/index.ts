import { requireNativeModule } from "expo-modules-core";

/**
 * Hardware-backed P-256 device key (Secure Enclave on iOS, StrongBox on
 * Android, with hardware-backed TEE as the conservative fallback) used to sign DPoP proofs for the
 * hosted plane.
 *
 * The private key never crosses this boundary: the module exposes no export or
 * extract path, only "make sure a key exists", "sign these bytes", and
 * lifecycle. Both platforms fail closed when hardware backing is unavailable —
 * there is deliberately no software fallback, because a software key would
 * reduce DPoP to bare bearer assurance.
 */
export interface RycoDeviceKeyModule {
  /**
   * Create the key if absent and return its public half.
   *
   * `publicKey` is a base64 X9.63 uncompressed point (`0x04 ‖ X(32) ‖ Y(32)`).
   * Rejects when the enclave or StrongBox is unavailable.
   */
  readonly ensureKey: () => Promise<{ publicKey: string; backing: DeviceKeyBacking }>;
  /**
   * Sign base64 payload bytes, returning a base64 ASN.1 DER
   * `SEQUENCE { INTEGER r, INTEGER s }`. The JS layer converts it to the raw
   * `r ‖ s` form JWS ES256 requires.
   */
  readonly sign: (payloadBase64: string) => Promise<string>;
  readonly deleteKey: () => Promise<void>;
}

export type DeviceKeyBacking = "secure-enclave" | "strongbox" | "tee" | "unavailable";

export default requireNativeModule<RycoDeviceKeyModule>("RycoDeviceKey");
