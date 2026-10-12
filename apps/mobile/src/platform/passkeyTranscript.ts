import { encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import {
  AUTHENTICATOR_TRANSPORTS,
  type AuthenticationResponseJson,
  type AuthenticatorAttachment,
  type AuthenticatorTransport,
  type RegistrationResponseJson,
} from "@ryco/client-runtime/relay/webauthn";

/**
 * Pure encode/normalize layer between the runtime's WebAuthn option/response
 * contracts and the native passkey module. Native imports live in
 * `passkeyCeremony.ts`; everything here is testable without a native binary.
 *
 * Direction of travel:
 *  - encode: the runtime decodes and validates server options before the
 *    platform seam, so binary members arrive as `Uint8Array` and must be
 *    base64url-encoded for the native JSON request.
 *  - normalize: the native module already returns base64url strings, so this
 *    side validates and narrows rather than encoding, producing exactly the
 *    runtime's transcript shape (optional keys omitted, never `undefined`).
 */

/** Runtime-validated authentication options (`validatePasskeyAuthenticationOptions`). */
export interface DecodedAuthenticationOptions {
  readonly challenge: Uint8Array;
  readonly timeout?: number;
  readonly rpId?: string;
  readonly allowCredentials?: ReadonlyArray<DecodedCredentialDescriptor>;
  readonly userVerification?: string;
  readonly extensions?: Record<string, unknown>;
}

/** Runtime-validated registration options (`validatePasskeyRegistrationOptions`). */
export interface DecodedRegistrationOptions {
  readonly challenge: Uint8Array;
  readonly rp: { readonly name: string; readonly id?: string };
  readonly user: {
    readonly id: Uint8Array;
    readonly name: string;
    readonly displayName: string;
  };
  readonly pubKeyCredParams: ReadonlyArray<{ readonly type: "public-key"; readonly alg: number }>;
  readonly timeout?: number;
  readonly excludeCredentials?: ReadonlyArray<DecodedCredentialDescriptor>;
  readonly authenticatorSelection?: Record<string, unknown>;
  readonly attestation?: string;
  readonly extensions?: Record<string, unknown>;
}

interface DecodedCredentialDescriptor {
  readonly id: Uint8Array;
  readonly type: "public-key";
  readonly transports?: ReadonlyArray<AuthenticatorTransport>;
}

/** Native JSON request shapes. Structural mirrors so this module stays native-free. */
export interface NativeGetRequest {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout?: number;
  readonly allowCredentials?: ReadonlyArray<NativeCredentialDescriptor>;
  readonly userVerification?: string;
  readonly extensions?: Record<string, unknown>;
}

export interface NativeCreateRequest {
  readonly challenge: string;
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly pubKeyCredParams: ReadonlyArray<{ readonly type: "public-key"; readonly alg: number }>;
  readonly timeout?: number;
  readonly excludeCredentials?: ReadonlyArray<NativeCredentialDescriptor>;
  readonly authenticatorSelection?: Record<string, unknown>;
  readonly attestation?: string;
  readonly extensions?: Record<string, unknown>;
}

interface NativeCredentialDescriptor {
  readonly type: "public-key";
  readonly id: string;
  readonly transports?: ReadonlyArray<string>;
}

/** Native JSON result shapes (deliberately loose — the native contract is loose). */
export interface NativeGetResult {
  readonly id?: unknown;
  readonly rawId?: unknown;
  readonly type?: unknown;
  readonly authenticatorAttachment?: unknown;
  readonly response?: unknown;
  readonly clientExtensionResults?: unknown;
}

export interface NativeCreateResult {
  readonly id?: unknown;
  readonly rawId?: unknown;
  readonly type?: unknown;
  readonly authenticatorAttachment?: unknown;
  readonly response?: unknown;
  readonly clientExtensionResults?: unknown;
}

const CANCELLED = "Passkey ceremony was cancelled.";
const INVALID_RESPONSE = "Invalid passkey response.";

function invalidResponse(): never {
  throw new Error(INVALID_RESPONSE);
}

function requiredString(value: unknown): string {
  if (typeof value !== "string" || value.length === 0) invalidResponse();
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") invalidResponse();
  return value;
}

function responseObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidResponse();
  return value as Record<string, unknown>;
}

/**
 * The native contract types `type` as an open string. WebAuthn only defines
 * `"public-key"`; anything else means we are not looking at a passkey
 * transcript, so fail closed rather than coercing.
 */
function credentialType(value: unknown): void {
  if (value === undefined || value === null) return;
  if (value !== "public-key") invalidResponse();
}

function narrowAttachment(value: unknown): AuthenticatorAttachment | undefined {
  return value === "platform" || value === "cross-platform" ? value : undefined;
}

function narrowTransports(value: unknown): ReadonlyArray<AuthenticatorTransport> | undefined {
  if (!Array.isArray(value)) return undefined;
  const transports = value.filter((entry): entry is AuthenticatorTransport =>
    typeof entry === "string" ? AUTHENTICATOR_TRANSPORTS.has(entry) : false,
  );
  return transports.length > 0 ? transports : undefined;
}

/**
 * The native module omits `clientExtensionResults` when no extension produced
 * output; the runtime transcript requires the key to be present.
 */
function extensionResults(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value;
}

function encodeDescriptors(
  descriptors: ReadonlyArray<DecodedCredentialDescriptor> | undefined,
): ReadonlyArray<NativeCredentialDescriptor> | undefined {
  if (descriptors === undefined) return undefined;
  return descriptors.map((descriptor) => ({
    type: "public-key" as const,
    id: encodeBase64Url(descriptor.id),
    ...(descriptor.transports ? { transports: [...descriptor.transports] } : {}),
  }));
}

/**
 * A browser derives the RP ID from the document origin when the server omits
 * it; a native ceremony has no origin to fall back on, so the native modules
 * require it. Substituting a locally-derived value would override the server's
 * RP ID — the one thing this layer must never do — so fail closed instead.
 */
function requiredRelyingPartyId(value: string | undefined): string {
  if (value === undefined || value.length === 0) {
    throw new Error("Passkey options are missing the relying party id.");
  }
  return value;
}

/** Encode runtime-validated authentication options into the native request. */
export function encodeAuthenticationRequest(
  options: DecodedAuthenticationOptions,
): NativeGetRequest {
  const allowCredentials = encodeDescriptors(options.allowCredentials);
  return {
    challenge: encodeBase64Url(options.challenge),
    rpId: requiredRelyingPartyId(options.rpId),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(allowCredentials ? { allowCredentials } : {}),
    ...(options.userVerification === undefined
      ? {}
      : { userVerification: options.userVerification }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
  };
}

/** Encode runtime-validated registration options into the native request. */
export function encodeRegistrationRequest(
  options: DecodedRegistrationOptions,
): NativeCreateRequest {
  const excludeCredentials = encodeDescriptors(options.excludeCredentials);
  return {
    challenge: encodeBase64Url(options.challenge),
    rp: { id: requiredRelyingPartyId(options.rp.id), name: options.rp.name },
    user: {
      id: encodeBase64Url(options.user.id),
      name: options.user.name,
      displayName: options.user.displayName,
    },
    pubKeyCredParams: options.pubKeyCredParams.map((parameter) => ({
      type: parameter.type,
      alg: parameter.alg,
    })),
    ...(options.timeout === undefined ? {} : { timeout: options.timeout }),
    ...(excludeCredentials ? { excludeCredentials } : {}),
    ...(options.authenticatorSelection === undefined
      ? {}
      : { authenticatorSelection: options.authenticatorSelection }),
    ...(options.attestation === undefined ? {} : { attestation: options.attestation }),
    ...(options.extensions === undefined ? {} : { extensions: options.extensions }),
  };
}

/** Normalize a native assertion result into the runtime's authentication transcript. */
export function normalizeAuthenticationResponse(
  result: NativeGetResult | null | undefined,
): AuthenticationResponseJson {
  if (result === null || result === undefined) throw new Error(CANCELLED);
  credentialType(result.type);
  const response = responseObject(result.response);
  const id = requiredString(result.id);
  const userHandle = optionalString(response.userHandle);
  const attachment = narrowAttachment(result.authenticatorAttachment);
  return {
    id,
    // `id` is the base64url encoding of `rawId`; the native contract makes
    // `rawId` optional, so fall back rather than emitting an empty member.
    rawId: optionalString(result.rawId) ?? id,
    response: {
      clientDataJSON: requiredString(response.clientDataJSON),
      authenticatorData: requiredString(response.authenticatorData),
      signature: requiredString(response.signature),
      ...(userHandle === undefined ? {} : { userHandle }),
    },
    type: "public-key",
    clientExtensionResults: extensionResults(result.clientExtensionResults),
    ...(attachment === undefined ? {} : { authenticatorAttachment: attachment }),
  };
}

/** Normalize a native attestation result into the runtime's registration transcript. */
export function normalizeRegistrationResponse(
  result: NativeCreateResult | null | undefined,
): RegistrationResponseJson {
  if (result === null || result === undefined) throw new Error(CANCELLED);
  credentialType(result.type);
  const response = responseObject(result.response);
  const id = requiredString(result.id);
  const transports = narrowTransports(response.transports);
  const publicKey = optionalString(response.publicKey);
  const authenticatorData = optionalString(response.authenticatorData);
  const publicKeyAlgorithm = response.publicKeyAlgorithm;
  const attachment = narrowAttachment(result.authenticatorAttachment);
  return {
    id,
    rawId: optionalString(result.rawId) ?? id,
    response: {
      clientDataJSON: requiredString(response.clientDataJSON),
      attestationObject: requiredString(response.attestationObject),
      ...(transports ? { transports } : {}),
      ...(typeof publicKeyAlgorithm === "number" && Number.isSafeInteger(publicKeyAlgorithm)
        ? { publicKeyAlgorithm }
        : {}),
      ...(publicKey === undefined ? {} : { publicKey }),
      ...(authenticatorData === undefined ? {} : { authenticatorData }),
    },
    type: "public-key",
    clientExtensionResults: extensionResults(result.clientExtensionResults),
    ...(attachment === undefined ? {} : { authenticatorAttachment: attachment }),
  };
}

/**
 * Bounded, allow-listed messages for native ceremony failures.
 *
 * The native module rejects with a plain `{error, message}` object rather than
 * an `Error`, and its fallback branch stringifies the raw native error into the
 * message. Propagating that would put unbounded native detail into an error
 * surfaced to the UI, so every failure is mapped onto a fixed string here and
 * unrecognized codes collapse to a generic message.
 */
const NATIVE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  UserCancelled: CANCELLED,
  NotSupported: "Passkeys are not supported on this device.",
  BadConfiguration: "Passkeys are not configured for this app.",
  NoCredentials: "No passkey is available for this account on this device.",
  CredentialAlreadyExists: "A passkey for this account already exists on this device.",
  RequestFailed: "The passkey request failed.",
  InvalidChallenge: "The passkey request failed.",
  InvalidUserId: "The passkey request failed.",
  Interrupted: "The passkey request was interrupted. Try again.",
  TimedOut: "The passkey request timed out.",
};

const GENERIC_NATIVE_FAILURE = "Passkey ceremony failed.";

/** Map any native rejection onto a bounded `Error`, never leaking native detail. */
export function mapNativePasskeyError(cause: unknown): Error {
  if (cause instanceof Error && cause.message === CANCELLED) return cause;
  const code =
    typeof cause === "object" &&
    cause !== null &&
    typeof (cause as { error?: unknown }).error === "string"
      ? (cause as { error: string }).error
      : undefined;
  const message = code === undefined ? undefined : NATIVE_ERROR_MESSAGES[code];
  return new Error(message ?? GENERIC_NATIVE_FAILURE);
}

interface AbortSignalLike {
  readonly aborted: boolean;
  readonly addEventListener: (type: "abort", listener: () => void) => void;
  readonly removeEventListener: (type: "abort", listener: () => void) => void;
}

function abortSignalLike(value: unknown): AbortSignalLike | null {
  if (typeof value !== "object" || value === null) return null;
  const candidate = value as Partial<AbortSignalLike>;
  if (typeof candidate.aborted !== "boolean") return null;
  if (typeof candidate.addEventListener !== "function") return null;
  if (typeof candidate.removeEventListener !== "function") return null;
  return candidate as AbortSignalLike;
}

/**
 * Race a native ceremony against an abort signal.
 *
 * `hostedHubController.cancelAuthentication()` drives this. Neither native
 * passkey module accepts an abort signal for the assertion ceremony, so the
 * platform sheet may stay on screen until the user dismisses it; what we
 * guarantee is that the promise always settles and that an already-aborted
 * signal never reaches native at all.
 */
export async function withPasskeyAbort<T>(signal: unknown, run: () => Promise<T>): Promise<T> {
  const abortSignal = abortSignalLike(signal);
  if (abortSignal === null) return await run();
  if (abortSignal.aborted) throw new Error(CANCELLED);
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      onAbort = () => {
        reject(new Error(CANCELLED));
      };
      abortSignal.addEventListener("abort", onAbort);
      run().then(resolve, reject);
    });
  } finally {
    if (onAbort) abortSignal.removeEventListener("abort", onAbort);
  }
}
