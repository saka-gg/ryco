import { Schema } from "effect";

import { rejectExcessProperties } from "./baseSchemas.ts";
import { ExternalIdentityProvider, ExternalIdentitySummary } from "./hostedIdentity.ts";

export const NATIVE_HANDOFF_CAPABILITY_PATH = "/.well-known/ryco-hub" as const;
export const NATIVE_HANDOFF_PROTOCOL_VERSION = 1 as const;
export const NATIVE_HANDOFF_VERSION = 1 as const;
export const NATIVE_HANDOFF_MODE = "system-browser" as const;
export const NATIVE_IDENTITY_CAPABILITY_VERSION = 2 as const;

export const NATIVE_HANDOFF_START_PATH = "/api/auth/native/handoff/start" as const;
export const NATIVE_HANDOFF_REDEEM_PATH = "/api/auth/native/handoff/redeem" as const;
export const NATIVE_HANDOFF_PRESENTATION_PATH_PREFIX = "/api/auth/native/handoff/" as const;
export const NATIVE_HANDOFF_AUTHORIZE_PATH_PREFIX = "/native/authorize/" as const;
export const NATIVE_HANDOFF_APPROVE_PATH_SUFFIX = "/approve" as const;
export const NATIVE_HANDOFF_CANCEL_PATH_SUFFIX = "/cancel" as const;

export const NATIVE_HANDOFF_CALLBACK_URIS = [
  "ryco-dev://hosted/complete",
  "ryco-preview://hosted/complete",
  "ryco://hosted/complete",
] as const;

export const NATIVE_HANDOFF_TRANSACTION_LIFETIME_MS = 5 * 60_000;
export const NATIVE_HANDOFF_CODE_LIFETIME_MS = 60_000;
export const NATIVE_HANDOFF_MAX_BODY_BYTES = 4 * 1_024;
export const NATIVE_HANDOFF_MAX_CAPABILITY_BYTES = 16 * 1_024;
export const NATIVE_HANDOFF_MAX_DEVICE_LABEL_CHARS = 64;
export const NATIVE_HANDOFF_MAX_URL_CHARS = 2_048;

const Base64Url256 = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(43),
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/),
);
const isBase64Url256 = Schema.is(Base64Url256);

export const NativeHandoffId = Base64Url256.pipe(Schema.brand("NativeHandoffId"));
export type NativeHandoffId = typeof NativeHandoffId.Type;

export const NativeHandoffState = Base64Url256.pipe(Schema.brand("NativeHandoffState"));
export type NativeHandoffState = typeof NativeHandoffState.Type;

export const NativeHandoffCode = Base64Url256.pipe(Schema.brand("NativeHandoffCode"));
export type NativeHandoffCode = typeof NativeHandoffCode.Type;

export const NativeHandoffCodeVerifier = Base64Url256.pipe(
  Schema.brand("NativeHandoffCodeVerifier"),
);
export type NativeHandoffCodeVerifier = typeof NativeHandoffCodeVerifier.Type;

export const NativeHandoffCodeChallenge = Base64Url256.pipe(
  Schema.brand("NativeHandoffCodeChallenge"),
);
export type NativeHandoffCodeChallenge = typeof NativeHandoffCodeChallenge.Type;

export const NativeHandoffCallbackUri = Schema.Literals(NATIVE_HANDOFF_CALLBACK_URIS);
export type NativeHandoffCallbackUri = typeof NativeHandoffCallbackUri.Type;

const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const BoundedDeviceLabel = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(NATIVE_HANDOFF_MAX_DEVICE_LABEL_CHARS),
);
const RelyingPartyId = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(253),
  Schema.isPattern(
    /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?))*$/i,
  ),
);
const DisplayName = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(64));
const NativeIdentityTurnstileSiteKey = Schema.String.check(
  Schema.isMinLength(10),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);
const NativeIdentityPrimaryCredential = Schema.Literals(["passkey", "password"]);
const NativeIdentityLoginMethod = Schema.Literals(["passkey", "password", "recovery_code"]);
const uniqueNonEmpty = <S extends Schema.Top>(item: S, maximum: number) =>
  Schema.Array(item).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(maximum),
    Schema.makeFilter((values) =>
      new Set(values).size === values.length ? undefined : "values must be unique",
    ),
  );

const NativeIdentityAntiBot = Schema.Union([
  rejectExcessProperties(Schema.Struct({ provider: Schema.Literal("bypass") })),
  rejectExcessProperties(
    Schema.Struct({
      provider: Schema.Literal("turnstile"),
      siteKey: NativeIdentityTurnstileSiteKey,
    }),
  ),
]);

export const NativeIdentityCapability = rejectExcessProperties(
  Schema.Struct({
    version: Schema.Literal(NATIVE_IDENTITY_CAPABILITY_VERSION),
    email: rejectExcessProperties(
      Schema.Struct({
        verification: Schema.Literal("required"),
        antiBot: NativeIdentityAntiBot,
      }),
    ),
    signup: Schema.Union([
      rejectExcessProperties(Schema.Struct({ status: Schema.Literal("disabled") })),
      rejectExcessProperties(
        Schema.Struct({
          status: Schema.Literal("enabled"),
          primaryCredentials: uniqueNonEmpty(NativeIdentityPrimaryCredential, 2),
        }),
      ),
    ]),
    login: rejectExcessProperties(
      Schema.Struct({
        methods: uniqueNonEmpty(NativeIdentityLoginMethod, 3),
        passwordSecondFactor: rejectExcessProperties(
          Schema.Struct({
            totp: Schema.Literal("when_enrolled"),
            fallback: Schema.Literal("verified_email_code"),
          }),
        ),
      }),
    ),
    recovery: rejectExcessProperties(
      Schema.Struct({
        recoveryCode: Schema.Boolean,
        passwordReset: Schema.Boolean,
      }),
    ),
  }),
);
export type NativeIdentityCapability = typeof NativeIdentityCapability.Type;

const AuthorizationUrl = Schema.String.check(
  Schema.isMaxLength(NATIVE_HANDOFF_MAX_URL_CHARS),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" &&
        url.hostname.length > 0 &&
        url.username === "" &&
        url.password === "" &&
        url.search === "" &&
        url.hash === "" &&
        new RegExp(`^${NATIVE_HANDOFF_AUTHORIZE_PATH_PREFIX}[A-Za-z0-9_-]{43}$`).test(url.pathname)
        ? undefined
        : "authorization URL must be a canonical HTTPS native-authorization route";
    } catch {
      return "authorization URL must be an absolute URL";
    }
  }),
);

function callbackBase(url: URL): NativeHandoffCallbackUri | null {
  if (
    url.username !== "" ||
    url.password !== "" ||
    url.port !== "" ||
    url.hash !== "" ||
    url.pathname !== "/complete"
  ) {
    return null;
  }
  const candidate = `${url.protocol}//${url.host}${url.pathname}`;
  return NATIVE_HANDOFF_CALLBACK_URIS.find((value) => value === candidate) ?? null;
}

function hasOnlySearchKeys(url: URL, expected: ReadonlyArray<string>): boolean {
  const expectedSet = new Set(expected);
  const actual = [...url.searchParams.keys()];
  return (
    actual.length === expected.length &&
    actual.every((key) => expectedSet.has(key)) &&
    expected.every((key) => url.searchParams.getAll(key).length === 1)
  );
}

function validCallbackResponse(value: string, outcome: "approved" | "cancelled"): boolean {
  if (value.length < 1 || value.length > NATIVE_HANDOFF_MAX_URL_CHARS) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (callbackBase(url) === null) return false;
  if (outcome === "approved") {
    if (!hasOnlySearchKeys(url, ["code", "state", "handoff_id"])) return false;
    return (
      isBase64Url256(url.searchParams.get("code")) &&
      isBase64Url256(url.searchParams.get("state")) &&
      isBase64Url256(url.searchParams.get("handoff_id"))
    );
  }
  if (!hasOnlySearchKeys(url, ["error", "state", "handoff_id"])) return false;
  return (
    url.searchParams.get("error") === "access_denied" &&
    isBase64Url256(url.searchParams.get("state")) &&
    isBase64Url256(url.searchParams.get("handoff_id"))
  );
}

const ApprovedCallbackUrl = Schema.String.check(
  Schema.makeFilter((value) =>
    validCallbackResponse(value, "approved") ? undefined : "invalid approved callback URL",
  ),
);
const CancelledCallbackUrl = Schema.String.check(
  Schema.makeFilter((value) =>
    validCallbackResponse(value, "cancelled") ? undefined : "invalid cancelled callback URL",
  ),
);

export const NativeHandoffCapability = rejectExcessProperties(
  Schema.Struct({
    service: Schema.Literal("ryco-hub"),
    protocolVersion: Schema.Literal(NATIVE_HANDOFF_PROTOCOL_VERSION),
    nativeHandoff: rejectExcessProperties(
      Schema.Struct({
        mode: Schema.Literal(NATIVE_HANDOFF_MODE),
        version: Schema.Literal(NATIVE_HANDOFF_VERSION),
      }),
    ),
    relyingParty: rejectExcessProperties(
      Schema.Struct({
        id: RelyingPartyId,
        displayName: DisplayName,
      }),
    ),
    nativeIdentity: Schema.optionalKey(NativeIdentityCapability),
  }),
);
export type NativeHandoffCapability = typeof NativeHandoffCapability.Type;

export const NativeHandoffSignInPurpose = rejectExcessProperties(
  Schema.Struct({
    kind: Schema.Literal("sign_in"),
    providerHint: Schema.optionalKey(ExternalIdentityProvider),
  }),
);
export type NativeHandoffSignInPurpose = typeof NativeHandoffSignInPurpose.Type;

export const NativeHandoffConnectExternalIdentityPurpose = rejectExcessProperties(
  Schema.Struct({
    kind: Schema.Literal("connect_external_identity"),
    provider: ExternalIdentityProvider,
  }),
);
export type NativeHandoffConnectExternalIdentityPurpose =
  typeof NativeHandoffConnectExternalIdentityPurpose.Type;

export const NativeHandoffPurpose = Schema.Union([
  NativeHandoffSignInPurpose,
  NativeHandoffConnectExternalIdentityPurpose,
]);
export type NativeHandoffPurpose = typeof NativeHandoffPurpose.Type;

export const NativeHandoffStartRequest = rejectExcessProperties(
  Schema.Struct({
    redirectUri: NativeHandoffCallbackUri,
    codeChallenge: NativeHandoffCodeChallenge,
    codeChallengeMethod: Schema.Literal("S256"),
    state: NativeHandoffState,
    deviceLabel: BoundedDeviceLabel,
    purpose: Schema.optionalKey(NativeHandoffPurpose),
  }),
);
export type NativeHandoffStartRequest = typeof NativeHandoffStartRequest.Type;

export const NativeHandoffStartResponse = rejectExcessProperties(
  Schema.Struct({
    handoffId: NativeHandoffId,
    authorizationUrl: AuthorizationUrl,
    expiresAt: EpochMs,
  }),
);
export type NativeHandoffStartResponse = typeof NativeHandoffStartResponse.Type;

export const NativeHandoffPresentation = rejectExcessProperties(
  Schema.Struct({
    status: Schema.Literal("pending"),
    deviceLabel: BoundedDeviceLabel,
    expiresAt: EpochMs,
    providerHint: Schema.optionalKey(ExternalIdentityProvider),
  }),
);
export type NativeHandoffPresentation = typeof NativeHandoffPresentation.Type;

export const NativeHandoffApproveResponse = rejectExcessProperties(
  Schema.Struct({ redirectUri: ApprovedCallbackUrl }),
);
export type NativeHandoffApproveResponse = typeof NativeHandoffApproveResponse.Type;

export const NativeHandoffCancelResponse = rejectExcessProperties(
  Schema.Struct({ redirectUri: CancelledCallbackUrl }),
);
export type NativeHandoffCancelResponse = typeof NativeHandoffCancelResponse.Type;

export const NativeHandoffRedeemRequest = rejectExcessProperties(
  Schema.Struct({
    handoffId: NativeHandoffId,
    code: NativeHandoffCode,
    codeVerifier: NativeHandoffCodeVerifier,
  }),
);
export type NativeHandoffRedeemRequest = typeof NativeHandoffRedeemRequest.Type;

export const NativeHandoffConnectRedeemRequest = rejectExcessProperties(
  Schema.Struct({
    handoffId: NativeHandoffId,
    code: NativeHandoffCode,
    codeVerifier: NativeHandoffCodeVerifier,
    purpose: NativeHandoffConnectExternalIdentityPurpose,
    totpCode: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^[0-9]{6}$/))),
  }),
);
export type NativeHandoffConnectRedeemRequest = typeof NativeHandoffConnectRedeemRequest.Type;

const AccountId = Schema.String.check(
  Schema.isPattern(/^acct_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(48),
);
const SessionId = Schema.String.check(
  Schema.isPattern(/^sess_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(48),
);
const SessionFamilyId = Schema.String.check(
  Schema.isPattern(/^sfam_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(48),
);
const NullableSessionLabel = Schema.NullOr(
  Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(NATIVE_HANDOFF_MAX_DEVICE_LABEL_CHARS)),
);

const NativeHandoffAccount = rejectExcessProperties(
  Schema.Struct({
    id: AccountId,
    displayName: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200)),
    role: Schema.Literals(["viewer", "operator", "owner"]),
    createdAt: EpochMs,
    disabledAt: Schema.Null,
  }),
);

const NativeHandoffSession = rejectExcessProperties(
  Schema.Struct({
    id: SessionId,
    accountId: AccountId,
    familyId: SessionFamilyId,
    clientLabel: NullableSessionLabel,
    kind: Schema.Literal("native"),
    createdAt: EpochMs,
    expiresAt: EpochMs,
    lastSeenAt: EpochMs,
    replacedBySessionId: Schema.Null,
    revokedAt: Schema.Null,
    revocationReasonCode: Schema.Null,
  }).check(
    Schema.makeFilter((session) =>
      session.expiresAt > session.createdAt &&
      session.lastSeenAt >= session.createdAt &&
      session.lastSeenAt <= session.expiresAt
        ? undefined
        : "native session timestamps are inconsistent",
    ),
  ),
);

export const NativeHandoffRedeemResponse = rejectExcessProperties(
  Schema.Struct({
    account: NativeHandoffAccount,
    session: NativeHandoffSession,
    token: Base64Url256,
  }).check(
    Schema.makeFilter((value) =>
      value.session.accountId === value.account.id
        ? undefined
        : "native session account does not match",
    ),
  ),
);
export type NativeHandoffRedeemResponse = typeof NativeHandoffRedeemResponse.Type;

export const NativeHandoffConnectRedeemResponse = rejectExcessProperties(
  Schema.Struct({
    status: Schema.Literal("connected"),
    purpose: NativeHandoffConnectExternalIdentityPurpose,
    externalIdentity: ExternalIdentitySummary,
  }),
);
export type NativeHandoffConnectRedeemResponse = typeof NativeHandoffConnectRedeemResponse.Type;
