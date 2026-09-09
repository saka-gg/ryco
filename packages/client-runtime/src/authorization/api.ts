import { EnvironmentId, RelayNodeId } from "@ryco/contracts";
import {
  NATIVE_HANDOFF_CODE_LIFETIME_MS,
  NATIVE_HANDOFF_APPROVE_PATH_SUFFIX,
  NATIVE_HANDOFF_CANCEL_PATH_SUFFIX,
  NATIVE_HANDOFF_PRESENTATION_PATH_PREFIX,
  NATIVE_HANDOFF_REDEEM_PATH,
  NATIVE_HANDOFF_START_PATH,
  NativeHandoffApproveResponse,
  NativeHandoffCancelResponse,
  NativeHandoffConnectRedeemRequest,
  NativeHandoffConnectRedeemResponse,
  NativeHandoffId,
  NativeHandoffPresentation,
  NativeHandoffRedeemRequest,
  NativeHandoffRedeemResponse,
  NativeHandoffStartRequest,
  NativeHandoffStartResponse,
  type NativeHandoffApproveResponse as NativeHandoffApproveResponseType,
  type NativeHandoffCancelResponse as NativeHandoffCancelResponseType,
  type NativeHandoffConnectRedeemRequest as NativeHandoffConnectRedeemRequestType,
  type NativeHandoffConnectRedeemResponse as NativeHandoffConnectRedeemResponseType,
  type NativeHandoffPresentation as NativeHandoffPresentationType,
  type NativeHandoffRedeemRequest as NativeHandoffRedeemRequestType,
  type NativeHandoffRedeemResponse as NativeHandoffRedeemResponseType,
  type NativeHandoffStartRequest as NativeHandoffStartRequestType,
  type NativeHandoffStartResponse as NativeHandoffStartResponseType,
} from "@ryco/contracts/native-handoff";
import {
  ACCOUNT_E2EE_DEVICE_PATH_PREFIX,
  ACCOUNT_E2EE_DEVICES_PATH,
  AccountE2eeDeviceListResponse,
  AccountE2eeDeviceMutationResponse,
  AccountE2eeDeviceRenameRequest,
  AccountE2eeDeviceRevokeRequest,
  HubGrantVerificationKeysetResponse,
  NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH,
  NATIVE_E2EE_CURRENT_DEVICE_PATH,
  NATIVE_E2EE_GRANT_KEYS_PATH,
  NativeAccountGrantRelayTicketRequest,
  NativeAccountGrantRelayTicketResponse,
  NativeE2eeEnrollmentId,
  NativeE2eeEnrollmentUpsertRequest,
  NativeE2eeEnrollmentUpsertResponse,
  type AccountE2eeDeviceSummary,
  type HubGrantVerificationKeysetResponse as HubGrantVerificationKeysetResponseType,
  type NativeAccountGrantRelayTicketRequest as NativeAccountGrantRelayTicketRequestType,
  type NativeAccountGrantRelayTicketResponse as NativeAccountGrantRelayTicketResponseType,
  type NativeE2eeEnrollmentUpsertRequest as NativeE2eeEnrollmentUpsertRequestType,
} from "@ryco/contracts/native-e2ee";
import * as HostedIdentity from "@ryco/contracts/hosted-identity";
import { Schema } from "effect";
import { assertE2eeAccountId } from "@ryco/shared/relayE2eeTranscripts";

import type {
  DpopSignerService,
  EndpointService,
  HttpClientService,
  NativeAuthorizationService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "../platform/index.ts";

import type {
  HostedAccountSecurity,
  HostedAddPasskeyResult,
  HostedHubNode,
  HostedHubPasskey,
  HostedHubSessionResponse,
  HostedNodeEnrollment,
  HostedRelayTicket,
  HostedTotpEnrollment,
} from "./types.ts";
import {
  validatePasskeyAuthenticationOptions,
  validatePasskeyRegistrationOptions,
} from "../relay/webauthn.ts";
import { runNativeHandoff, runTypedNativeHandoff } from "./nativeHandoff.ts";

const JSON_HEADERS = { accept: "application/json", "content-type": "application/json" } as const;

const MAX_BEARER_TOKEN_LENGTH = 4096;
const MAX_PASSKEY_LABEL_LENGTH = 256;
const MAX_PASSKEYS = 256;
const MAX_HUB_NODE_LABEL_LENGTH = 100;
const HUB_NODE_ID_PATTERN = /^node_[A-Za-z0-9_-]{22,43}$/;
/**
 * The reason code shape the Hub's node-revoke route accepts.
 *
 * Its body schema is strict and `reasonCode` is REQUIRED, not optional — a call
 * that omits it, or sends a human sentence, comes back 400 with nothing said
 * about which field was wrong. Refusing it here keeps that failure off the wire
 * and out of the owner's face, exactly as {@link HostedHubApi.renameNode}'s
 * label bounds do.
 */
const HUB_REVOCATION_REASON_PATTERN = /^[a-z0-9._-]{1,64}$/;

/**
 * Bounds for the *newly added* recovery-code route only, set well clear of any
 * plausible real format. They are deliberately not applied to the pre-existing
 * session paths — see {@link recoveryCodesValue}.
 */
const MAX_RECOVERY_CODES = 256;
const MAX_RECOVERY_CODE_LENGTH = 512;

/**
 * Bounds the identifier a malformed Hub response may project into a view model.
 * Deliberately permissive: this is the *projection* constraint, and rejecting a
 * legitimately-shaped credential here would blank the whole passkey list.
 *
 * It is emphatically **not** what makes {@link HostedHubApi.revokePasskey} safe
 * to build a URL path from — that method re-validates its caller-supplied
 * argument against the narrower {@link PASSKEY_CREDENTIAL_ID_PATTERN} at the
 * call boundary, so an id that reached a view model through a looser check can
 * still never be interpolated into a request path.
 */
const CREDENTIAL_ID_PATTERN = /^[A-Za-z0-9_-]{1,512}$/;

/**
 * The Hub's passkey-credential identifier: a `pkey_` prefix and 22 base64url
 * characters, the same shape the Hub's own route matcher enforces. This is the
 * gate on the one account path built by interpolation, so it is checked before
 * a URL is constructed and before any I/O — an id that does not match never
 * reaches the wire in any form.
 */
const PASSKEY_CREDENTIAL_ID_PATTERN = /^pkey_[A-Za-z0-9_-]{22}$/;

/** Bounds on the passkey revocation reason a malformed Hub may project. */
const MAX_REVOCATION_REASON_LENGTH = 256;

/**
 * Bounds on the TOTP enrolment response. Both members are **sensitive**: the
 * base32 secret *is* the shared key, and the provisioning URI embeds it. They
 * are returned to the caller for a single enrolment display and are never
 * logged, persisted, or placed in an error by this client.
 */
const MAX_TOTP_SECRET_LENGTH = 256;
const MAX_TOTP_PROVISIONING_URI_LENGTH = 2048;
const MAX_AUTH_EMAIL_LENGTH = 254;
const MAX_AUTH_PASSWORD_LENGTH = 256;
const MAX_AUTH_TOTP_LENGTH = 16;
const MAX_AUTH_RECOVERY_CODE_LENGTH = 128;
const AUTH_EMAIL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The provisioning URI is an `otpauth://` key URI (RFC-style, what authenticator
 * apps consume). Requiring the scheme fails closed on a malformed Hub handing
 * back something a surface might render as a link or navigate to.
 */
const TOTP_PROVISIONING_URI_SCHEME = "otpauth://";

/**
 * How long any single Hub request may take before this client gives up. Covers
 * the network round trip only — a passkey ceremony runs outside `#request` and
 * is bounded by the platform sheet plus `cancelAccountAction`.
 */
const REQUEST_DEADLINE_MS = 30_000;

/**
 * Hub routes that only accept a browser transport: they require an `Origin` in
 * the Hub's configured WebAuthn origin list, which a native socket cannot
 * present. The bearer branch below still derives these paths for owner
 * bootstrap and invitation redemption, so without an explicit guard a native
 * caller gets an unexplained 404 instead of an actionable message. Prefixes are
 * matched against the parsed, normalized pathname.
 *
 * The native passkey *login* pair (`/api/auth/native/passkey/…`) is served and
 * is deliberately absent from this list.
 */
const BROWSER_ONLY_BEARER_PATH_PREFIXES: ReadonlyArray<string> = [
  "/api/auth/native/bootstrap/registration/",
  "/api/auth/native/invitations/registration/",
];

/**
 * Matched case-insensitively so a differently-cased path cannot slip past the
 * guard. Percent-encoded pathnames are rejected outright by `#request` before
 * this runs, so an encoded separator cannot evade the prefix comparison either.
 */
function isBrowserOnlyPath(pathname: string): boolean {
  const normalized = pathname.toLowerCase();
  return BROWSER_ONLY_BEARER_PATH_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

/**
 * Which account operation a request belongs to.
 *
 * The Hub's error body is **only** `{ error: <code> }` — the precise reason is
 * recorded in its audit log and never put on the wire. So a bare `forbidden` or
 * `conflict` is not self-describing, and the only thing that makes it
 * actionable is knowing which route produced it. Each of these intents narrows a
 * generic code to exactly one meaning on that route; the narrowing is read off
 * the Hub's error paths, not guessed.
 */
export type HostedAccountIntent =
  | "set-password"
  | "remove-password"
  | "begin-totp-enrollment"
  | "confirm-totp-enrollment"
  | "revoke-totp"
  | "request-email-verification"
  | "revoke-passkey"
  | "add-passkey"
  | "regenerate-recovery-codes"
  | "connect-external-identity"
  | "disconnect-external-identity";

/**
 * The operations where a `403` is *most likely* the fallback-session step-up
 * gate — and where nothing else on the route is known to raise one.
 *
 * On these routes the step-up gate is the only `forbidden` this client can
 * account for: a session minted from a password, recovery code, or email link
 * that did not present a valid current TOTP code where TOTP is enrolled. The
 * owner-role check that also raises `forbidden` guards the admin routes, not
 * these.
 *
 * **This remains an inference.** See {@link narrowCode}.
 */
const STEP_UP_INTENTS: ReadonlySet<HostedAccountIntent> = new Set([
  "set-password",
  "remove-password",
  "revoke-totp",
  "request-email-verification",
  "add-passkey",
  "regenerate-recovery-codes",
  "connect-external-identity",
  "disconnect-external-identity",
]);

/** The operations where a `403` is most likely "this needs a passkey session". */
const PASSKEY_SESSION_INTENTS: ReadonlySet<HostedAccountIntent> = new Set([
  "begin-totp-enrollment",
  "confirm-totp-enrollment",
]);

/** A step-up is required but was not satisfied. Distinguishable, and actionable. */
export const STEP_UP_REQUIRED_CODE = "step_up_required";

/** The action requires a passkey-authenticated session, not a fallback one. */
export const PASSKEY_SESSION_REQUIRED_CODE = "passkey_session_required";

/**
 * The narrowed code, and whether narrowing actually happened.
 *
 * `wire` is always what the Hub sent, verbatim (bounded by
 * {@link ERROR_CODE_PATTERN}). `code` is what a surface should act on. They
 * differ only when `inferred` is `true`.
 */
interface NarrowedCode {
  readonly code: string;
  readonly wire: string;
  readonly inferred: boolean;
}

/**
 * Narrow a wire code to what it most likely means on the route that produced it.
 *
 * **This is an inference, not a contract, and a caller must not treat the
 * narrowed code as authoritative.**
 *
 * The Hub's error body is only `{ error: <code> }`. It does have a precise
 * reason for each refusal, but that reason is recorded in its audit log and is
 * deliberately never put on the wire, so `step_up_required` and
 * `passkey_session_required` are codes this client *synthesises* — the Hub
 * never sends either. Without the narrowing a user who simply needs to type a
 * TOTP code is told "You are not authorized to perform this action.", which is
 * useless, so the narrowing earns its place. But it is a guess about which of
 * several possible `forbidden` producers applied, and today it is only correct
 * because these routes happen to have exactly one:
 *
 * - a role or lockout check added to any of these routes later,
 * - an operator disabling an account mid-session,
 * - a reverse proxy, WAF, or gateway answering `403 {"error":"forbidden"}`,
 *
 * would each render a TOTP prompt that can never succeed while the real cause
 * is never surfaced. So the narrowing is deliberately *reported* rather than
 * hidden: {@link HostedHubApiError.wireCode} keeps the code the Hub actually
 * sent and {@link HostedHubApiError.inferred} marks the substitution, and both
 * ride the account-action outcome. A surface that renders a step-up prompt off
 * an inferred code must leave the user a way out (dismiss, retry, sign out) and
 * must not loop on a repeated refusal.
 *
 * It is also applied no more widely than the gate it models: narrowing is
 * suppressed on request legs where the Hub has no step-up gate at all — the
 * add-passkey *options* leg, where a `forbidden` cannot be a step-up and
 * calling it one would be pure fabrication.
 *
 * Returns the code unchanged when there is nothing to narrow.
 */
function narrowCode(
  code: string,
  intent: HostedAccountIntent | undefined,
  narrowing: boolean,
): NarrowedCode {
  const unchanged: NarrowedCode = { code, wire: code, inferred: false };
  if (!narrowing || code !== "forbidden" || intent === undefined) return unchanged;
  if (STEP_UP_INTENTS.has(intent)) {
    return { code: STEP_UP_REQUIRED_CODE, wire: code, inferred: true };
  }
  if (PASSKEY_SESSION_INTENTS.has(intent)) {
    return { code: PASSKEY_SESSION_REQUIRED_CODE, wire: code, inferred: true };
  }
  return unchanged;
}

export class HostedHubApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryAfterMs: number | undefined;
  /** The account operation this error came from, when it had one. */
  readonly intent: HostedAccountIntent | undefined;
  /**
   * The code exactly as the Hub sent it, before any route narrowing. Equal to
   * {@link code} unless {@link inferred} is `true`.
   */
  readonly wireCode: string;
  /**
   * `true` when {@link code} was synthesised client-side by {@link narrowCode}
   * rather than received. A security branch may act on an inferred code, but it
   * must not present it as the Hub's own answer, and it must stay escapable —
   * see {@link narrowCode}.
   */
  readonly inferred: boolean;
  /** A bounded client-known cause; never populated from provider or server detail. */
  readonly reason: HostedHubFailureReason | null;

  constructor(
    code: string,
    status: number,
    retryAfterMs?: number,
    intent?: HostedAccountIntent,
    wireCode?: string,
    reason?: HostedHubFailureReason,
  ) {
    super(reason ? hostedHubFailureExplanation(reason).message : messageForCode(code, intent));
    this.name = "HostedHubApiError";
    this.code = code;
    this.status = status;
    this.retryAfterMs = retryAfterMs;
    this.intent = intent;
    this.wireCode = wireCode ?? code;
    this.inferred = wireCode !== undefined && wireCode !== code;
    this.reason = reason ?? null;
  }
}

export type HostedHubFailureReason =
  | "missing-signer"
  | "missing-token"
  | "proof-signing-failed"
  | "token-invalidated"
  | "request-timeout"
  | "transport-unavailable";

export type HostedHubFailureRecovery = "retry" | "sign-in" | "restart-app";

export interface HostedHubFailureExplanation {
  readonly reason: HostedHubFailureReason;
  readonly title: string;
  readonly message: string;
  readonly recovery: HostedHubFailureRecovery;
}

const HOSTED_HUB_FAILURE_EXPLANATIONS: Readonly<
  Record<HostedHubFailureReason, HostedHubFailureExplanation>
> = {
  "missing-signer": {
    reason: "missing-signer",
    title: "Secure session unavailable",
    message:
      "Secure session signing is unavailable on this device. Restart the app, then try again.",
    recovery: "restart-app",
  },
  "missing-token": {
    reason: "missing-token",
    title: "Sign in again",
    message: "This device no longer has its secure Hub session. Sign in again to continue.",
    recovery: "sign-in",
  },
  "proof-signing-failed": {
    reason: "proof-signing-failed",
    title: "Secure session could not be verified",
    message:
      "This device could not verify its secure Hub session. Unlock the device and try again; if it continues, sign in again.",
    recovery: "retry",
  },
  "token-invalidated": {
    reason: "token-invalidated",
    title: "Session no longer valid",
    message: "Your secure Hub session is no longer valid. Sign in again to continue.",
    recovery: "sign-in",
  },
  "request-timeout": {
    reason: "request-timeout",
    title: "Hub did not respond",
    message: "The Hub did not respond in time. Check your connection and try again.",
    recovery: "retry",
  },
  "transport-unavailable": {
    reason: "transport-unavailable",
    title: "Hub could not be reached",
    message: "Ryco could not reach the Hub. Check your connection and try again.",
    recovery: "retry",
  },
};

export function hostedHubFailureExplanation(
  reason: HostedHubFailureReason,
): HostedHubFailureExplanation {
  return HOSTED_HUB_FAILURE_EXPLANATIONS[reason];
}

/**
 * Route-scoped messages for the codes whose generic text would be actively
 * misleading. Each mapping corresponds to exactly one Hub error path on that
 * route, so none of these is a guess about which of several causes applied.
 */
function intentMessage(code: string, intent: HostedAccountIntent): string | null {
  if (code === "conflict") {
    switch (intent) {
      case "set-password":
        return "That password has appeared in a known breach. Choose a different one.";
      case "revoke-passkey":
        return "That is the only passkey left on this account. Add another before removing it.";
      case "begin-totp-enrollment":
        return "Two-factor authentication is already set up on this account.";
      case "confirm-totp-enrollment":
        return "This setup is no longer in progress. Start again.";
      case "request-email-verification":
        return "That email address is already in use.";
      case "disconnect-external-identity":
        return "GitHub is the only sign-in method on this account. Add another before disconnecting it.";
      default:
        return null;
    }
  }
  if (code === "authentication_failed" && intent === "confirm-totp-enrollment") {
    // The generic text names a passkey; this route only ever rejects a code.
    return "That code is not correct. Check your authenticator app and try again.";
  }
  if (
    code === "authentication_failed" &&
    (intent === "connect-external-identity" || intent === "disconnect-external-identity")
  ) {
    return "That code is not correct. Check your authenticator app and try again.";
  }
  if (code === "not_found" && intent === "revoke-passkey") {
    return "That passkey is no longer on this account.";
  }
  return null;
}

function messageForCode(code: string, intent?: HostedAccountIntent): string {
  const scoped = intent === undefined ? null : intentMessage(code, intent);
  if (scoped !== null) return scoped;
  switch (code) {
    case STEP_UP_REQUIRED_CODE:
      return "Enter a current code from your authenticator app to confirm this change.";
    case PASSKEY_SESSION_REQUIRED_CODE:
      return "Sign in with a passkey on this device to change two-factor settings.";
    case "invalid_credential_id":
      return "That passkey could not be identified.";
    case "external_provider_unavailable":
      return "GitHub sign-in is temporarily unavailable.";
    case "external_authorization_cancelled":
      return "GitHub authorization was cancelled.";
    case "external_authorization_expired":
      return "GitHub authorization expired. Try again.";
    case "external_authorization_rejected":
      return "GitHub could not authorize this request.";
    case "external_identity_already_linked":
      return "That GitHub account is already connected.";
    case "external_identity_email_conflict":
      return "Sign in another way, then connect GitHub from account settings.";
    case "external_identity_verified_email_required":
      return "GitHub must have a verified primary email to create an account.";
    case "signup_disabled":
      return "New account signup is currently closed.";
    case "username_unavailable":
      return "That username is unavailable.";
    case "last_primary_credential":
      return "Add another sign-in method before disconnecting GitHub.";
    case "native_authorization_unavailable":
      return "Secure browser authorization is unavailable on this device.";
    case "timeout":
      return "The request took too long. Check your connection and try again.";
    case "authentication_failed":
      return "The passkey could not be verified.";
    case "registration_unavailable":
      return "The invitation or registration challenge is unavailable or expired.";
    case "session_invalid":
    case "unauthorized":
      return "Your Hub session has expired.";
    case "csrf_rejected":
      return "The request could not be verified. Refresh and try again.";
    case "forbidden":
    case "authorization_failed":
      return "You are not authorized to perform this action.";
    case "not_found":
      return "The requested item is no longer available.";
    case "conflict":
    case "ticket_consumed":
      return "The request has already been used.";
    case "rate_limited":
    case "node_rate_limited":
      return "Too many attempts. Wait briefly and try again.";
    case "enrollment_unavailable":
      return "The node enrollment is unavailable or expired.";
    case "node_offline":
      return "The selected node is offline.";
    case "server_draining":
      return "Hub is temporarily draining relay connections.";
    case "unsupported_version":
      return "The selected node or Hub uses an incompatible relay version.";
    case "invalid_request":
      return "The response was malformed or expired.";
    case "browser_only_transport":
      return "This action is only available in a browser.";
    case "native_only_transport":
      return "This action is only available in the native app.";
    default:
      return "Hub is temporarily unavailable.";
  }
}

function objectValue(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new HostedHubApiError("invalid_response", 502);
  }
  return value as Record<string, unknown>;
}

function decodeContract<S extends Schema.Top>(
  schema: S,
  value: unknown,
  failure: "invalid_request" | "invalid_response",
): S["Type"] {
  try {
    return Schema.decodeUnknownSync(schema as unknown as Schema.Decoder<unknown>)(value, {
      onExcessProperty: "error",
    }) as S["Type"];
  } catch {
    throw new HostedHubApiError(failure, failure === "invalid_request" ? 400 : 502);
  }
}

function e2eeAccountIdValue(value: unknown): string {
  if (typeof value !== "string") {
    throw new HostedHubApiError("invalid_response", 502);
  }
  try {
    return assertE2eeAccountId(value);
  } catch {
    throw new HostedHubApiError("invalid_response", 502);
  }
}

function nullableNumber(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isSafeInteger(value));
}

function roleValue(value: unknown): value is "viewer" | "operator" | "owner" {
  return value === "viewer" || value === "operator" || value === "owner";
}

function platformOsValue(value: unknown): value is "darwin" | "linux" | "windows" | "unknown" {
  return value === "darwin" || value === "linux" || value === "windows" || value === "unknown";
}

function platformArchValue(value: unknown): value is "arm64" | "x64" | "other" {
  return value === "arm64" || value === "x64" || value === "other";
}

/** The bounded native session token, or `null` when the value is not one. */
function bearerTokenValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_BEARER_TOKEN_LENGTH
    ? value
    : null;
}

/**
 * A recovery-code list, or `null` when the value is not one.
 *
 * Deliberately unbounded: this runs on the pre-existing sign-in, bootstrap,
 * invitation and restore paths, where the Hub's real code count and code length
 * are not known. A mis-guessed cap here would reject a legitimate response —
 * and on bootstrap that happens *after* the account already exists server-side,
 * stranding the user. Bounds belong on the newly added route only, where a
 * rejection costs nothing but a retry; see {@link boundedRecoveryCodesValue}.
 */
function recoveryCodesValue(value: unknown): ReadonlyArray<string> | null {
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) return null;
  return value as ReadonlyArray<string>;
}

/** The bounded form required of the newly added recovery-code route. */
function boundedRecoveryCodesValue(value: unknown): ReadonlyArray<string> | null {
  const codes = recoveryCodesValue(value);
  if (!codes || codes.length === 0 || codes.length > MAX_RECOVERY_CODES) return null;
  return codes.some((code) => code.length === 0 || code.length > MAX_RECOVERY_CODE_LENGTH)
    ? null
    : codes;
}

/**
 * Project a Hub passkey record onto the bounded {@link HostedHubPasskey} view,
 * or `null` when it is not one. Only the known members are copied, so no
 * unexpected Hub metadata can reach a view model, and each is bounded or typed
 * independently: a member the Hub omits — or returns in a shape this client does
 * not recognise — becomes `null` rather than rejecting the whole record, so one
 * unfamiliar field cannot blank a list the user needs in order to revoke.
 *
 * Callers choose the strictness of the *identity* check: `listPasskeys` rejects
 * an entry with no usable id, while the add-passkey verify (whose body is not
 * required to describe the credential at all) tolerates its absence.
 */
function passkeyValue(value: unknown): HostedHubPasskey | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.id !== "string" || !CREDENTIAL_ID_PATTERN.test(record.id)) return null;
  return {
    id: record.id,
    label:
      typeof record.label === "string" && record.label.length <= MAX_PASSKEY_LABEL_LENGTH
        ? record.label
        : null,
    createdAt: nullableNumber(record.createdAt) ? record.createdAt : null,
    lastUsedAt: nullableNumber(record.lastUsedAt) ? record.lastUsedAt : null,
    backupEligible: typeof record.backupEligible === "boolean" ? record.backupEligible : null,
    backupState: typeof record.backupState === "boolean" ? record.backupState : null,
    revokedAt: nullableNumber(record.revokedAt) ? record.revokedAt : null,
    revocationReasonCode:
      typeof record.revocationReasonCode === "string" &&
      record.revocationReasonCode.length > 0 &&
      record.revocationReasonCode.length <= MAX_REVOCATION_REASON_LENGTH
        ? record.revocationReasonCode
        : null,
  };
}

/**
 * Strictly decode the authenticated account-security self-read.
 *
 * Unlike the passkey projection, this response is an exact, tiny contract. An
 * unexpected member is rejected rather than silently carried forward so Hub
 * credential metadata can never reach a surface by accident.
 */
function accountSecurityValue(value: unknown): HostedAccountSecurity | null {
  try {
    return Schema.decodeUnknownSync(
      HostedIdentity.HostedAccountSecurityResponse as unknown as Schema.Decoder<HostedAccountSecurity>,
    )(value, { onExcessProperty: "error" });
  } catch {
    return null;
  }
}

/**
 * The optional fallback-session step-up code.
 *
 * A session minted from a password, a recovery code, or an email recovery link
 * must present a current TOTP code to change credentials wherever TOTP is
 * enrolled. A **passkey session ignores it entirely**, and the Hub — not this
 * client — is what decides which of those applies. The client's only job is to
 * pass a code through when the caller has one, and to never present a fallback
 * session as though it were equivalent to a passkey one.
 */
export interface HostedAccountStepUp {
  readonly totpCode?: string;
}

/**
 * The step-up member of a request body, or nothing.
 *
 * A code that is absent, empty, or only whitespace omits the member entirely.
 * This is **not** because the two outcomes differ at the Hub — they do not: the
 * step-up gate answers "denied" identically for a missing code and a wrong one,
 * so omitting buys no better error. It is because an untouched input field is
 * not a submitted code, and sending `" "` as though it were one turns a user who
 * has not typed anything yet into a failed attempt.
 */
function stepUpBody(input: HostedAccountStepUp | undefined): { readonly totpCode?: string } {
  const totpCode = input?.totpCode;
  if (typeof totpCode !== "string") return {};
  const trimmed = totpCode.trim();
  return trimmed.length > 0 ? { totpCode } : {};
}

function boundedAuthString(value: unknown, maxLength: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new HostedHubApiError("invalid_request", 400);
  }
  return value;
}

function fallbackTotpBody(value: unknown): { readonly totpCode?: string } {
  if (value === undefined || value === null || value === "") return {};
  return { totpCode: boundedAuthString(value, MAX_AUTH_TOTP_LENGTH) };
}

function emailTokenValue(value: unknown): string {
  const token = boundedAuthString(value, 64);
  if (!AUTH_EMAIL_TOKEN_PATTERN.test(token)) {
    throw new HostedHubApiError("invalid_request", 400);
  }
  return token;
}

/** The bounded TOTP enrolment secret, or `null` when the value is not one. */
function totpSecretValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TOTP_SECRET_LENGTH
    ? value
    : null;
}

/** The bounded `otpauth://` provisioning URI, or `null` when the value is not one. */
function totpProvisioningUriValue(value: unknown): string | null {
  return typeof value === "string" &&
    value.length <= MAX_TOTP_PROVISIONING_URI_LENGTH &&
    value.toLowerCase().startsWith(TOTP_PROVISIONING_URI_SCHEME)
    ? value
    : null;
}

/**
 * The Hub's error codes are short snake_case tokens. Anything else is not a code
 * this client knows how to act on, and an unbounded string from a malformed or
 * hostile response has no business becoming an error `code` that a surface may
 * switch on or render.
 */
const ERROR_CODE_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

function errorCodeValue(value: unknown): string {
  return typeof value === "string" && ERROR_CODE_PATTERN.test(value) ? value : "unavailable";
}

async function responseJson(
  response: {
    readonly ok: boolean;
    readonly status: number;
    readonly json: () => Promise<unknown>;
  },
  intent: HostedAccountIntent | undefined,
  narrowing: boolean,
): Promise<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    throw new HostedHubApiError("invalid_response", response.status, undefined, intent);
  }
  const body = objectValue(parsed);
  if (!response.ok) {
    const retryAfterMs =
      typeof body.retryAfterMs === "number" &&
      Number.isSafeInteger(body.retryAfterMs) &&
      body.retryAfterMs >= 0 &&
      body.retryAfterMs <= 300_000
        ? body.retryAfterMs
        : undefined;
    const narrowed = narrowCode(errorCodeValue(body.error), intent, narrowing);
    throw new HostedHubApiError(
      narrowed.code,
      response.status,
      retryAfterMs,
      intent,
      narrowed.wire,
    );
  }
  return body;
}

export interface HostedHubApiDependencies {
  readonly endpoint: EndpointService;
  readonly httpClient: HttpClientService;
  readonly passkeyCeremony: PasskeyCeremonyService;
  readonly sessionCredentials: SessionCredentialsService;
  /** Required when `sessionCredentials.mode` is `"bearer"`; unused in cookie mode. */
  readonly dpopSigner?: DpopSignerService;
  /** Preferred bearer sign-in path for dynamic/self-hosted Hub domains. */
  readonly nativeAuthorization?: NativeAuthorizationService;
}

interface PendingNativeExternalIdentityConnection {
  readonly provider: HostedIdentity.ExternalIdentityProvider;
  readonly request: NativeHandoffConnectRedeemRequestType;
  readonly expiresAt: number;
}

export class HostedHubApi {
  readonly #endpoint: EndpointService;
  readonly #httpClient: HttpClientService;
  readonly #passkeyCeremony: PasskeyCeremonyService;
  readonly #sessionCredentials: SessionCredentialsService;
  readonly #dpopSigner: DpopSignerService | undefined;
  readonly #nativeAuthorization: NativeAuthorizationService | undefined;
  #pendingNativeExternalIdentityConnection: PendingNativeExternalIdentityConnection | null = null;

  constructor(dependencies: HostedHubApiDependencies) {
    this.#endpoint = dependencies.endpoint;
    this.#httpClient = dependencies.httpClient;
    this.#passkeyCeremony = dependencies.passkeyCeremony;
    this.#sessionCredentials = dependencies.sessionCredentials;
    this.#dpopSigner = dependencies.dpopSigner;
    this.#nativeAuthorization = dependencies.nativeAuthorization;
    if (this.#sessionCredentials.mode === "bearer") {
      // Fail closed: a bearer (native) session cannot be presented without a
      // DPoP signer and a token holder, so a misconfigured adapter must not
      // silently fall back to an unauthenticated or cross-transport request.
      if (!this.#dpopSigner) {
        throw new HostedHubApiError(
          "native_session_unavailable",
          0,
          undefined,
          undefined,
          undefined,
          "missing-signer",
        );
      }
      if (!this.#sessionCredentials.readBearerToken || !this.#sessionCredentials.writeBearerToken) {
        throw new HostedHubApiError(
          "native_session_unavailable",
          0,
          undefined,
          undefined,
          undefined,
          "missing-token",
        );
      }
    }
  }

  get #isBearer(): boolean {
    return this.#sessionCredentials.mode === "bearer";
  }

  #readBearerToken(): string | null {
    return this.#sessionCredentials.readBearerToken?.() ?? null;
  }

  #writeBearerToken(token: string | null): void {
    this.#sessionCredentials.writeBearerToken?.(token);
  }

  get hasSessionMaterial(): boolean {
    return this.#isBearer
      ? this.#readBearerToken() !== null
      : this.#sessionCredentials.readCsrfToken() !== null;
  }

  clearSessionMaterial(): void {
    this.#pendingNativeExternalIdentityConnection = null;
    if (this.#isBearer) this.#writeBearerToken(null);
    else this.#sessionCredentials.writeCsrfToken(null);
  }

  async getBootstrapAvailability(signal?: AbortSignal): Promise<boolean> {
    const result = await this.#request("/api/auth/bootstrap-status", {
      dpop: "mint",
      ...(signal ? { signal } : {}),
    });
    if (Object.keys(result).length !== 1 || typeof result.available !== "boolean") {
      throw new HostedHubApiError("invalid_response", 502);
    }
    return result.available;
  }

  async getPublicSignupConfiguration(
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PublicSignupConfigResponse> {
    this.#requireCookieTransport();
    return decodeContract(
      HostedIdentity.PublicSignupConfigResponse,
      await this.#request(HostedIdentity.PUBLIC_SIGNUP_CONFIG_PATH, signal ? { signal } : {}),
      "invalid_response",
    );
  }

  async getExternalIdentityConfiguration(
    signal?: AbortSignal,
  ): Promise<HostedIdentity.ExternalIdentityConfigResponse> {
    return decodeContract(
      HostedIdentity.ExternalIdentityConfigResponse,
      await this.#request(HostedIdentity.EXTERNAL_IDENTITY_CONFIG_PATH, {
        ...(this.#isBearer ? { dpop: "mint" as const } : {}),
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async startExternalIdentityAuthorization(
    request: HostedIdentity.ExternalIdentityAuthorizationStartRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.ExternalIdentityAuthorizationStartResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.ExternalIdentityAuthorizationStartRequest,
      request,
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.ExternalIdentityAuthorizationStartResponse,
      await this.#request(HostedIdentity.EXTERNAL_IDENTITY_START_PATH, {
        method: "POST",
        body,
        ...(body.intent === "link"
          ? { csrf: true, intent: "connect-external-identity" as const }
          : {}),
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async getPendingExternalIdentity(
    signal?: AbortSignal,
  ): Promise<HostedIdentity.ExternalIdentityPendingResponse> {
    this.#requireCookieTransport();
    return decodeContract(
      HostedIdentity.ExternalIdentityPendingResponse,
      await this.#request(HostedIdentity.EXTERNAL_IDENTITY_PENDING_PATH, signal ? { signal } : {}),
      "invalid_response",
    );
  }

  async finishExternalIdentitySignup(
    request: HostedIdentity.ExternalIdentitySignupFinishRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.ExternalIdentitySignupFinishResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.ExternalIdentitySignupFinishRequest,
      request,
      "invalid_request",
    );
    const result = decodeContract(
      HostedIdentity.ExternalIdentitySignupFinishResponse,
      await this.#request(HostedIdentity.EXTERNAL_IDENTITY_SIGNUP_FINISH_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
    this.#sessionCredentials.writeCsrfToken(result.identity.csrfToken);
    return result;
  }

  async restoreSession(signal?: AbortSignal): Promise<HostedHubSessionResponse> {
    const value = await this.#request("/api/auth/session", signal ? { signal } : {});
    if (this.#isBearer) return this.#restoreNativeSession(value);
    const result = this.#sessionResponse(value);
    this.#sessionCredentials.writeCsrfToken(result.csrfToken);
    return result;
  }

  async signIn(signal?: AbortSignal): Promise<HostedHubSessionResponse> {
    if (this.#isBearer && this.#nativeAuthorization) {
      const redeemed = await runNativeHandoff({
        origin: this.#endpoint.origin(),
        platform: this.#nativeAuthorization,
        ...(signal ? { signal } : {}),
        start: (request, handoffSignal) =>
          this.#startNativeHandoff(request, handoffSignal) as Promise<unknown>,
        redeem: (request, handoffSignal) =>
          this.#redeemNativeHandoff(request, handoffSignal) as Promise<unknown>,
      });
      // `runNativeHandoff` validates the full contract and fences stale browser
      // results before returning. Re-project the account/session through the
      // long-standing runtime codec, then persist the token last.
      const response = this.#accountAndSession(redeemed as unknown as Record<string, unknown>);
      this.#writeBearerToken(redeemed.token);
      return response;
    }
    const base = this.#isBearer ? "/api/auth/native/passkey" : "/api/auth/passkey";
    const options = await this.#request(`${base}/options`, {
      method: "POST",
      body: {},
      dpop: "mint",
      ...(signal ? { signal } : {}),
    });
    const response = await this.#passkeyCeremony.authenticate(
      validatePasskeyAuthenticationOptions(options.options),
      signal,
    );
    return this.#finishLogin(
      await this.#request(`${base}/verify`, {
        method: "POST",
        body: { response },
        dpop: "mint",
        ...(signal ? { signal } : {}),
      }),
    );
  }

  async signInWithExternalProvider(
    provider: HostedIdentity.ExternalIdentityProvider,
    signal?: AbortSignal,
  ): Promise<HostedHubSessionResponse> {
    this.#requireBearerTransport();
    const boundedProvider = decodeContract(
      HostedIdentity.ExternalIdentityProvider,
      provider,
      "invalid_request",
    );
    const platform = this.#nativeAuthorization;
    if (!platform) throw new HostedHubApiError("native_authorization_unavailable", 400);
    const redeemed = await runTypedNativeHandoff({
      origin: this.#endpoint.origin(),
      platform,
      purpose: { kind: "sign_in", providerHint: boundedProvider },
      redeemRequestSchema: NativeHandoffRedeemRequest,
      redeemResponseSchema: NativeHandoffRedeemResponse,
      buildRedeemRequest: (base) => base,
      ...(signal ? { signal } : {}),
      start: (request, handoffSignal) =>
        this.#startNativeHandoff(request, handoffSignal) as Promise<unknown>,
      redeem: (request, handoffSignal) =>
        this.#redeemNativeHandoff(request, handoffSignal) as Promise<unknown>,
    });
    const response = this.#accountAndSession(redeemed as unknown as Record<string, unknown>);
    this.#writeBearerToken(redeemed.token);
    return response;
  }

  async connectExternalIdentity(
    provider: HostedIdentity.ExternalIdentityProvider,
    input?: HostedAccountStepUp,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.ExternalIdentitySummary> {
    this.#requireBearerTransport();
    const boundedProvider = decodeContract(
      HostedIdentity.ExternalIdentityProvider,
      provider,
      "invalid_request",
    );
    const platform = this.#nativeAuthorization;
    if (!platform) throw new HostedHubApiError("native_authorization_unavailable", 400);

    const pending = this.#pendingNativeExternalIdentityConnection;
    if (pending && pending.expiresAt < Date.now()) {
      this.#pendingNativeExternalIdentityConnection = null;
    } else if (pending?.provider === boundedProvider) {
      const request = decodeContract(
        NativeHandoffConnectRedeemRequest,
        { ...pending.request, ...stepUpBody(input) },
        "invalid_request",
      );
      try {
        const result = await this.#redeemNativeExternalIdentity(request, signal);
        this.#pendingNativeExternalIdentityConnection = null;
        return result.externalIdentity;
      } catch (error) {
        if (!this.#retainsPendingExternalIdentityConnection(error)) {
          this.#pendingNativeExternalIdentityConnection = null;
        }
        throw error;
      }
    }

    let capturedRequest: NativeHandoffConnectRedeemRequestType | null = null;
    try {
      const result = await runTypedNativeHandoff({
        origin: this.#endpoint.origin(),
        coordinatorKey: `${this.#endpoint.origin()}:connect:${boundedProvider}`,
        platform,
        purpose: { kind: "connect_external_identity", provider: boundedProvider },
        redeemRequestSchema: NativeHandoffConnectRedeemRequest,
        redeemResponseSchema: NativeHandoffConnectRedeemResponse,
        buildRedeemRequest: (base) => ({
          ...base,
          purpose: { kind: "connect_external_identity" as const, provider: boundedProvider },
          ...stepUpBody(input),
        }),
        ...(signal ? { signal } : {}),
        start: (request, handoffSignal) =>
          this.#startNativeHandoff(request, handoffSignal) as Promise<unknown>,
        redeem: (request, handoffSignal) => {
          capturedRequest = request;
          return this.#redeemNativeExternalIdentity(request, handoffSignal) as Promise<unknown>;
        },
      });
      return result.externalIdentity;
    } catch (error) {
      if (capturedRequest && this.#retainsPendingExternalIdentityConnection(error)) {
        this.#pendingNativeExternalIdentityConnection = {
          provider: boundedProvider,
          request: capturedRequest,
          expiresAt: Date.now() + NATIVE_HANDOFF_CODE_LIFETIME_MS,
        };
      }
      throw error;
    }
  }

  /** Discard a staged native provider result after the user abandons step-up. */
  cancelExternalIdentityConnection(provider: HostedIdentity.ExternalIdentityProvider): void {
    const boundedProvider = decodeContract(
      HostedIdentity.ExternalIdentityProvider,
      provider,
      "invalid_request",
    );
    if (this.#pendingNativeExternalIdentityConnection?.provider === boundedProvider) {
      this.#pendingNativeExternalIdentityConnection = null;
    }
  }

  /**
   * Identifierless passkey login for a native identity surface. Unlike
   * `signIn()`, this never opens the compatibility system-browser handoff.
   */
  async signInWithNativePasskey(signal?: AbortSignal): Promise<{
    readonly session: HostedHubSessionResponse;
    readonly token: string;
  }> {
    this.#requireBearerTransport();
    const base = "/api/auth/native/passkey";
    const options = await this.#request(`${base}/options`, {
      method: "POST",
      body: {},
      dpop: "mint",
      ...(signal ? { signal } : {}),
    });
    const response = await this.#passkeyCeremony.authenticate(
      validatePasskeyAuthenticationOptions(options.options),
      signal,
    );
    const verified = await this.#request(`${base}/verify`, {
      method: "POST",
      body: { response },
      dpop: "mint",
      ...(signal ? { signal } : {}),
    });
    const result = this.#nativeSessionResponse(verified);
    // The full-screen native identity surface owns the durable commit. Do not
    // publish the token through the synchronous session holder first: doing so
    // would let a failed secure-store write unlock this launch (or a delayed
    // best-effort mirror unlock the next one) before durability is proven.
    return { session: result.response, token: result.token };
  }

  async startPublicSignup(
    request: HostedIdentity.PublicSignupStartRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PublicSignupStartResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.PublicSignupStartRequest,
      request,
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.PublicSignupStartResponse,
      await this.#request(HostedIdentity.PUBLIC_SIGNUP_START_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async verifyPublicSignup(
    request: HostedIdentity.PublicSignupVerifyRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PublicSignupVerifyResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.PublicSignupVerifyRequest,
      request,
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.PublicSignupVerifyResponse,
      await this.#request(HostedIdentity.PUBLIC_SIGNUP_VERIFY_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async finishPublicSignupWithPasskey(
    request: HostedIdentity.PublicSignupPasskeyOptionsRequest & {
      readonly idempotencyKey: HostedIdentity.PublicSignupPasskeyFinishRequest["idempotencyKey"];
    },
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PublicSignupFinishResponse> {
    this.#requireCookieTransport();
    // Validate every caller-controlled member before network I/O or a platform
    // passkey prompt. `response` is `Unknown` by contract and is replaced only
    // after the ceremony returns.
    const boundedRequest = decodeContract(
      HostedIdentity.PublicSignupPasskeyFinishRequest,
      { ...request, response: {} },
      "invalid_request",
    );
    const activation = decodeContract(
      HostedIdentity.PublicSignupPasskeyOptionsRequest,
      {
        attemptId: boundedRequest.attemptId,
        activationSecret: boundedRequest.activationSecret,
      },
      "invalid_request",
    );
    const options = decodeContract(
      HostedIdentity.PublicSignupPasskeyOptionsResponse,
      await this.#request(HostedIdentity.PUBLIC_SIGNUP_PASSKEY_OPTIONS_PATH, {
        method: "POST",
        body: activation,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
    const response = await this.#passkeyCeremony.register(
      validatePasskeyRegistrationOptions(options.options),
      signal,
    );
    const body = decodeContract(
      HostedIdentity.PublicSignupPasskeyFinishRequest,
      { ...boundedRequest, response },
      "invalid_request",
    );
    const result = decodeContract(
      HostedIdentity.PublicSignupFinishResponse,
      await this.#request(HostedIdentity.PUBLIC_SIGNUP_PASSKEY_FINISH_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
    this.#sessionCredentials.writeCsrfToken(result.identity.csrfToken);
    return result;
  }

  async finishPublicSignupWithPassword(
    request: HostedIdentity.PublicSignupPasswordFinishRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PublicSignupFinishResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.PublicSignupPasswordFinishRequest,
      request,
      "invalid_request",
    );
    const result = decodeContract(
      HostedIdentity.PublicSignupFinishResponse,
      await this.#request(HostedIdentity.PUBLIC_SIGNUP_PASSWORD_FINISH_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
    this.#sessionCredentials.writeCsrfToken(result.identity.csrfToken);
    return result;
  }

  async startPasswordLogin(
    request: HostedIdentity.PasswordLoginStartRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PasswordLoginStartResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.PasswordLoginStartRequest,
      request,
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.PasswordLoginStartResponse,
      await this.#request(HostedIdentity.PASSWORD_LOGIN_START_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async finishPasswordLogin(
    request: HostedIdentity.PasswordLoginFinishRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.HubBrowserSessionResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.PasswordLoginFinishRequest,
      request,
      "invalid_request",
    );
    const result = decodeContract(
      HostedIdentity.HubBrowserSessionResponse,
      await this.#request(HostedIdentity.PASSWORD_LOGIN_FINISH_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
    this.#sessionCredentials.writeCsrfToken(result.csrfToken);
    return result;
  }

  async requestPasswordReset(
    request: HostedIdentity.PasswordResetRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PasswordResetRequestResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(HostedIdentity.PasswordResetRequest, request, "invalid_request");
    return decodeContract(
      HostedIdentity.PasswordResetRequestResponse,
      await this.#request(HostedIdentity.PASSWORD_RESET_REQUEST_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async verifyPasswordReset(
    request: HostedIdentity.PasswordResetVerifyRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PasswordResetVerifyResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.PasswordResetVerifyRequest,
      request,
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.PasswordResetVerifyResponse,
      await this.#request(HostedIdentity.PASSWORD_RESET_VERIFY_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async finishPasswordReset(
    request: HostedIdentity.PasswordResetFinishRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.PasswordResetFinishResponse> {
    this.#requireCookieTransport();
    const body = decodeContract(
      HostedIdentity.PasswordResetFinishRequest,
      request,
      "invalid_request",
    );
    const result = decodeContract(
      HostedIdentity.PasswordResetFinishResponse,
      await this.#request(HostedIdentity.PASSWORD_RESET_FINISH_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
    // Reset revokes every session family and intentionally does not log in.
    this.clearSessionMaterial();
    return result;
  }

  async startNativeIdentityEmail(
    request: HostedIdentity.NativeIdentityEmailStartRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentityEmailStartResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_EMAIL_START_PATH,
      HostedIdentity.NativeIdentityEmailStartRequest,
      HostedIdentity.NativeIdentityEmailStartResponse,
      request,
      signal,
    );
  }

  async verifyNativeIdentityEmail(
    request: HostedIdentity.NativeIdentityEmailVerifyRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentityEmailVerifyResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_EMAIL_VERIFY_PATH,
      HostedIdentity.NativeIdentityEmailVerifyRequest,
      HostedIdentity.NativeIdentityEmailVerifyResponse,
      request,
      signal,
    );
  }

  async claimNativeIdentityUsername(
    request: HostedIdentity.NativeIdentitySignupUsernameRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentitySignupUsernameResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_SIGNUP_USERNAME_PATH,
      HostedIdentity.NativeIdentitySignupUsernameRequest,
      HostedIdentity.NativeIdentitySignupUsernameResponse,
      request,
      signal,
    );
  }

  async finishNativeIdentitySignupWithPasskey(
    request: HostedIdentity.NativeIdentitySignupPasskeyOptionsRequest & {
      readonly idempotencyKey: HostedIdentity.NativeIdentitySignupPasskeyFinishRequest["idempotencyKey"];
    },
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentitySignupFinishResponse> {
    this.#requireBearerTransport();
    const boundedRequest = decodeContract(
      HostedIdentity.NativeIdentitySignupPasskeyFinishRequest,
      { ...request, response: {} },
      "invalid_request",
    );
    const activation = decodeContract(
      HostedIdentity.NativeIdentitySignupPasskeyOptionsRequest,
      {
        attemptId: boundedRequest.attemptId,
        activationSecret: boundedRequest.activationSecret,
      },
      "invalid_request",
    );
    const options = await this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_SIGNUP_PASSKEY_OPTIONS_PATH,
      HostedIdentity.NativeIdentitySignupPasskeyOptionsRequest,
      HostedIdentity.NativeIdentitySignupPasskeyOptionsResponse,
      activation,
      signal,
    );
    const response = await this.#passkeyCeremony.register(
      validatePasskeyRegistrationOptions(options.options),
      signal,
    );
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_SIGNUP_PASSKEY_FINISH_PATH,
      HostedIdentity.NativeIdentitySignupPasskeyFinishRequest,
      HostedIdentity.NativeIdentitySignupFinishResponse,
      { ...boundedRequest, response },
      signal,
    );
  }

  async finishNativeIdentitySignupWithPassword(
    request: HostedIdentity.NativeIdentitySignupPasswordFinishRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentitySignupFinishResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_SIGNUP_PASSWORD_FINISH_PATH,
      HostedIdentity.NativeIdentitySignupPasswordFinishRequest,
      HostedIdentity.NativeIdentitySignupFinishResponse,
      request,
      signal,
    );
  }

  async startNativeIdentityPasswordLogin(
    request: HostedIdentity.NativeIdentityPasswordStartRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentityPasswordStartResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_PASSWORD_START_PATH,
      HostedIdentity.NativeIdentityPasswordStartRequest,
      HostedIdentity.NativeIdentityPasswordStartResponse,
      request,
      signal,
    );
  }

  async finishNativeIdentityPasswordLogin(
    request: HostedIdentity.NativeIdentityPasswordFinishRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentitySessionResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_PASSWORD_FINISH_PATH,
      HostedIdentity.NativeIdentityPasswordFinishRequest,
      HostedIdentity.NativeIdentitySessionResponse,
      request,
      signal,
    );
  }

  async signInNativeIdentityWithRecoveryCode(
    request: HostedIdentity.NativeIdentityRecoveryCodeRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentityRecoveryResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_RECOVERY_CODE_PATH,
      HostedIdentity.NativeIdentityRecoveryCodeRequest,
      HostedIdentity.NativeIdentityRecoveryResponse,
      request,
      signal,
    );
  }

  async requestNativeIdentityPasswordReset(
    request: HostedIdentity.NativeIdentityPasswordResetRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentityPasswordResetResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_PASSWORD_RESET_REQUEST_PATH,
      HostedIdentity.NativeIdentityPasswordResetRequest,
      HostedIdentity.NativeIdentityPasswordResetResponse,
      request,
      signal,
    );
  }

  async verifyNativeIdentityPasswordReset(
    request: HostedIdentity.NativeIdentityPasswordResetVerifyRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentityPasswordResetVerifyResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_PASSWORD_RESET_VERIFY_PATH,
      HostedIdentity.NativeIdentityPasswordResetVerifyRequest,
      HostedIdentity.NativeIdentityPasswordResetVerifyResponse,
      request,
      signal,
    );
  }

  async finishNativeIdentityPasswordReset(
    request: HostedIdentity.NativeIdentityPasswordResetFinishRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentityPasswordResetFinishResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_PASSWORD_RESET_FINISH_PATH,
      HostedIdentity.NativeIdentityPasswordResetFinishRequest,
      HostedIdentity.NativeIdentityPasswordResetFinishResponse,
      request,
      signal,
    );
  }

  async cancelNativeIdentityAttempt(
    request: HostedIdentity.NativeIdentityAttemptCancelRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeIdentityAttemptCancelResponse> {
    return this.#nativeIdentityMutation(
      HostedIdentity.NATIVE_IDENTITY_ATTEMPT_CANCEL_PATH,
      HostedIdentity.NativeIdentityAttemptCancelRequest,
      HostedIdentity.NativeIdentityAttemptCancelResponse,
      request,
      signal,
    );
  }

  async switchActiveSpace(
    request: HostedIdentity.ActiveSpaceSwitchRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.ActiveSpaceSwitchResponse> {
    const body = decodeContract(
      HostedIdentity.ActiveSpaceSwitchRequest,
      request,
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.ActiveSpaceSwitchResponse,
      await this.#request(HostedIdentity.ACTIVE_SPACE_SWITCH_PATH, {
        method: "POST",
        body,
        csrf: true,
        dpop: "session",
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async startNativeNodeClaim(
    request: HostedIdentity.NativeNodeClaimStartRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeNodeClaimStartResponse> {
    this.#requireBearerTransport();
    const body = decodeContract(
      HostedIdentity.NativeNodeClaimStartRequest,
      request,
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.NativeNodeClaimStartResponse,
      await this.#request(HostedIdentity.NATIVE_NODE_CLAIM_START_PATH, {
        method: "POST",
        body,
        dpop: "session",
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async finishNativeNodeClaim(
    request: HostedIdentity.NativeNodeClaimFinishRequest,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.NativeNodeClaimFinishResponse> {
    this.#requireBearerTransport();
    const body = decodeContract(
      HostedIdentity.NativeNodeClaimFinishRequest,
      request,
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.NativeNodeClaimFinishResponse,
      await this.#request(HostedIdentity.NATIVE_NODE_CLAIM_FINISH_PATH, {
        method: "POST",
        body,
        dpop: "session",
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async signInWithPassword(
    input: {
      readonly email: string;
      readonly password: string;
      readonly totpCode?: string;
    },
    signal?: AbortSignal,
  ): Promise<HostedHubSessionResponse> {
    this.#requireCookieTransport();
    return this.#finishLogin(
      await this.#request("/api/auth/password", {
        method: "POST",
        body: {
          email: boundedAuthString(input.email, MAX_AUTH_EMAIL_LENGTH),
          password: boundedAuthString(input.password, MAX_AUTH_PASSWORD_LENGTH),
          ...fallbackTotpBody(input.totpCode),
        },
        ...(signal ? { signal } : {}),
      }),
    );
  }

  async signInWithRecoveryCode(
    code: string,
    signal?: AbortSignal,
  ): Promise<HostedHubSessionResponse> {
    this.#requireCookieTransport();
    return this.#finishLogin(
      await this.#request("/api/auth/recovery", {
        method: "POST",
        body: { code: boundedAuthString(code, MAX_AUTH_RECOVERY_CODE_LENGTH) },
        ...(signal ? { signal } : {}),
      }),
    );
  }

  async requestEmailRecovery(email: string, signal?: AbortSignal): Promise<void> {
    this.#requireCookieTransport();
    const result = await this.#request("/api/auth/recovery/email/request", {
      method: "POST",
      body: { email: boundedAuthString(email, MAX_AUTH_EMAIL_LENGTH) },
      ...(signal ? { signal } : {}),
    });
    if (Object.keys(result).length !== 1 || result.ok !== true) {
      throw new HostedHubApiError("invalid_response", 502);
    }
  }

  async confirmEmailRecovery(
    input: { readonly token: string; readonly totpCode?: string },
    signal?: AbortSignal,
  ): Promise<HostedHubSessionResponse> {
    this.#requireCookieTransport();
    return this.#finishLogin(
      await this.#request("/api/auth/recovery/email/confirm", {
        method: "POST",
        body: {
          token: emailTokenValue(input.token),
          ...fallbackTotpBody(input.totpCode),
        },
        ...(signal ? { signal } : {}),
      }),
    );
  }

  async confirmEmailVerification(token: string, signal?: AbortSignal): Promise<void> {
    this.#requireCookieTransport();
    const result = await this.#request("/api/auth/email/verify", {
      method: "POST",
      body: { token: emailTokenValue(token) },
      ...(signal ? { signal } : {}),
    });
    if (Object.keys(result).length !== 1 || result.ok !== true) {
      throw new HostedHubApiError("invalid_response", 502);
    }
  }

  async startNativeHandoff(
    request: NativeHandoffStartRequestType,
    signal?: AbortSignal,
  ): Promise<NativeHandoffStartResponseType> {
    return this.#startNativeHandoff(request, signal);
  }

  async #startNativeHandoff(
    request: NativeHandoffStartRequestType,
    signal?: AbortSignal,
  ): Promise<NativeHandoffStartResponseType> {
    if (!this.#isBearer) throw new HostedHubApiError("browser_only_transport", 400);
    const body = decodeContract(NativeHandoffStartRequest, request, "invalid_request");
    const isExternalIdentityConnection = body.purpose?.kind === "connect_external_identity";
    return decodeContract(
      NativeHandoffStartResponse,
      await this.#request(NATIVE_HANDOFF_START_PATH, {
        method: "POST",
        body,
        dpop: isExternalIdentityConnection ? "session" : "mint",
        ...(isExternalIdentityConnection ? { intent: "connect-external-identity" as const } : {}),
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async redeemNativeHandoff(
    request: NativeHandoffRedeemRequestType,
    signal?: AbortSignal,
  ): Promise<HostedHubSessionResponse> {
    const redeemed = await this.#redeemNativeHandoff(request, signal);
    const response = this.#accountAndSession(redeemed as unknown as Record<string, unknown>);
    this.#writeBearerToken(redeemed.token);
    return response;
  }

  async #redeemNativeHandoff(
    request: NativeHandoffRedeemRequestType,
    signal?: AbortSignal,
  ): Promise<NativeHandoffRedeemResponseType> {
    if (!this.#isBearer) throw new HostedHubApiError("browser_only_transport", 400);
    const body = decodeContract(NativeHandoffRedeemRequest, request, "invalid_request");
    return decodeContract(
      NativeHandoffRedeemResponse,
      await this.#request(NATIVE_HANDOFF_REDEEM_PATH, {
        method: "POST",
        body,
        dpop: "mint",
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async #redeemNativeExternalIdentity(
    request: NativeHandoffConnectRedeemRequestType,
    signal?: AbortSignal,
  ): Promise<NativeHandoffConnectRedeemResponseType> {
    this.#requireBearerTransport();
    const body = decodeContract(NativeHandoffConnectRedeemRequest, request, "invalid_request");
    return decodeContract(
      NativeHandoffConnectRedeemResponse,
      await this.#request(NATIVE_HANDOFF_REDEEM_PATH, {
        method: "POST",
        body,
        dpop: "session",
        intent: "connect-external-identity",
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  #retainsPendingExternalIdentityConnection(error: unknown): boolean {
    return (
      error instanceof HostedHubApiError &&
      (error.code === STEP_UP_REQUIRED_CODE ||
        error.code === "authentication_failed" ||
        error.code === "forbidden")
    );
  }

  async getNativeHandoffPresentation(
    handoffId: string,
    signal?: AbortSignal,
  ): Promise<NativeHandoffPresentationType> {
    this.#requireCookieTransport();
    const id = decodeContract(NativeHandoffId, handoffId, "invalid_request");
    return decodeContract(
      NativeHandoffPresentation,
      await this.#request(
        `${NATIVE_HANDOFF_PRESENTATION_PATH_PREFIX}${id}`,
        signal ? { signal } : {},
      ),
      "invalid_response",
    );
  }

  async approveNativeHandoff(
    handoffId: string,
    signal?: AbortSignal,
  ): Promise<NativeHandoffApproveResponseType> {
    this.#requireCookieTransport();
    const id = decodeContract(NativeHandoffId, handoffId, "invalid_request");
    return decodeContract(
      NativeHandoffApproveResponse,
      await this.#request(
        `${NATIVE_HANDOFF_PRESENTATION_PATH_PREFIX}${id}${NATIVE_HANDOFF_APPROVE_PATH_SUFFIX}`,
        {
          method: "POST",
          body: {},
          csrf: true,
          ...(signal ? { signal } : {}),
        },
      ),
      "invalid_response",
    );
  }

  async cancelNativeHandoff(
    handoffId: string,
    signal?: AbortSignal,
  ): Promise<NativeHandoffCancelResponseType> {
    this.#requireCookieTransport();
    const id = decodeContract(NativeHandoffId, handoffId, "invalid_request");
    return decodeContract(
      NativeHandoffCancelResponse,
      await this.#request(
        `${NATIVE_HANDOFF_PRESENTATION_PATH_PREFIX}${id}${NATIVE_HANDOFF_CANCEL_PATH_SUFFIX}`,
        {
          method: "POST",
          body: {},
          csrf: true,
          ...(signal ? { signal } : {}),
        },
      ),
      "invalid_response",
    );
  }

  #requireCookieTransport(): void {
    if (this.#isBearer) throw new HostedHubApiError("browser_only_transport", 400);
  }

  #requireBearerTransport(): void {
    if (!this.#isBearer) throw new HostedHubApiError("native_only_transport", 400);
  }

  async #nativeIdentityMutation<
    RequestSchema extends Schema.Top,
    ResponseSchema extends Schema.Top,
  >(
    pathname: string,
    requestSchema: RequestSchema,
    responseSchema: ResponseSchema,
    request: RequestSchema["Type"],
    signal?: AbortSignal,
  ): Promise<ResponseSchema["Type"]> {
    this.#requireBearerTransport();
    const body = decodeContract(requestSchema, request, "invalid_request");
    return decodeContract(
      responseSchema,
      await this.#request(pathname, {
        method: "POST",
        body,
        dpop: "mint",
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async redeemInvitation(
    input: {
      readonly secret: string;
      readonly displayName: string;
      readonly passkeyLabel: string | null;
    },
    signal?: AbortSignal,
  ): Promise<HostedHubSessionResponse> {
    const base = this.#isBearer
      ? "/api/auth/native/invitations/registration"
      : "/api/auth/invitations/registration";
    return this.#registerPasskey(`${base}/options`, `${base}/verify`, input, {
      authenticated: false,
      ...(signal ? { signal } : {}),
      finish: (value) => this.#finishLogin(value),
    });
  }

  async bootstrapOwner(
    input: {
      readonly credential: string;
      readonly displayName: string;
      readonly passkeyLabel: string | null;
    },
    signal?: AbortSignal,
  ): Promise<HostedHubSessionResponse> {
    const base = this.#isBearer
      ? "/api/auth/native/bootstrap/registration"
      : "/api/auth/bootstrap/registration";
    return this.#registerPasskey(`${base}/options`, `${base}/verify`, input, {
      authenticated: false,
      ...(signal ? { signal } : {}),
      finish: (value) => this.#finishLogin(value),
    });
  }

  /**
   * List the passkeys registered against the signed-in account.
   *
   * `GET /api/account/passkeys` → `{ passkeys: [...] }`. Each record
   * is projected through {@link passkeyValue}, so an unexpected member can never
   * reach a view model, and the list itself is bounded.
   *
   * A revoked credential is **not** filtered out here: the Hub reports
   * `revokedAt` / `revocationReasonCode` and the surface needs them to explain
   * why a device the user remembers enrolling no longer works. Deciding what to
   * show is the caller's; hiding evidence of a revocation is not this client's
   * to do.
   */
  async listPasskeys(signal?: AbortSignal): Promise<ReadonlyArray<HostedHubPasskey>> {
    const result = await this.#request("/api/account/passkeys", signal ? { signal } : {});
    if (!Array.isArray(result.passkeys) || result.passkeys.length > MAX_PASSKEYS) {
      throw new HostedHubApiError("invalid_response", 502);
    }
    return result.passkeys.map((value) => {
      const passkey = passkeyValue(value);
      if (!passkey) throw new HostedHubApiError("invalid_response", 502);
      return passkey;
    });
  }

  /**
   * Read the signed-in account's bounded credential posture.
   *
   * `GET /api/account/security` contains no secret material. The user's own
   * email address is PII, so this client validates and returns it but never
   * logs it or includes it in an error.
   */
  async getAccountSecurity(signal?: AbortSignal): Promise<HostedAccountSecurity> {
    const result = accountSecurityValue(
      await this.#request("/api/account/security", signal ? { signal } : {}),
    );
    if (!result) throw new HostedHubApiError("invalid_response", 502);
    return result;
  }

  async finishBrowserExternalIdentityConnection(
    provider: HostedIdentity.ExternalIdentityProvider,
    input?: HostedAccountStepUp,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.BrowserExternalIdentityConnectResponse> {
    this.#requireCookieTransport();
    decodeContract(HostedIdentity.ExternalIdentityProvider, provider, "invalid_request");
    const body = decodeContract(
      HostedIdentity.BrowserExternalIdentityConnectRequest,
      stepUpBody(input),
      "invalid_request",
    );
    return decodeContract(
      HostedIdentity.BrowserExternalIdentityConnectResponse,
      await this.#request(HostedIdentity.GITHUB_EXTERNAL_IDENTITY_CONNECT_PATH, {
        method: "POST",
        body,
        csrf: true,
        intent: "connect-external-identity",
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  async disconnectExternalIdentity(
    provider: HostedIdentity.ExternalIdentityProvider,
    input?: HostedAccountStepUp,
    signal?: AbortSignal,
  ): Promise<HostedIdentity.ExternalIdentityDisconnectResponse> {
    decodeContract(HostedIdentity.ExternalIdentityProvider, provider, "invalid_request");
    const body = decodeContract(
      HostedIdentity.ExternalIdentityDisconnectRequest,
      stepUpBody(input),
      "invalid_request",
    );
    const result = decodeContract(
      HostedIdentity.ExternalIdentityDisconnectResponse,
      await this.#request(HostedIdentity.GITHUB_EXTERNAL_IDENTITY_DISCONNECT_PATH, {
        method: "POST",
        body,
        csrf: true,
        intent: "disconnect-external-identity",
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
    if (result.signedOut) this.clearSessionMaterial();
    return result;
  }

  /**
   * Register an additional passkey on the *already signed-in* account — the
   * "add this device" ceremony. Runs on the existing session (CSRF in cookie
   * mode, `Authorization: DPoP` + an `ath`-bound proof in bearer mode) rather
   * than the pre-session mint used by bootstrap and invitation redemption.
   *
   * `confirmed` reports whether the Hub's verify response positively described
   * the new credential. A non-2xx verify throws, so a resolved call means the
   * Hub accepted the ceremony — but `confirmed: false` means it returned no
   * evidence of what it enrolled, and the caller must confirm against a fresh
   * {@link listPasskeys} read rather than report success on the strength of the
   * ceremony alone.
   *
   * The options body member is `label`, not `passkeyLabel`: the two pre-session
   * ceremonies take `passkeyLabel`, this one does not, and the Hub parses it
   * strictly — an unrecognised member is a `400` before the ceremony starts. A
   * blank label is omitted rather than sent as `""`, which the Hub also rejects.
   *
   * **This route rotates the session** — see {@link #finishRotatedSession}.
   *
   * `totpCode` is the optional fallback-session step-up (see
   * {@link HostedAccountStepUp}); it rides the *verify* call only, never the
   * options call, and is omitted entirely when absent.
   */
  async addPasskey(
    input: { readonly passkeyLabel: string | null } & HostedAccountStepUp,
    signal?: AbortSignal,
  ): Promise<HostedAddPasskeyResult> {
    const label = typeof input.passkeyLabel === "string" ? input.passkeyLabel.trim() : null;
    return this.#registerPasskey(
      "/api/account/passkeys/registration/options",
      "/api/account/passkeys/registration/verify",
      { label: label === null || label.length === 0 ? null : label },
      {
        authenticated: true,
        intent: "add-passkey",
        verifyExtra: stepUpBody(input),
        ...(signal ? { signal } : {}),
        finish: (value) => this.#finishAddPasskey(value),
      },
    );
  }

  /**
   * **Rotate** the account's recovery codes and return the new set.
   *
   * This is a mutation, not a read: it mints a fresh set and invalidates any
   * codes the user previously saved. Run it only from an explicit, confirmed
   * user action — never on mount, focus, retry, or reconnect.
   *
   * **It also rotates the session** — see {@link #finishRotatedSession}.
   *
   * The codes are returned to the caller and never persisted, logged, or placed
   * in an error by this client. Showing them once is the caller's contract; the
   * runtime does not and cannot enforce it.
   */
  async regenerateRecoveryCodes(
    input?: HostedAccountStepUp,
    signal?: AbortSignal,
  ): Promise<ReadonlyArray<string>> {
    const result = await this.#request("/api/account/recovery-codes", {
      method: "POST",
      body: stepUpBody(input),
      csrf: true,
      intent: "regenerate-recovery-codes",
      ...(signal ? { signal } : {}),
    });
    const recoveryCodes = boundedRecoveryCodesValue(result.recoveryCodes);
    if (!recoveryCodes) throw new HostedHubApiError("invalid_response", 502);
    // Adopt the replacement session *after* the payload validates, so a response
    // this client cannot read never displaces working session material.
    this.#finishRotatedSession(result);
    return recoveryCodes;
  }

  /**
   * Set (or replace) the account's fallback password.
   *
   * `POST /api/account/password` → `{ ok: true }`. A password is a **fallback**
   * credential: it is strictly weaker than a passkey, and no surface built on
   * this may present the two as equivalent.
   *
   * The password is sent once, in the request body, and is never persisted,
   * logged, echoed into an error, or placed in a URL by this client.
   */
  async setPassword(
    input: { readonly password: string } & HostedAccountStepUp,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#acknowledgedMutation(
      "/api/account/password",
      { password: input.password, ...stepUpBody(input) },
      signal,
      "set-password",
    );
  }

  /**
   * Remove the account's fallback password, leaving the stronger credentials in
   * place. `POST /api/account/password/remove` → `{ ok: true }`.
   */
  async removePassword(input?: HostedAccountStepUp, signal?: AbortSignal): Promise<void> {
    await this.#acknowledgedMutation(
      "/api/account/password/remove",
      stepUpBody(input),
      signal,
      "remove-password",
    );
  }

  /**
   * Begin TOTP enrolment and return the secret to display once.
   *
   * `POST /api/account/totp/enrollment/options` → `{ secretBase32,
   * provisioningUri }`. **Both members are secret key material** — the base32
   * secret *is* the shared key and the provisioning URI embeds it. They are
   * returned to the caller for the enrolment screen and nothing else: this
   * client never logs, persists, or places either in an error, and a caller must
   * hold them in memory only and drop them the moment the screen is dismissed.
   *
   * Enrolment itself requires a passkey-authenticated session; the Hub enforces
   * that, and this method carries no step-up code because there is no fallback
   * path to step up from.
   */
  async beginTotpEnrollment(signal?: AbortSignal): Promise<HostedTotpEnrollment> {
    const result = await this.#request("/api/account/totp/enrollment/options", {
      method: "POST",
      body: {},
      csrf: true,
      intent: "begin-totp-enrollment",
      ...(signal ? { signal } : {}),
    });
    const secretBase32 = totpSecretValue(result.secretBase32);
    const provisioningUri = totpProvisioningUriValue(result.provisioningUri);
    if (!secretBase32 || !provisioningUri) throw new HostedHubApiError("invalid_response", 502);
    return { secretBase32, provisioningUri };
  }

  /**
   * Confirm TOTP enrolment with a code from the authenticator app.
   * `POST /api/account/totp/enrollment/verify` → `{ ok: true }`.
   *
   * `code` is the enrolment proof, not a step-up: it is required, and it is a
   * distinct member from the optional `totpCode` the fallback-session step-up
   * uses elsewhere.
   */
  async confirmTotpEnrollment(
    input: { readonly code: string },
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#acknowledgedMutation(
      "/api/account/totp/enrollment/verify",
      { code: input.code },
      signal,
      "confirm-totp-enrollment",
    );
  }

  /** Remove TOTP from the account. `POST /api/account/totp/revoke` → `{ ok: true }`. */
  async revokeTotp(input?: HostedAccountStepUp, signal?: AbortSignal): Promise<void> {
    await this.#acknowledgedMutation(
      "/api/account/totp/revoke",
      stepUpBody(input),
      signal,
      "revoke-totp",
    );
  }

  /**
   * Ask the Hub to send a verification mail for an address.
   * `POST /api/account/email/verification` → `{ ok: true }` (202).
   *
   * The 202 is deliberate and uniform: a caller learns that the request was
   * accepted, never whether an address is known. Confirming the mailed token is
   * a browser-transport login route and is not part of this surface.
   */
  async requestEmailVerification(
    input: { readonly email: string } & HostedAccountStepUp,
    signal?: AbortSignal,
  ): Promise<void> {
    await this.#acknowledgedMutation(
      "/api/account/email/verification",
      { email: input.email, ...stepUpBody(input) },
      signal,
      "request-email-verification",
    );
  }

  /**
   * Revoke one of the account's passkeys.
   * `POST /api/account/passkeys/{id}/revoke` → `{ ok: true }`.
   *
   * This is the only account path this client builds by interpolation, so the
   * id is validated against {@link PASSKEY_CREDENTIAL_ID_PATTERN} **before a URL
   * exists** and the call fails closed — no request, no proof minted, no session
   * material touched — on anything that does not match. Validating here rather
   * than trusting the looser list projection means an id that reached a view
   * model through a malformed response still cannot be interpolated into a path.
   *
   * Revoking the credential the current session was minted from is a decision
   * for the caller and the Hub, not something this client second-guesses; the
   * caller should re-read {@link listPasskeys} afterwards, since a revoke
   * changes the list.
   */
  async revokePasskey(credentialId: string, signal?: AbortSignal): Promise<void> {
    if (!PASSKEY_CREDENTIAL_ID_PATTERN.test(credentialId)) {
      // A distinct code: this client refused its own input, so blaming the Hub
      // for a malformed *response* would send a caller looking in the wrong
      // place entirely.
      throw new HostedHubApiError("invalid_credential_id", 400);
    }
    await this.#acknowledgedMutation(
      `/api/account/passkeys/${credentialId}/revoke`,
      {},
      signal,
      "revoke-passkey",
    );
  }

  /**
   * A session-authenticated account mutation whose entire success contract is
   * `{ ok: true }`. Validated exactly, so a body carrying anything else — an
   * error the Hub returned with a 2xx, or session material this route has no
   * business handing over — is a malformed response rather than a success.
   */
  async #acknowledgedMutation(
    pathname: string,
    body: Record<string, unknown>,
    signal: AbortSignal | undefined,
    intent: HostedAccountIntent,
  ): Promise<void> {
    const result = await this.#request(pathname, {
      method: "POST",
      body,
      csrf: true,
      intent,
      ...(signal ? { signal } : {}),
    });
    if (Object.keys(result).length !== 1 || result.ok !== true) {
      throw new HostedHubApiError("invalid_response", 502, undefined, intent);
    }
  }

  async #registerPasskey<T>(
    optionsPath: string,
    verifyPath: string,
    input: unknown,
    options: {
      /**
       * `true` when the ceremony runs on an existing session (add-passkey):
       * cookie mode presents the session CSRF token and bearer mode presents
       * `Authorization: DPoP` plus an `ath`-bound proof. `false` is the
       * pre-session mint ceremony used by bootstrap and invitation redemption.
       */
      readonly authenticated: boolean;
      /** Narrows generic Hub error codes for the account ceremony. */
      readonly intent?: HostedAccountIntent;
      /**
       * Extra members merged into the *verify* body only. The pre-session mint
       * ceremonies pass nothing: their Hub bodies are strict `{ response }`, so
       * an unexpected member would be rejected outright.
       */
      readonly verifyExtra?: Record<string, unknown>;
      readonly signal?: AbortSignal;
      readonly finish: (value: Record<string, unknown>) => T;
    },
  ): Promise<T> {
    const transport = {
      csrf: options.authenticated,
      ...(options.authenticated ? {} : { dpop: "mint" as const }),
      ...(options.intent ? { intent: options.intent } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    };
    const challenge = await this.#request(optionsPath, {
      method: "POST",
      body: input,
      ...transport,
      // The step-up gate lives on the *verify* leg only — this leg mints a
      // challenge and has no such gate, so a `forbidden` here cannot be a
      // step-up and must not be relabelled as one. The intent still rides along
      // so the error reports which operation it belongs to.
      narrowForbidden: false,
    });
    const response = await this.#passkeyCeremony.register(
      validatePasskeyRegistrationOptions(challenge.options),
      options.signal,
    );
    return options.finish(
      await this.#request(verifyPath, {
        method: "POST",
        body: { response, ...options.verifyExtra },
        ...transport,
      }),
    );
  }

  /**
   * Persist the session material returned by a login/registration verify and
   * return the account/session view. Cookie mode stores the CSRF token; bearer
   * mode stores the native token behind the session-credentials seam and never
   * surfaces it (or a proof) in the returned value.
   */
  #finishLogin(value: Record<string, unknown>): HostedHubSessionResponse {
    if (this.#isBearer) {
      const { response, token } = this.#nativeSessionResponse(value);
      this.#writeBearerToken(token);
      return response;
    }
    const result = this.#sessionResponse(value);
    this.#sessionCredentials.writeCsrfToken(result.csrfToken);
    return result;
  }

  #restoreNativeSession(value: Record<string, unknown>): HostedHubSessionResponse {
    const response = this.#accountAndSession(value);
    // A native restore may rotate the token; persist a fresh one if present,
    // otherwise the existing enclave-bound token stays in force.
    const token = bearerTokenValue(value.token);
    if (token) this.#writeBearerToken(token);
    return response;
  }

  /**
   * Adopt the session material a **rotating** account route returns.
   *
   * Adding a passkey and rotating recovery codes both mint a replacement session
   * server-side and **revoke the one that made the request**. The response
   * carries the replacement: a fresh `token` for a native session, a fresh
   * `csrfToken` (plus `Set-Cookie`) for a browser one.
   *
   * Discarding it does not fail safe, it fails *certainly*:
   *
   * - **Bearer** — the enclave keeps a revoked token, so the very next
   *   authenticated call is a `401`. For add-passkey that next call is the
   *   controller's own confirming read, so the user is signed out for adding a
   *   device, every time.
   * - **Cookie** — `Set-Cookie` installs the new session but the stored CSRF
   *   token belongs to the revoked one, so every later mutation is a `403`,
   *   which `isSessionFailure` does not match. The session wedges until a
   *   reload.
   *
   * The rule that matters is not "never adopt" but **"never adopt
   * unvalidated"**. So the whole account/session payload is validated first, by
   * the same {@link #accountAndSession} path `restoreSession` and every
   * login/register verify already use, and the transport-specific material is
   * demanded rather than sniffed: bearer requires a bounded `token`, cookie
   * requires a non-empty `csrfToken`. A response this client cannot read is an
   * `invalid_response` and displaces nothing.
   */
  #finishRotatedSession(value: Record<string, unknown>): void {
    if (this.#isBearer) {
      const { token } = this.#nativeSessionResponse(value);
      this.#writeBearerToken(token);
      return;
    }
    this.#sessionCredentials.writeCsrfToken(this.#sessionResponse(value).csrfToken);
  }

  /**
   * Complete an add-passkey ceremony on an already-authenticated session.
   *
   * The replacement session is adopted first — see
   * {@link #finishRotatedSession} — and only then is the enrolled credential
   * projected. Ordering matters: if the payload does not validate, this throws
   * before reporting an enrolment whose session the caller could not use.
   *
   * `confirmed` stays a tolerant read of the `passkey` member. The Hub does
   * describe the credential it enrolled, but the controller's confirming list
   * read is a second, independent check and there is no reason to turn a
   * cosmetic omission into a failed enrolment.
   *
   * No token and no CSRF value is returned; the caller only ever sees the
   * bounded passkey view.
   */
  #finishAddPasskey(value: Record<string, unknown>): HostedAddPasskeyResult {
    this.#finishRotatedSession(value);
    const passkey = passkeyValue(value.passkey);
    return { passkey, confirmed: passkey !== null };
  }

  async signOut(signal?: AbortSignal): Promise<void> {
    await this.#request("/api/auth/logout", {
      method: "POST",
      body: {},
      csrf: true,
      ...(signal ? { signal } : {}),
    });
    this.clearSessionMaterial();
  }

  async listNodes(signal?: AbortSignal): Promise<ReadonlyArray<HostedHubNode>> {
    const result = await this.#request("/api/nodes", signal ? { signal } : {});
    if (!Array.isArray(result.nodes)) throw new HostedHubApiError("invalid_response", 502);
    return result.nodes.map((value) => {
      const node = objectValue(value);
      const grant = objectValue(node.grant);
      const presence = objectValue(node.presence);
      const capabilities = node.capabilities === undefined ? null : objectValue(node.capabilities);
      const nodeId = decodeContract(RelayNodeId, node.id, "invalid_response");
      if (
        typeof node.environmentId !== "string" ||
        typeof node.label !== "string" ||
        !platformOsValue(node.platformOs) ||
        !platformArchValue(node.platformArch) ||
        typeof node.clientVersion !== "string" ||
        !nullableNumber(node.createdAt) ||
        node.createdAt === null ||
        !nullableNumber(node.updatedAt) ||
        node.updatedAt === null ||
        !nullableNumber(node.lastAuthenticatedAt) ||
        !nullableNumber(node.revokedAt) ||
        (node.revocationReasonCode !== null && typeof node.revocationReasonCode !== "string") ||
        typeof grant.id !== "string" ||
        !roleValue(grant.role) ||
        !roleValue(node.effectiveRole) ||
        typeof presence.online !== "boolean" ||
        !nullableNumber(presence.lastHeartbeatAt) ||
        (capabilities !== null &&
          (typeof capabilities.repositoryIdentity !== "boolean" ||
            typeof capabilities.nativeClientRequired !== "boolean" ||
            (capabilities.threadSettlement !== undefined &&
              typeof capabilities.threadSettlement !== "boolean")))
      ) {
        throw new HostedHubApiError("invalid_response", 502);
      }
      const decodedNode = {
        id: nodeId,
        environmentId: EnvironmentId.make(node.environmentId),
        label: node.label,
        platformOs: node.platformOs,
        platformArch: node.platformArch,
        clientVersion: node.clientVersion,
        createdAt: node.createdAt,
        updatedAt: node.updatedAt,
        lastAuthenticatedAt: node.lastAuthenticatedAt,
        revokedAt: node.revokedAt,
        revocationReasonCode: node.revocationReasonCode,
        grant: { id: grant.id, role: grant.role },
        effectiveRole: node.effectiveRole,
        presence: {
          online: presence.online,
          lastHeartbeatAt: presence.lastHeartbeatAt,
        },
      } as unknown as HostedHubNode;
      return capabilities
        ? Object.assign(decodedNode, {
            capabilities: {
              repositoryIdentity: capabilities.repositoryIdentity as boolean,
              nativeClientRequired: capabilities.nativeClientRequired as boolean,
              ...(typeof capabilities.threadSettlement === "boolean"
                ? { threadSettlement: capabilities.threadSettlement }
                : {}),
            },
          })
        : decodedNode;
    });
  }

  async renameNode(nodeId: string, label: string, signal?: AbortSignal): Promise<void> {
    const normalizedLabel = label.trim();
    if (
      !HUB_NODE_ID_PATTERN.test(nodeId) ||
      normalizedLabel.length === 0 ||
      normalizedLabel.length > MAX_HUB_NODE_LABEL_LENGTH
    ) {
      throw new HostedHubApiError("invalid_request", 400);
    }

    const result = await this.#request(`/api/admin/nodes/${encodeURIComponent(nodeId)}/rename`, {
      method: "POST",
      body: { label: normalizedLabel },
      csrf: true,
      ...(signal ? { signal } : {}),
    });
    if (Object.keys(result).length !== 1 || result.ok !== true) {
      throw new HostedHubApiError("invalid_response", 502);
    }
  }

  /**
   * Revoke a node, Hub-side and permanently.
   *
   * IT REACHES NOTHING BUT THE HUB. The route commits the revocation in the
   * Hub's own transaction and emits an in-process signal that closes whatever
   * relay channels are open for that node; there is no leg that contacts the
   * machine. A node that is offline, unreachable, or physically gone is revoked
   * by exactly this call and by the same code path — which is the reason the
   * action exists.
   *
   * REVOKING A NODE IS NOT REVOKING ONE GRANT. `/api/admin/node-grants/…/revoke`
   * removes one account's access; this removes the node, so every grant on it
   * stops resolving and it leaves every authorized account's directory at once.
   * Callers must not present it as a change to the caller's own access alone.
   *
   * A second call for the same node answers 404: the underlying update is
   * conditioned on the node not already being revoked, so `node_not_found`
   * here means "already gone" as often as it means "never existed", and a
   * caller may not report it as a lookup failure.
   */
  async revokeNode(nodeId: string, reasonCode: string, signal?: AbortSignal): Promise<void> {
    if (!HUB_NODE_ID_PATTERN.test(nodeId) || !HUB_REVOCATION_REASON_PATTERN.test(reasonCode)) {
      throw new HostedHubApiError("invalid_request", 400);
    }

    const result = await this.#request(`/api/admin/nodes/${encodeURIComponent(nodeId)}/revoke`, {
      method: "POST",
      body: { reasonCode },
      csrf: true,
      ...(signal ? { signal } : {}),
    });
    if (Object.keys(result).length !== 1 || result.ok !== true) {
      throw new HostedHubApiError("invalid_response", 502);
    }
  }

  async lookupNodeEnrollment(
    deviceCode: string,
    signal?: AbortSignal,
  ): Promise<HostedNodeEnrollment> {
    const result = await this.#request("/api/admin/node-enrollments/lookup", {
      method: "POST",
      body: { deviceCode },
      csrf: true,
      ...(signal ? { signal } : {}),
    });
    const enrollment = objectValue(result.enrollment);
    if (
      typeof enrollment.id !== "string" ||
      !/^enr_[A-Za-z0-9_-]{22}$/.test(enrollment.id) ||
      typeof enrollment.label !== "string" ||
      enrollment.label.length < 1 ||
      enrollment.label.length > 100 ||
      !platformOsValue(enrollment.platformOs) ||
      !platformArchValue(enrollment.platformArch) ||
      typeof enrollment.clientVersion !== "string" ||
      enrollment.clientVersion.length < 1 ||
      enrollment.clientVersion.length > 64 ||
      enrollment.algorithm !== "ed25519" ||
      typeof enrollment.fingerprint !== "string" ||
      !/^SHA256:[A-Za-z0-9_-]{43}$/.test(enrollment.fingerprint) ||
      !Number.isSafeInteger(enrollment.createdAt) ||
      !Number.isSafeInteger(enrollment.expiresAt) ||
      Number(enrollment.expiresAt) <= Number(enrollment.createdAt)
    ) {
      throw new HostedHubApiError("invalid_response", 502);
    }
    return {
      id: enrollment.id,
      label: enrollment.label,
      platformOs: enrollment.platformOs,
      platformArch: enrollment.platformArch,
      clientVersion: enrollment.clientVersion,
      algorithm: enrollment.algorithm,
      fingerprint: enrollment.fingerprint,
      createdAt: enrollment.createdAt as number,
      expiresAt: enrollment.expiresAt as number,
    };
  }

  async approveNodeEnrollment(deviceCode: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#request("/api/admin/node-enrollments/approve", {
      method: "POST",
      body: { deviceCode },
      csrf: true,
      ...(signal ? { signal } : {}),
    });
    const node = objectValue(result.node);
    const grant = objectValue(result.grant);
    if (
      typeof node.id !== "string" ||
      !HUB_NODE_ID_PATTERN.test(node.id) ||
      typeof node.environmentId !== "string" ||
      !/^env_[A-Za-z0-9_-]{22}$/.test(node.environmentId) ||
      typeof grant.id !== "string" ||
      !/^grant_[A-Za-z0-9_-]{22}$/.test(grant.id) ||
      grant.role !== "owner"
    ) {
      throw new HostedHubApiError("invalid_response", 502);
    }
  }

  async denyNodeEnrollment(deviceCode: string, signal?: AbortSignal): Promise<void> {
    const result = await this.#request("/api/admin/node-enrollments/deny", {
      method: "POST",
      body: { deviceCode },
      csrf: true,
      ...(signal ? { signal } : {}),
    });
    if (Object.keys(result).length !== 1 || result.ok !== true) {
      throw new HostedHubApiError("invalid_response", 502);
    }
  }

  async issueRelayTicket(nodeId: string, signal?: AbortSignal): Promise<HostedRelayTicket> {
    const validatedNodeId = decodeContract(RelayNodeId, nodeId, "invalid_request");
    const request = (protocolMinor: 2 | 3) =>
      this.#request("/api/relay/tickets", {
        method: "POST",
        body: { nodeId: validatedNodeId, capability: "ryco.rpc", protocolMajor: 1, protocolMinor },
        csrf: true,
        ...(signal ? { signal } : {}),
      });
    let offeredMinor: 2 | 3 = 3;
    let result: Record<string, unknown>;
    try {
      result = await request(offeredMinor);
    } catch (error) {
      // Older Hubs reject the newer request schema before issuing any ticket.
      // Retry only that explicit rejection, never a failed/uncertain issuance.
      if (
        !(error instanceof HostedHubApiError) ||
        error.status !== 400 ||
        error.code !== "invalid_request"
      ) {
        throw error;
      }
      offeredMinor = 2;
      result = await request(offeredMinor);
    }
    if (
      Object.keys(result).length !== 4 ||
      typeof result.ticket !== "string" ||
      !Number.isSafeInteger(result.expiresAt) ||
      result.protocolMajor !== 1 ||
      (result.protocolMinor !== 2 && result.protocolMinor !== 3) ||
      result.protocolMinor > offeredMinor
    ) {
      throw new HostedHubApiError("invalid_response", 502);
    }
    return {
      ticket: result.ticket,
      expiresAt: result.expiresAt,
      protocolMajor: 1,
      protocolMinor: result.protocolMinor,
    } as HostedRelayTicket;
  }

  /** Register or renew this native installation. Grant material is never returned here. */
  async upsertE2eeDeviceEnrollment(
    request: NativeE2eeEnrollmentUpsertRequestType,
    signal?: AbortSignal,
  ): Promise<AccountE2eeDeviceSummary> {
    this.#requireBearerTransport();
    const body = decodeContract(NativeE2eeEnrollmentUpsertRequest, request, "invalid_request");
    if (body.hubOrigin !== this.#endpoint.origin()) {
      throw new HostedHubApiError("invalid_request", 400);
    }
    return decodeContract(
      NativeE2eeEnrollmentUpsertResponse,
      await this.#request(NATIVE_E2EE_CURRENT_DEVICE_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    ).enrollment;
  }

  /** Authenticated native keyset; a key carried only by a ticket is never accepted. */
  async getE2eeGrantVerificationKeys(
    signal?: AbortSignal,
  ): Promise<HubGrantVerificationKeysetResponseType> {
    this.#requireBearerTransport();
    return decodeContract(
      HubGrantVerificationKeysetResponse,
      await this.#request(NATIVE_E2EE_GRANT_KEYS_PATH, signal ? { signal } : {}),
      "invalid_response",
    );
  }

  /** Issue one suite-0x02 ticket/grant pair for one bounded native relay attempt. */
  async issueAccountGrantRelayTicket(
    request: NativeAccountGrantRelayTicketRequestType,
    signal?: AbortSignal,
  ): Promise<NativeAccountGrantRelayTicketResponseType> {
    this.#requireBearerTransport();
    const body = decodeContract(NativeAccountGrantRelayTicketRequest, request, "invalid_request");
    return decodeContract(
      NativeAccountGrantRelayTicketResponse,
      await this.#request(NATIVE_ACCOUNT_GRANT_RELAY_TICKET_PATH, {
        method: "POST",
        body,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    );
  }

  /** Public account-security directory. Works with cookie+CSRF or native DPoP sessions. */
  async listE2eeDevices(signal?: AbortSignal): Promise<ReadonlyArray<AccountE2eeDeviceSummary>> {
    return decodeContract(
      AccountE2eeDeviceListResponse,
      await this.#request(ACCOUNT_E2EE_DEVICES_PATH, signal ? { signal } : {}),
      "invalid_response",
    ).devices;
  }

  async renameE2eeDevice(
    enrollmentId: string,
    request: typeof AccountE2eeDeviceRenameRequest.Type,
    signal?: AbortSignal,
  ): Promise<AccountE2eeDeviceSummary> {
    const id = decodeContract(NativeE2eeEnrollmentId, enrollmentId, "invalid_request");
    const body = decodeContract(AccountE2eeDeviceRenameRequest, request, "invalid_request");
    return decodeContract(
      AccountE2eeDeviceMutationResponse,
      await this.#request(`${ACCOUNT_E2EE_DEVICE_PATH_PREFIX}/${encodeURIComponent(id)}/rename`, {
        method: "POST",
        body,
        csrf: true,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    ).enrollment;
  }

  async revokeE2eeDevice(
    enrollmentId: string,
    request: typeof AccountE2eeDeviceRevokeRequest.Type,
    signal?: AbortSignal,
  ): Promise<AccountE2eeDeviceSummary> {
    const id = decodeContract(NativeE2eeEnrollmentId, enrollmentId, "invalid_request");
    const body = decodeContract(AccountE2eeDeviceRevokeRequest, request, "invalid_request");
    return decodeContract(
      AccountE2eeDeviceMutationResponse,
      await this.#request(`${ACCOUNT_E2EE_DEVICE_PATH_PREFIX}/${encodeURIComponent(id)}/revoke`, {
        method: "POST",
        body,
        csrf: true,
        ...(signal ? { signal } : {}),
      }),
      "invalid_response",
    ).enrollment;
  }

  /**
   * Validate the account/session (and optional recovery codes) common to both
   * transports. Returns a bounded {@link HostedHubSessionResponse} with no
   * transport material attached.
   */
  #accountAndSession(value: Record<string, unknown>): HostedHubSessionResponse {
    const account = objectValue(value.account);
    const session = objectValue(value.session);
    const accountId = e2eeAccountIdValue(account.id);
    const sessionAccountId = e2eeAccountIdValue(session.accountId);
    const recoveryCodes =
      value.recoveryCodes === undefined ? undefined : recoveryCodesValue(value.recoveryCodes);
    if (
      typeof account.displayName !== "string" ||
      !roleValue(account.role) ||
      !Number.isSafeInteger(account.createdAt) ||
      !nullableNumber(account.disabledAt) ||
      typeof session.id !== "string" ||
      !Number.isSafeInteger(session.createdAt) ||
      !Number.isSafeInteger(session.expiresAt) ||
      !Number.isSafeInteger(session.lastSeenAt) ||
      !nullableNumber(session.revokedAt) ||
      (session.revocationReasonCode !== null && typeof session.revocationReasonCode !== "string") ||
      recoveryCodes === null
    ) {
      throw new HostedHubApiError("invalid_response", 502);
    }
    if (
      account.disabledAt !== null ||
      session.revokedAt !== null ||
      sessionAccountId !== accountId
    ) {
      throw new HostedHubApiError("session_invalid", 401);
    }
    return {
      account: {
        id: accountId,
        displayName: account.displayName,
        role: account.role,
        createdAt: account.createdAt,
        disabledAt: account.disabledAt,
      },
      session: {
        id: session.id,
        accountId: sessionAccountId,
        createdAt: session.createdAt,
        expiresAt: session.expiresAt,
        lastSeenAt: session.lastSeenAt,
        revokedAt: session.revokedAt,
        revocationReasonCode: session.revocationReasonCode,
      },
      ...(recoveryCodes === undefined ? {} : { recoveryCodes }),
    } as HostedHubSessionResponse;
  }

  #sessionResponse(
    value: Record<string, unknown>,
  ): HostedHubSessionResponse & { readonly csrfToken: string } {
    // Reject a malformed CSRF token before the account/session check; both an
    // invalid token and invalid account/session yield `invalid_response`, and
    // the only `session_invalid` path (disabled/revoked) is reached only once
    // both pass — so this preserves the exact error codes of the prior combined
    // validation.
    if (typeof value.csrfToken !== "string" || value.csrfToken.length === 0) {
      throw new HostedHubApiError("invalid_response", 502);
    }
    return { ...this.#accountAndSession(value), csrfToken: value.csrfToken };
  }

  #nativeSessionResponse(value: Record<string, unknown>): {
    readonly response: HostedHubSessionResponse;
    readonly token: string;
  } {
    const token = bearerTokenValue(value.token);
    if (!token) throw new HostedHubApiError("invalid_response", 502);
    return { response: this.#accountAndSession(value), token };
  }

  async #request(
    pathname: string,
    options: {
      readonly method?: "GET" | "POST";
      readonly body?: unknown;
      readonly csrf?: boolean;
      /** Bearer mode only: `"mint"` = login/public (no token, proof without `ath`). */
      readonly dpop?: "mint" | "session";
      /** Narrows generic Hub error codes to what they mean on this route. */
      readonly intent?: HostedAccountIntent;
      /**
       * Whether a bare `forbidden` on this leg may be narrowed to a step-up /
       * passkey-session code. Defaults to `true` when an intent is present; set
       * it to `false` on a leg that carries the intent for message scoping but
       * has no step-up gate behind it. See {@link narrowCode}.
       */
      readonly narrowForbidden?: boolean;
      readonly signal?: AbortSignal;
    },
  ): Promise<Record<string, unknown>> {
    const url = new URL(pathname, this.#endpoint.origin());
    // Every path this runtime issues is a literal with no percent-encoding, so
    // an encoded pathname is never legitimate — and an encoded separator would
    // otherwise let a path slip past the browser-only guard below.
    //
    // The percent clause is deliberately a *second* layer: the only path built
    // from a caller-supplied value is `revokePasskey`'s, and its credential-id
    // guard already refuses encoding before a URL is constructed. It is kept so
    // that a future dynamic path cannot reintroduce the hole silently. The
    // origin/search/hash clauses are reachable — the endpoint is an injected
    // seam — and are covered by test.
    if (
      url.origin !== this.#endpoint.origin() ||
      url.search ||
      url.hash ||
      url.pathname.includes("%")
    ) {
      throw new HostedHubApiError("invalid_request", 400, undefined, options.intent);
    }
    // Fail closed before any I/O — and before any passkey prompt — on routes the
    // Hub only serves to a browser transport. Reaching the wire here yields an
    // unexplained 404 the caller cannot act on.
    if (this.#isBearer && isBrowserOnlyPath(url.pathname)) {
      throw new HostedHubApiError("browser_only_transport", 400, undefined, options.intent);
    }
    const method = options.method ?? "GET";
    const headers: Record<string, string> = { ...JSON_HEADERS };

    let target: string;
    let credentials: "include" | "omit" | "same-origin";
    if (this.#isBearer) {
      // Native/DPoP transport: no ambient cookie, no CSRF. Present
      // `Authorization: DPoP <token>` + a proof only on authenticated requests;
      // the mint/login ceremony (and the public status probe) carries a proof
      // without `ath` and no token.
      const signer = this.#dpopSigner;
      if (!signer) {
        throw new HostedHubApiError(
          "native_session_unavailable",
          0,
          undefined,
          options.intent,
          undefined,
          "missing-signer",
        );
      }
      const requestUrl = url.toString();
      let token: string | undefined;
      if (options.dpop !== "mint") {
        token = this.#readBearerToken() ?? undefined;
        if (!token) {
          throw new HostedHubApiError(
            "session_invalid",
            401,
            undefined,
            options.intent,
            undefined,
            "missing-token",
          );
        }
      }
      try {
        headers["DPoP"] = await signer.sign({
          method,
          url: requestUrl,
          ...(token ? { token } : {}),
        });
      } catch {
        throw new HostedHubApiError(
          "native_session_unavailable",
          0,
          undefined,
          options.intent,
          undefined,
          "proof-signing-failed",
        );
      }
      if (token) headers["Authorization"] = `DPoP ${token}`;
      target = requestUrl;
      credentials = "omit";
    } else {
      if (options.csrf) {
        const csrfToken = this.#sessionCredentials.readCsrfToken();
        if (!csrfToken) {
          throw new HostedHubApiError("session_invalid", 401, undefined, options.intent);
        }
        headers["X-Ryco-CSRF"] = csrfToken;
      }
      target = url.pathname;
      credentials = "same-origin";
    }

    // Bound the wait. Without this a stalled request never settles, and on the
    // account surface that is not merely a spinner: the controller runs one
    // mutation at a time, so a hung `setPassword` holds the mutex for the life
    // of the session and a user who wants to revoke a passkey they believe
    // compromised cannot. The deadline releases it.
    const deadline = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      deadline.abort();
    }, REQUEST_DEADLINE_MS);
    const callerSignal = options.signal;
    const forwardAbort = () => deadline.abort();
    if (callerSignal?.aborted) deadline.abort();
    else callerSignal?.addEventListener("abort", forwardAbort);

    let response: Awaited<ReturnType<HttpClientService["fetch"]>>;
    try {
      response = await this.#httpClient.fetch(target, {
        method,
        credentials,
        cache: "no-store",
        headers,
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: deadline.signal,
      });
    } catch (error) {
      // Our own deadline is not the caller's cancellation: surfacing it as an
      // `AbortError` would let it be mistaken for a user-cancelled action and
      // reported as no error at all.
      if (timedOut) {
        throw new HostedHubApiError(
          "timeout",
          0,
          undefined,
          options.intent,
          undefined,
          "request-timeout",
        );
      }
      if (
        typeof error === "object" &&
        error !== null &&
        "name" in error &&
        error.name === "AbortError"
      )
        throw error;
      throw new HostedHubApiError(
        "unavailable",
        0,
        undefined,
        options.intent,
        undefined,
        "transport-unavailable",
      );
    } finally {
      clearTimeout(timer);
      callerSignal?.removeEventListener("abort", forwardAbort);
    }
    try {
      return await responseJson(response, options.intent, options.narrowForbidden !== false);
    } catch (error) {
      if (
        this.#isBearer &&
        options.dpop !== "mint" &&
        error instanceof HostedHubApiError &&
        error.code === "session_invalid"
      ) {
        throw new HostedHubApiError(
          error.code,
          error.status,
          error.retryAfterMs,
          error.intent,
          error.wireCode,
          "token-invalidated",
        );
      }
      throw error;
    }
  }
}
