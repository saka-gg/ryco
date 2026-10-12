import { encodeBase64Url } from "@ryco/client-runtime/relay/base64url";
import {
  AUTHENTICATOR_TRANSPORTS,
  validatePasskeyAuthenticationOptions,
  validatePasskeyRegistrationOptions,
  type AuthenticationResponseJson,
  type RegistrationResponseJson,
} from "@ryco/client-runtime/relay/webauthn";

/**
 * Browser passkey ceremonies. The fail-closed option validation and response
 * codecs live in the runtime package; only the navigator.credentials calls and
 * browser credential-type handling belong here.
 */

function authenticatorAttachment(value: string | null): AuthenticatorAttachment | undefined {
  return value === "platform" || value === "cross-platform" ? value : undefined;
}

function authenticatorTransports(
  values: ReadonlyArray<string>,
): ReadonlyArray<AuthenticatorTransport> {
  return values.filter((value): value is AuthenticatorTransport =>
    AUTHENTICATOR_TRANSPORTS.has(value),
  );
}

function publicKeyCredential(value: Credential | null): PublicKeyCredential {
  if (!(value instanceof PublicKeyCredential)) throw new Error("Passkey ceremony was cancelled.");
  return value;
}

export async function getPasskeyAuthentication(
  options: unknown,
  signal?: AbortSignal,
): Promise<AuthenticationResponseJson> {
  const publicKeyOptions =
    typeof options === "object" &&
    options !== null &&
    "challenge" in options &&
    (options as { challenge?: unknown }).challenge instanceof Uint8Array
      ? (options as PublicKeyCredentialRequestOptions)
      : (validatePasskeyAuthenticationOptions(options) as PublicKeyCredentialRequestOptions);
  const credential = publicKeyCredential(
    await navigator.credentials.get({
      publicKey: publicKeyOptions,
      ...(signal ? { signal } : {}),
    }),
  );
  const response = credential.response;
  if (!(response instanceof AuthenticatorAssertionResponse)) {
    throw new Error("Invalid passkey response.");
  }
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      authenticatorData: encodeBase64Url(response.authenticatorData),
      signature: encodeBase64Url(response.signature),
      ...(response.userHandle ? { userHandle: encodeBase64Url(response.userHandle) } : {}),
    },
    type: "public-key",
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(authenticatorAttachment(credential.authenticatorAttachment)
      ? { authenticatorAttachment: authenticatorAttachment(credential.authenticatorAttachment)! }
      : {}),
  };
}

export async function createPasskeyRegistration(
  options: unknown,
  signal?: AbortSignal,
): Promise<RegistrationResponseJson> {
  const publicKeyOptions =
    typeof options === "object" &&
    options !== null &&
    "challenge" in options &&
    (options as { challenge?: unknown }).challenge instanceof Uint8Array
      ? (options as PublicKeyCredentialCreationOptions)
      : (validatePasskeyRegistrationOptions(options) as PublicKeyCredentialCreationOptions);
  const credential = publicKeyCredential(
    await navigator.credentials.create({
      publicKey: publicKeyOptions,
      ...(signal ? { signal } : {}),
    }),
  );
  const response = credential.response;
  if (!(response instanceof AuthenticatorAttestationResponse)) {
    throw new Error("Invalid passkey response.");
  }
  const publicKeyBytes = response.getPublicKey?.() ?? null;
  const authenticatorData = response.getAuthenticatorData?.();
  const publicKeyAlgorithm = response.getPublicKeyAlgorithm?.();
  const transports = response.getTransports?.();
  return {
    id: credential.id,
    rawId: encodeBase64Url(credential.rawId),
    response: {
      clientDataJSON: encodeBase64Url(response.clientDataJSON),
      attestationObject: encodeBase64Url(response.attestationObject),
      ...(transports ? { transports: authenticatorTransports(transports) } : {}),
      ...(publicKeyAlgorithm === undefined ? {} : { publicKeyAlgorithm }),
      ...(publicKeyBytes ? { publicKey: encodeBase64Url(publicKeyBytes) } : {}),
      ...(authenticatorData ? { authenticatorData: encodeBase64Url(authenticatorData) } : {}),
    },
    type: "public-key",
    clientExtensionResults: credential.getClientExtensionResults(),
    ...(authenticatorAttachment(credential.authenticatorAttachment)
      ? { authenticatorAttachment: authenticatorAttachment(credential.authenticatorAttachment)! }
      : {}),
  };
}
