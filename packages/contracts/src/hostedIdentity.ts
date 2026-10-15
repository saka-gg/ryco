import * as Schema from "effect/Schema";

import { rejectExcessProperties } from "./baseSchemas.ts";
import { HubNodePublicKeyFingerprint } from "./hubConnector.ts";
import { RelayNodeId } from "./relay.ts";

export const PUBLIC_SIGNUP_START_PATH = "/api/public-signup/start" as const;
export const PUBLIC_SIGNUP_CONFIG_PATH = "/api/public-signup/config" as const;
export const PUBLIC_SIGNUP_VERIFY_PATH = "/api/public-signup/verify" as const;
export const PUBLIC_SIGNUP_PASSKEY_OPTIONS_PATH = "/api/public-signup/passkey/options" as const;
export const PUBLIC_SIGNUP_PASSKEY_FINISH_PATH = "/api/public-signup/passkey/finish" as const;
export const PUBLIC_SIGNUP_PASSWORD_FINISH_PATH = "/api/public-signup/password/finish" as const;
export const PASSWORD_LOGIN_START_PATH = "/api/auth/password/start" as const;
export const PASSWORD_LOGIN_FINISH_PATH = "/api/auth/password/finish" as const;
export const PASSWORD_RESET_REQUEST_PATH = "/api/auth/password-reset/request" as const;
export const PASSWORD_RESET_VERIFY_PATH = "/api/auth/password-reset/verify" as const;
export const PASSWORD_RESET_FINISH_PATH = "/api/auth/password-reset/finish" as const;
export const ACTIVE_SPACE_SWITCH_PATH = "/api/auth/spaces/active" as const;
export const NATIVE_NODE_CLAIM_START_PATH = "/api/native/node-claims/start" as const;
export const NATIVE_NODE_CLAIM_FINISH_PATH = "/api/native/node-claims/finish" as const;
export const NATIVE_IDENTITY_EMAIL_START_PATH = "/api/auth/native/identity/email/start" as const;
export const NATIVE_IDENTITY_EMAIL_VERIFY_PATH = "/api/auth/native/identity/email/verify" as const;
export const NATIVE_IDENTITY_SIGNUP_USERNAME_PATH =
  "/api/auth/native/identity/signup/username" as const;
export const NATIVE_IDENTITY_SIGNUP_PASSKEY_OPTIONS_PATH =
  "/api/auth/native/identity/signup/passkey/options" as const;
export const NATIVE_IDENTITY_SIGNUP_PASSKEY_FINISH_PATH =
  "/api/auth/native/identity/signup/passkey/finish" as const;
export const NATIVE_IDENTITY_SIGNUP_PASSWORD_FINISH_PATH =
  "/api/auth/native/identity/signup/password/finish" as const;
export const NATIVE_IDENTITY_PASSWORD_START_PATH =
  "/api/auth/native/identity/password/start" as const;
export const NATIVE_IDENTITY_PASSWORD_FINISH_PATH =
  "/api/auth/native/identity/password/finish" as const;
export const NATIVE_IDENTITY_RECOVERY_CODE_PATH =
  "/api/auth/native/identity/recovery-code" as const;
export const NATIVE_IDENTITY_PASSWORD_RESET_REQUEST_PATH =
  "/api/auth/native/identity/password-reset/request" as const;
export const NATIVE_IDENTITY_PASSWORD_RESET_VERIFY_PATH =
  "/api/auth/native/identity/password-reset/verify" as const;
export const NATIVE_IDENTITY_PASSWORD_RESET_FINISH_PATH =
  "/api/auth/native/identity/password-reset/finish" as const;
export const NATIVE_IDENTITY_ATTEMPT_CANCEL_PATH =
  "/api/auth/native/identity/attempt/cancel" as const;
export const EXTERNAL_IDENTITY_CONFIG_PATH = "/api/auth/external/config" as const;
export const EXTERNAL_IDENTITY_START_PATH = "/api/auth/external/start" as const;
export const EXTERNAL_IDENTITY_PENDING_PATH = "/api/auth/external/pending" as const;
export const EXTERNAL_IDENTITY_SIGNUP_FINISH_PATH = "/api/auth/external/signup/finish" as const;
export const GITHUB_EXTERNAL_IDENTITY_CONNECT_PATH =
  "/api/account/external-identities/github/connect" as const;
export const GITHUB_EXTERNAL_IDENTITY_DISCONNECT_PATH =
  "/api/account/external-identities/github/disconnect" as const;
export const EXTERNAL_IDENTITY_GITHUB_CALLBACK_PATH = "/api/auth/external/github/callback" as const;

export const HOSTED_IDENTITY_PROTOCOL_VERSION = 1 as const;
export const NATIVE_NODE_CLAIM_TRANSCRIPT_VERSION = 1 as const;
export const NATIVE_IDENTITY_PROTOCOL_VERSION = 2 as const;
export const EXTERNAL_IDENTITY_PROTOCOL_VERSION = 1 as const;

export const HUB_USERNAME_MIN_CHARS = 3;
export const HUB_USERNAME_MAX_CHARS = 32;
export const HUB_SPACE_DISPLAY_NAME_MAX_CHARS = 100;
export const HOSTED_IDENTITY_MAX_ANTI_BOT_ASSERTION_CHARS = 8_192;
export const HOSTED_IDENTITY_MAX_EMAIL_CHARS = 254;
export const HOSTED_IDENTITY_MIN_PASSWORD_CHARS = 12;
export const HOSTED_IDENTITY_MAX_PASSWORD_CHARS = 256;
export const HOSTED_IDENTITY_MAX_SPACES = 64;

const EpochMs = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const Opaque256 = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(43),
  Schema.isPattern(/^[A-Za-z0-9_-]{43}$/),
);
export const HubAccountId = Schema.String.check(
  Schema.isPattern(/^acct_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(48),
);
export type HubAccountId = typeof HubAccountId.Type;
export const HubBrowserSessionId = Schema.String.check(
  Schema.isPattern(/^sess_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(48),
);
export type HubBrowserSessionId = typeof HubBrowserSessionId.Type;
const SessionId = HubBrowserSessionId;
const BoundedDisplayName = Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(200));
const BoundedSpaceDisplayName = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(HUB_SPACE_DISPLAY_NAME_MAX_CHARS),
);
const BoundedPassword = Schema.String.check(
  Schema.isMinLength(HOSTED_IDENTITY_MIN_PASSWORD_CHARS),
  Schema.isMaxLength(HOSTED_IDENTITY_MAX_PASSWORD_CHARS),
);
const AntiBotAssertion = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(HOSTED_IDENTITY_MAX_ANTI_BOT_ASSERTION_CHARS),
);
const IdempotencyKey = Opaque256.pipe(Schema.brand("HostedIdentityIdempotencyKey"));
const SignupAttemptSecret = Opaque256.pipe(Schema.brand("PublicSignupAttemptSecret"));
const SignupActivationSecret = Opaque256.pipe(Schema.brand("PublicSignupActivationSecret"));
const PasswordLoginAttemptSecret = Opaque256.pipe(Schema.brand("PasswordLoginAttemptSecret"));
const PasswordResetAttemptSecret = Opaque256.pipe(Schema.brand("PasswordResetAttemptSecret"));
const NativeIdentityAttemptSecret = Opaque256.pipe(Schema.brand("NativeIdentityAttemptSecret"));
const NativeIdentityActivationSecret = Opaque256.pipe(
  Schema.brand("NativeIdentityActivationSecret"),
);
const NativeIdentityResetSecret = Opaque256.pipe(Schema.brand("NativeIdentityResetSecret"));
const NativeIdentitySessionToken = Opaque256.pipe(Schema.brand("NativeIdentitySessionToken"));
const MailToken = Opaque256.pipe(Schema.brand("HostedIdentityMailToken"));
const EmailCode = Schema.String.check(Schema.isPattern(/^[0-9]{6}$/));
const TotpCode = Schema.String.check(Schema.isPattern(/^[0-9]{6}$/));
const JsonObject = Schema.Unknown.check(
  Schema.makeFilter((value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? undefined
      : "value must be an object",
  ),
);

const strictTimed = <S extends Schema.Struct.Fields>(fields: S) =>
  rejectExcessProperties(
    Schema.Struct({
      ...fields,
      issuedAt: EpochMs,
      expiresAt: EpochMs,
    }).check(
      Schema.makeFilter((value) => {
        const timed = value as { readonly issuedAt: number; readonly expiresAt: number };
        return timed.expiresAt > timed.issuedAt ? undefined : "expiresAt must be after issuedAt";
      }),
    ),
  );

export const HubSpaceId = Schema.String.check(
  Schema.isPattern(/^space_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(49),
).pipe(Schema.brand("HubSpaceId"));
export type HubSpaceId = typeof HubSpaceId.Type;

export const HubSpaceKind = Schema.Literals(["personal", "legacy"]);
export type HubSpaceKind = typeof HubSpaceKind.Type;

export const HubSpaceRole = Schema.Literals(["viewer", "operator", "owner"]);
export type HubSpaceRole = typeof HubSpaceRole.Type;

/** A canonical, globally unique public username. Non-canonical input is rejected. */
export const HubUsername = Schema.String.check(
  Schema.isMinLength(HUB_USERNAME_MIN_CHARS),
  Schema.isMaxLength(HUB_USERNAME_MAX_CHARS),
  Schema.isPattern(/^[a-z0-9_]+$/),
).pipe(Schema.brand("HubUsername"));
export type HubUsername = typeof HubUsername.Type;

export const HubNormalizedEmail = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(HOSTED_IDENTITY_MAX_EMAIL_CHARS),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  Schema.makeFilter((value) =>
    value === value.trim() && value === value.toLowerCase()
      ? undefined
      : "email must be trimmed lowercase",
  ),
).pipe(Schema.brand("HubNormalizedEmail"));
export type HubNormalizedEmail = typeof HubNormalizedEmail.Type;

export const HubLoginIdentifier = Schema.Union([HubUsername, HubNormalizedEmail]).pipe(
  Schema.brand("HubLoginIdentifier"),
);
export type HubLoginIdentifier = typeof HubLoginIdentifier.Type;

const PublicSignupTurnstileSiteKey = Schema.String.check(
  Schema.isMinLength(10),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

/**
 * Public, cache-bypassed configuration for the signed-out account surface.
 *
 * The Turnstile site key is intentionally public. The secret verification key
 * remains server-only. `bypass` exists solely so the exact browser flow can be
 * qualified against a development Hub without pretending an anti-bot token was
 * produced by Turnstile.
 */
export const PublicSignupConfigResponse = Schema.Union([
  rejectExcessProperties(Schema.Struct({ status: Schema.Literal("disabled") })),
  rejectExcessProperties(
    Schema.Struct({
      status: Schema.Literal("enabled"),
      antiBot: rejectExcessProperties(Schema.Struct({ provider: Schema.Literal("bypass") })),
    }),
  ),
  rejectExcessProperties(
    Schema.Struct({
      status: Schema.Literal("enabled"),
      antiBot: rejectExcessProperties(
        Schema.Struct({
          provider: Schema.Literal("turnstile"),
          siteKey: PublicSignupTurnstileSiteKey,
        }),
      ),
    }),
  ),
]);
export type PublicSignupConfigResponse = typeof PublicSignupConfigResponse.Type;

export const ExternalIdentityProvider = Schema.Literal("github");
export type ExternalIdentityProvider = typeof ExternalIdentityProvider.Type;

const ExternalIdentityLogin = Schema.Trim.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(100),
  Schema.isPattern(/^[A-Za-z0-9-]+$/),
);

export const ExternalIdentitySummary = rejectExcessProperties(
  Schema.Struct({
    provider: ExternalIdentityProvider,
    login: ExternalIdentityLogin,
    displayName: Schema.NullOr(BoundedDisplayName),
    connectedAt: EpochMs,
    lastUsedAt: Schema.NullOr(EpochMs),
  }).check(
    Schema.makeFilter((value) =>
      value.lastUsedAt === null || value.lastUsedAt >= value.connectedAt
        ? undefined
        : "lastUsedAt must not precede connectedAt",
    ),
  ),
);
export type ExternalIdentitySummary = typeof ExternalIdentitySummary.Type;

export const ExternalIdentityProviderPolicy = rejectExcessProperties(
  Schema.Struct({
    provider: ExternalIdentityProvider,
    login: Schema.Literal(true),
    signup: Schema.Boolean,
    link: Schema.Literal(true),
  }),
);
export type ExternalIdentityProviderPolicy = typeof ExternalIdentityProviderPolicy.Type;

const ExternalIdentityProviders = Schema.Array(ExternalIdentityProviderPolicy).check(
  Schema.isMaxLength(1),
  Schema.makeFilter((providers) =>
    new Set(providers.map((provider) => provider.provider)).size === providers.length
      ? undefined
      : "external identity providers must be unique",
  ),
);

export const ExternalIdentityConfigResponse = rejectExcessProperties(
  Schema.Struct({
    version: Schema.Literal(EXTERNAL_IDENTITY_PROTOCOL_VERSION),
    providers: ExternalIdentityProviders,
  }),
);
export type ExternalIdentityConfigResponse = typeof ExternalIdentityConfigResponse.Type;

const ExternalIdentityReturnPath = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    if (
      !value.startsWith("/") ||
      value.startsWith("//") ||
      value.includes("\\") ||
      value.includes("#")
    ) {
      return "return path must be an unambiguous same-origin path without a fragment";
    }
    try {
      const resolved = new URL(value, "https://hub.invalid");
      return resolved.origin === "https://hub.invalid"
        ? undefined
        : "return path must be same-origin";
    } catch {
      return "return path must be valid";
    }
  }),
);

const GitHubAuthorizationUrl = Schema.String.check(
  Schema.isNonEmpty(),
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" &&
        url.hostname === "github.com" &&
        url.port === "" &&
        url.username === "" &&
        url.password === "" &&
        url.pathname === "/login/oauth/authorize" &&
        url.search.length > 1 &&
        url.hash === ""
        ? undefined
        : "authorization URL must be the canonical GitHub authorization endpoint";
    } catch {
      return "authorization URL must be absolute";
    }
  }),
);

export const ExternalIdentityAuthorizationStartRequest = rejectExcessProperties(
  Schema.Struct({
    provider: ExternalIdentityProvider,
    intent: Schema.Literals(["authenticate", "link"]),
    returnTo: Schema.optionalKey(ExternalIdentityReturnPath),
  }),
);
export type ExternalIdentityAuthorizationStartRequest =
  typeof ExternalIdentityAuthorizationStartRequest.Type;

export const ExternalIdentityAuthorizationStartResponse = rejectExcessProperties(
  Schema.Struct({
    authorizationUrl: GitHubAuthorizationUrl,
    expiresAt: EpochMs,
  }),
);
export type ExternalIdentityAuthorizationStartResponse =
  typeof ExternalIdentityAuthorizationStartResponse.Type;

export const ExternalIdentityPendingErrorCode = Schema.Literals([
  "external_provider_unavailable",
  "external_authorization_cancelled",
  "external_authorization_expired",
  "external_authorization_rejected",
  "external_identity_email_conflict",
  "external_identity_verified_email_required",
  "signup_disabled",
  "username_unavailable",
]);
export type ExternalIdentityPendingErrorCode = typeof ExternalIdentityPendingErrorCode.Type;

export const ExternalIdentityPendingResponse = Schema.Union([
  rejectExcessProperties(Schema.Struct({ status: Schema.Literal("none") })),
  rejectExcessProperties(
    Schema.Struct({
      status: Schema.Literal("signup"),
      provider: ExternalIdentityProvider,
      suggestedUsername: Schema.NullOr(HubUsername),
      displayName: Schema.NullOr(BoundedDisplayName),
      expiresAt: EpochMs,
    }),
  ),
  rejectExcessProperties(
    Schema.Struct({
      status: Schema.Literal("link"),
      externalIdentity: ExternalIdentitySummary,
      expiresAt: EpochMs,
    }),
  ),
  rejectExcessProperties(
    Schema.Struct({
      status: Schema.Literal("error"),
      provider: ExternalIdentityProvider,
      code: ExternalIdentityPendingErrorCode,
    }),
  ),
]);
export type ExternalIdentityPendingResponse = typeof ExternalIdentityPendingResponse.Type;

export const ExternalIdentitySignupFinishRequest = rejectExcessProperties(
  Schema.Struct({
    provider: ExternalIdentityProvider,
    username: HubUsername,
    antiBotAssertion: AntiBotAssertion,
    idempotencyKey: IdempotencyKey,
  }),
);
export type ExternalIdentitySignupFinishRequest = typeof ExternalIdentitySignupFinishRequest.Type;

export const BrowserExternalIdentityConnectRequest = rejectExcessProperties(
  Schema.Struct({ totpCode: Schema.optionalKey(TotpCode) }),
);
export type BrowserExternalIdentityConnectRequest =
  typeof BrowserExternalIdentityConnectRequest.Type;

export const BrowserExternalIdentityConnectResponse = rejectExcessProperties(
  Schema.Struct({
    status: Schema.Literal("connected"),
    externalIdentity: ExternalIdentitySummary,
  }),
);
export type BrowserExternalIdentityConnectResponse =
  typeof BrowserExternalIdentityConnectResponse.Type;

export const ExternalIdentityDisconnectRequest = rejectExcessProperties(
  Schema.Struct({ totpCode: Schema.optionalKey(TotpCode) }),
);
export type ExternalIdentityDisconnectRequest = typeof ExternalIdentityDisconnectRequest.Type;

export const ExternalIdentityDisconnectResponse = rejectExcessProperties(
  Schema.Struct({
    status: Schema.Literal("disconnected"),
    signedOut: Schema.Boolean,
  }),
);
export type ExternalIdentityDisconnectResponse = typeof ExternalIdentityDisconnectResponse.Type;

const ExternalIdentitySummaries = Schema.Array(ExternalIdentitySummary).check(
  Schema.isMaxLength(1),
  Schema.makeFilter((identities) =>
    new Set(identities.map((identity) => identity.provider)).size === identities.length
      ? undefined
      : "external identity providers must be unique",
  ),
);

export const HostedAccountSecurityResponse = rejectExcessProperties(
  Schema.Struct({
    passwordConfigured: Schema.Boolean,
    totpEnrolled: Schema.Boolean,
    emailDeliveryConfigured: Schema.Boolean,
    email: Schema.NullOr(
      rejectExcessProperties(
        Schema.Struct({
          address: HubNormalizedEmail,
          verified: Schema.Boolean,
        }),
      ),
    ),
    externalIdentities: ExternalIdentitySummaries,
  }),
);
export type HostedAccountSecurityResponse = typeof HostedAccountSecurityResponse.Type;

export const HubActiveSpaceSummary = rejectExcessProperties(
  Schema.Struct({
    id: HubSpaceId,
    kind: HubSpaceKind,
    displayName: BoundedSpaceDisplayName,
    role: HubSpaceRole,
  }),
);
export type HubActiveSpaceSummary = typeof HubActiveSpaceSummary.Type;

export const HubPublicAccount = rejectExcessProperties(
  Schema.Struct({
    id: HubAccountId,
    username: HubUsername,
    displayName: BoundedDisplayName,
    createdAt: EpochMs,
    disabledAt: Schema.Null,
  }),
);
export type HubPublicAccount = typeof HubPublicAccount.Type;

export const HubPublicBrowserSession = rejectExcessProperties(
  Schema.Struct({
    id: SessionId,
    accountId: HubAccountId,
    activeSpaceId: HubSpaceId,
    createdAt: EpochMs,
    expiresAt: EpochMs,
    lastSeenAt: EpochMs,
    revokedAt: Schema.Null,
    revocationReasonCode: Schema.Null,
  }).check(
    Schema.makeFilter((session) =>
      session.expiresAt > session.createdAt &&
      session.lastSeenAt >= session.createdAt &&
      session.lastSeenAt <= session.expiresAt
        ? undefined
        : "browser session timestamps are inconsistent",
    ),
  ),
);
export type HubPublicBrowserSession = typeof HubPublicBrowserSession.Type;

const HubSpaces = Schema.Array(HubActiveSpaceSummary).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(HOSTED_IDENTITY_MAX_SPACES),
);

const HubSessionIdentityFields = {
  account: HubPublicAccount,
  session: HubPublicBrowserSession,
  activeSpace: HubActiveSpaceSummary,
  spaces: HubSpaces,
} as const;

function hubSessionIdentityConsistency(value: {
  readonly account: { readonly id: string };
  readonly session: { readonly accountId: string; readonly activeSpaceId: string };
  readonly activeSpace: { readonly id: string; readonly role: string };
  readonly spaces: ReadonlyArray<{ readonly id: string; readonly role: string }>;
}): string | undefined {
  if (value.session.accountId !== value.account.id) return "session account does not match";
  if (value.session.activeSpaceId !== value.activeSpace.id) {
    return "session active space does not match";
  }
  if (new Set(value.spaces.map((space) => space.id)).size !== value.spaces.length) {
    return "spaces must contain unique ids";
  }
  const matches = value.spaces.filter((space) => space.id === value.activeSpace.id);
  return matches.length === 1 && matches[0]?.role === value.activeSpace.role
    ? undefined
    : "active space must appear exactly once in spaces";
}

export const HubBrowserSessionResponse = rejectExcessProperties(
  Schema.Struct({
    ...HubSessionIdentityFields,
    csrfToken: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(4_096)),
  }).check(Schema.makeFilter(hubSessionIdentityConsistency)),
);
export type HubBrowserSessionResponse = typeof HubBrowserSessionResponse.Type;

export const HubSessionIdentity = rejectExcessProperties(
  Schema.Struct(HubSessionIdentityFields).check(Schema.makeFilter(hubSessionIdentityConsistency)),
);
export type HubSessionIdentity = typeof HubSessionIdentity.Type;

export const NativeIdentityAttemptId = Schema.String.check(
  Schema.isPattern(/^nident_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(50),
).pipe(Schema.brand("NativeIdentityAttemptId"));
export type NativeIdentityAttemptId = typeof NativeIdentityAttemptId.Type;

export const NativeIdentityLoginAttemptId = Schema.String.check(
  Schema.isPattern(/^nlogin_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(50),
).pipe(Schema.brand("NativeIdentityLoginAttemptId"));
export type NativeIdentityLoginAttemptId = typeof NativeIdentityLoginAttemptId.Type;

export const NativeIdentityResetAttemptId = Schema.String.check(
  Schema.isPattern(/^nreset_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(50),
).pipe(Schema.brand("NativeIdentityResetAttemptId"));
export type NativeIdentityResetAttemptId = typeof NativeIdentityResetAttemptId.Type;

const NativeIdentityTimedAttempt = {
  attemptId: NativeIdentityAttemptId,
  attemptSecret: NativeIdentityAttemptSecret,
  resendAfterMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(15 * 60_000),
  ),
} as const;

export const NativeIdentityEmailStartRequest = rejectExcessProperties(
  Schema.Struct({
    email: HubNormalizedEmail,
    antiBotAssertion: AntiBotAssertion,
  }),
);
export type NativeIdentityEmailStartRequest = typeof NativeIdentityEmailStartRequest.Type;

export const NativeIdentityEmailStartResponse = strictTimed({
  status: Schema.Literal("accepted"),
  ...NativeIdentityTimedAttempt,
});
export type NativeIdentityEmailStartResponse = typeof NativeIdentityEmailStartResponse.Type;

export const NativeIdentityMailboxProof = Schema.Union([
  rejectExcessProperties(Schema.Struct({ kind: Schema.Literal("link_token"), token: MailToken })),
  rejectExcessProperties(Schema.Struct({ kind: Schema.Literal("email_code"), code: EmailCode })),
]);
export type NativeIdentityMailboxProof = typeof NativeIdentityMailboxProof.Type;

export const NativeIdentityEmailVerifyRequest = rejectExcessProperties(
  Schema.Struct({
    attemptId: NativeIdentityAttemptId,
    attemptSecret: NativeIdentityAttemptSecret,
    proof: NativeIdentityMailboxProof,
  }),
);
export type NativeIdentityEmailVerifyRequest = typeof NativeIdentityEmailVerifyRequest.Type;

export const NativeIdentityEmailVerifyResponse = Schema.Union([
  strictTimed({
    status: Schema.Literal("existing_account"),
    attemptId: NativeIdentityAttemptId,
    activationSecret: NativeIdentityActivationSecret,
  }),
  strictTimed({
    status: Schema.Literal("new_account"),
    attemptId: NativeIdentityAttemptId,
    activationSecret: NativeIdentityActivationSecret,
  }),
]);
export type NativeIdentityEmailVerifyResponse = typeof NativeIdentityEmailVerifyResponse.Type;

const NativeIdentityActivation = {
  attemptId: NativeIdentityAttemptId,
  activationSecret: NativeIdentityActivationSecret,
} as const;

export const NativeIdentitySignupUsernameRequest = rejectExcessProperties(
  Schema.Struct({ ...NativeIdentityActivation, username: HubUsername }),
);
export type NativeIdentitySignupUsernameRequest = typeof NativeIdentitySignupUsernameRequest.Type;

export const NativeIdentitySignupUsernameResponse = rejectExcessProperties(
  Schema.Struct({ status: Schema.Literal("claimed") }),
);
export type NativeIdentitySignupUsernameResponse = typeof NativeIdentitySignupUsernameResponse.Type;

export const NativeIdentitySignupPasskeyOptionsRequest = rejectExcessProperties(
  Schema.Struct(NativeIdentityActivation),
);
export type NativeIdentitySignupPasskeyOptionsRequest =
  typeof NativeIdentitySignupPasskeyOptionsRequest.Type;

export const NativeIdentitySignupPasskeyOptionsResponse = rejectExcessProperties(
  Schema.Struct({ options: JsonObject }),
);
export type NativeIdentitySignupPasskeyOptionsResponse =
  typeof NativeIdentitySignupPasskeyOptionsResponse.Type;

export const NativeIdentitySignupPasskeyFinishRequest = rejectExcessProperties(
  Schema.Struct({
    ...NativeIdentityActivation,
    response: JsonObject,
    idempotencyKey: IdempotencyKey,
  }),
);
export type NativeIdentitySignupPasskeyFinishRequest =
  typeof NativeIdentitySignupPasskeyFinishRequest.Type;

export const NativeIdentitySignupPasswordFinishRequest = rejectExcessProperties(
  Schema.Struct({
    ...NativeIdentityActivation,
    password: BoundedPassword,
    idempotencyKey: IdempotencyKey,
  }),
);
export type NativeIdentitySignupPasswordFinishRequest =
  typeof NativeIdentitySignupPasswordFinishRequest.Type;

export const NativeIdentitySessionResponse = rejectExcessProperties(
  Schema.Struct({
    status: Schema.Literal("complete"),
    identity: HubSessionIdentity,
    token: NativeIdentitySessionToken,
  }),
);
export type NativeIdentitySessionResponse = typeof NativeIdentitySessionResponse.Type;

const NativeIdentityRecoveryCodes = Schema.Array(
  Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
).check(Schema.isMinLength(1), Schema.isMaxLength(256));

export const NativeIdentitySignupFinishResponse = rejectExcessProperties(
  Schema.Struct({
    status: Schema.Literal("complete"),
    identity: HubSessionIdentity,
    token: NativeIdentitySessionToken,
    recoveryCodes: NativeIdentityRecoveryCodes,
  }),
);
export type NativeIdentitySignupFinishResponse = typeof NativeIdentitySignupFinishResponse.Type;

export const NativeIdentityPasswordStartRequest = Schema.Union([
  rejectExcessProperties(
    Schema.Struct({
      kind: Schema.Literal("username"),
      username: HubUsername,
      password: BoundedPassword,
      antiBotAssertion: Schema.optionalKey(AntiBotAssertion),
    }),
  ),
  rejectExcessProperties(
    Schema.Struct({
      kind: Schema.Literal("verified_email"),
      ...NativeIdentityActivation,
      password: BoundedPassword,
    }),
  ),
]);
export type NativeIdentityPasswordStartRequest = typeof NativeIdentityPasswordStartRequest.Type;

export const NativeIdentityPasswordStartResponse = strictTimed({
  status: Schema.Literal("factor_required"),
  attemptId: NativeIdentityLoginAttemptId,
  attemptSecret: NativeIdentityAttemptSecret,
  factor: Schema.Literals(["totp", "email_code"]),
});
export type NativeIdentityPasswordStartResponse = typeof NativeIdentityPasswordStartResponse.Type;

export const NativeIdentityPasswordFinishRequest = Schema.Union([
  rejectExcessProperties(
    Schema.Struct({
      attemptId: NativeIdentityLoginAttemptId,
      attemptSecret: NativeIdentityAttemptSecret,
      factor: Schema.Literal("totp"),
      code: TotpCode,
    }),
  ),
  rejectExcessProperties(
    Schema.Struct({
      attemptId: NativeIdentityLoginAttemptId,
      attemptSecret: NativeIdentityAttemptSecret,
      factor: Schema.Literal("email_code"),
      code: EmailCode,
    }),
  ),
]);
export type NativeIdentityPasswordFinishRequest = typeof NativeIdentityPasswordFinishRequest.Type;

export const NativeIdentityRecoveryCodeRequest = rejectExcessProperties(
  Schema.Struct({
    code: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
    idempotencyKey: IdempotencyKey,
  }),
);
export type NativeIdentityRecoveryCodeRequest = typeof NativeIdentityRecoveryCodeRequest.Type;

export const NativeIdentityRecoveryResponse = NativeIdentitySignupFinishResponse;
export type NativeIdentityRecoveryResponse = typeof NativeIdentityRecoveryResponse.Type;

export const NativeIdentityPasswordResetRequest = rejectExcessProperties(
  Schema.Struct({
    identifier: HubLoginIdentifier,
    antiBotAssertion: Schema.optionalKey(AntiBotAssertion),
  }),
);
export type NativeIdentityPasswordResetRequest = typeof NativeIdentityPasswordResetRequest.Type;

export const NativeIdentityPasswordResetResponse = strictTimed({
  status: Schema.Literal("accepted"),
  attemptId: NativeIdentityResetAttemptId,
  attemptSecret: NativeIdentityAttemptSecret,
  resendAfterMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(15 * 60_000),
  ),
});
export type NativeIdentityPasswordResetResponse = typeof NativeIdentityPasswordResetResponse.Type;

export const NativeIdentityPasswordResetVerifyRequest = rejectExcessProperties(
  Schema.Struct({
    attemptId: NativeIdentityResetAttemptId,
    attemptSecret: NativeIdentityAttemptSecret,
    proof: NativeIdentityMailboxProof,
  }),
);
export type NativeIdentityPasswordResetVerifyRequest =
  typeof NativeIdentityPasswordResetVerifyRequest.Type;

export const NativeIdentityPasswordResetVerifyResponse = strictTimed({
  status: Schema.Literal("verified"),
  attemptId: NativeIdentityResetAttemptId,
  resetSecret: NativeIdentityResetSecret,
  requiresTotp: Schema.Boolean,
});
export type NativeIdentityPasswordResetVerifyResponse =
  typeof NativeIdentityPasswordResetVerifyResponse.Type;

export const NativeIdentityPasswordResetFinishRequest = rejectExcessProperties(
  Schema.Struct({
    attemptId: NativeIdentityResetAttemptId,
    resetSecret: NativeIdentityResetSecret,
    password: BoundedPassword,
    factor: Schema.Union([
      rejectExcessProperties(Schema.Struct({ kind: Schema.Literal("none") })),
      rejectExcessProperties(Schema.Struct({ kind: Schema.Literal("totp"), code: TotpCode })),
    ]),
  }),
);
export type NativeIdentityPasswordResetFinishRequest =
  typeof NativeIdentityPasswordResetFinishRequest.Type;

export const NativeIdentityPasswordResetFinishResponse = rejectExcessProperties(
  Schema.Struct({ status: Schema.Literal("complete") }),
);
export type NativeIdentityPasswordResetFinishResponse =
  typeof NativeIdentityPasswordResetFinishResponse.Type;

export const NativeIdentityAttemptCancelRequest = rejectExcessProperties(
  Schema.Struct({
    attemptId: Schema.Union([
      NativeIdentityAttemptId,
      NativeIdentityLoginAttemptId,
      NativeIdentityResetAttemptId,
    ]),
    // Pending attempts use the attempt secret. Once email verification has
    // promoted a signup attempt, this endpoint accepts the activation secret;
    // both remain opaque 256-bit values on the wire.
    attemptSecret: Schema.Union([NativeIdentityAttemptSecret, NativeIdentityActivationSecret]),
  }),
);
export type NativeIdentityAttemptCancelRequest = typeof NativeIdentityAttemptCancelRequest.Type;

export const NativeIdentityAttemptCancelResponse = rejectExcessProperties(
  Schema.Struct({ status: Schema.Literal("cancelled") }),
);
export type NativeIdentityAttemptCancelResponse = typeof NativeIdentityAttemptCancelResponse.Type;

export const PublicSignupAttemptId = Schema.String.check(
  Schema.isPattern(/^signup_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(50),
).pipe(Schema.brand("PublicSignupAttemptId"));
export type PublicSignupAttemptId = typeof PublicSignupAttemptId.Type;

export const PublicSignupStartRequest = rejectExcessProperties(
  Schema.Struct({
    username: HubUsername,
    email: HubNormalizedEmail,
    antiBotAssertion: AntiBotAssertion,
    invitationToken: Schema.optional(MailToken),
  }),
);
export type PublicSignupStartRequest = typeof PublicSignupStartRequest.Type;

export const PublicSignupStartResponse = strictTimed({
  status: Schema.Literal("accepted"),
  attemptId: PublicSignupAttemptId,
  attemptSecret: SignupAttemptSecret,
  resendAfterMs: Schema.Int.check(
    Schema.isGreaterThanOrEqualTo(0),
    Schema.isLessThanOrEqualTo(15 * 60_000),
  ),
});
export type PublicSignupStartResponse = typeof PublicSignupStartResponse.Type;

export const PublicSignupMailboxProof = Schema.Union([
  rejectExcessProperties(Schema.Struct({ kind: Schema.Literal("link_token"), token: MailToken })),
  rejectExcessProperties(Schema.Struct({ kind: Schema.Literal("email_code"), code: EmailCode })),
]);
export type PublicSignupMailboxProof = typeof PublicSignupMailboxProof.Type;

export const PublicSignupVerifyRequest = rejectExcessProperties(
  Schema.Struct({
    attemptId: PublicSignupAttemptId,
    attemptSecret: SignupAttemptSecret,
    proof: PublicSignupMailboxProof,
  }),
);
export type PublicSignupVerifyRequest = typeof PublicSignupVerifyRequest.Type;

export const PublicSignupVerifyResponse = strictTimed({
  status: Schema.Literal("verified"),
  attemptId: PublicSignupAttemptId,
  activationSecret: SignupActivationSecret,
});
export type PublicSignupVerifyResponse = typeof PublicSignupVerifyResponse.Type;

const PublicSignupActivation = {
  attemptId: PublicSignupAttemptId,
  activationSecret: SignupActivationSecret,
} as const;

export const PublicSignupPasskeyOptionsRequest = rejectExcessProperties(
  Schema.Struct(PublicSignupActivation),
);
export type PublicSignupPasskeyOptionsRequest = typeof PublicSignupPasskeyOptionsRequest.Type;

export const PublicSignupPasskeyOptionsResponse = rejectExcessProperties(
  Schema.Struct({ options: JsonObject }),
);
export type PublicSignupPasskeyOptionsResponse = typeof PublicSignupPasskeyOptionsResponse.Type;

export const PublicSignupPasskeyFinishRequest = rejectExcessProperties(
  Schema.Struct({
    ...PublicSignupActivation,
    response: JsonObject,
    idempotencyKey: IdempotencyKey,
  }),
);
export type PublicSignupPasskeyFinishRequest = typeof PublicSignupPasskeyFinishRequest.Type;

export const PublicSignupPasswordFinishRequest = rejectExcessProperties(
  Schema.Struct({
    ...PublicSignupActivation,
    password: BoundedPassword,
    idempotencyKey: IdempotencyKey,
  }),
);
export type PublicSignupPasswordFinishRequest = typeof PublicSignupPasswordFinishRequest.Type;

export const PublicSignupFinishResponse = rejectExcessProperties(
  Schema.Struct({
    status: Schema.Literal("complete"),
    identity: HubBrowserSessionResponse,
    recoveryCodes: Schema.Array(
      Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(512)),
    ).check(Schema.isMinLength(1), Schema.isMaxLength(256)),
  }),
);
export type PublicSignupFinishResponse = typeof PublicSignupFinishResponse.Type;

// GitHub-backed signup creates the same Ryco browser session and one-time
// recovery-code handoff as the existing verified-email signup flow.
export const ExternalIdentitySignupFinishResponse = PublicSignupFinishResponse;
export type ExternalIdentitySignupFinishResponse = typeof ExternalIdentitySignupFinishResponse.Type;

export const PasswordLoginAttemptId = Schema.String.check(
  Schema.isPattern(/^login_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(49),
).pipe(Schema.brand("PasswordLoginAttemptId"));
export type PasswordLoginAttemptId = typeof PasswordLoginAttemptId.Type;

export const PasswordLoginFactor = Schema.Literals(["totp", "email_code"]);
export type PasswordLoginFactor = typeof PasswordLoginFactor.Type;

export const PasswordLoginStartRequest = rejectExcessProperties(
  Schema.Struct({
    identifier: HubLoginIdentifier,
    password: BoundedPassword,
    antiBotAssertion: Schema.optional(AntiBotAssertion),
  }),
);
export type PasswordLoginStartRequest = typeof PasswordLoginStartRequest.Type;

export const PasswordLoginStartResponse = strictTimed({
  status: Schema.Literal("factor_required"),
  attemptId: PasswordLoginAttemptId,
  attemptSecret: PasswordLoginAttemptSecret,
  factor: PasswordLoginFactor,
});
export type PasswordLoginStartResponse = typeof PasswordLoginStartResponse.Type;

export const PasswordLoginFinishRequest = Schema.Union([
  rejectExcessProperties(
    Schema.Struct({
      attemptId: PasswordLoginAttemptId,
      attemptSecret: PasswordLoginAttemptSecret,
      factor: Schema.Literal("totp"),
      code: TotpCode,
    }),
  ),
  rejectExcessProperties(
    Schema.Struct({
      attemptId: PasswordLoginAttemptId,
      attemptSecret: PasswordLoginAttemptSecret,
      factor: Schema.Literal("email_code"),
      code: EmailCode,
    }),
  ),
]);
export type PasswordLoginFinishRequest = typeof PasswordLoginFinishRequest.Type;

export const PasswordResetRequest = rejectExcessProperties(
  Schema.Struct({
    identifier: HubLoginIdentifier,
    antiBotAssertion: Schema.optional(AntiBotAssertion),
  }),
);
export type PasswordResetRequest = typeof PasswordResetRequest.Type;

export const PasswordResetRequestResponse = rejectExcessProperties(
  Schema.Struct({ status: Schema.Literal("accepted") }),
);
export type PasswordResetRequestResponse = typeof PasswordResetRequestResponse.Type;

export const PasswordResetAttemptId = Schema.String.check(
  Schema.isPattern(/^reset_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(49),
).pipe(Schema.brand("PasswordResetAttemptId"));
export type PasswordResetAttemptId = typeof PasswordResetAttemptId.Type;

export const PasswordResetVerifyRequest = rejectExcessProperties(
  Schema.Struct({ token: MailToken }),
);
export type PasswordResetVerifyRequest = typeof PasswordResetVerifyRequest.Type;

export const PasswordResetVerifyResponse = strictTimed({
  status: Schema.Literal("verified"),
  attemptId: PasswordResetAttemptId,
  attemptSecret: PasswordResetAttemptSecret,
  requiresTotp: Schema.Boolean,
});
export type PasswordResetVerifyResponse = typeof PasswordResetVerifyResponse.Type;

export const PasswordResetFactor = Schema.Union([
  rejectExcessProperties(Schema.Struct({ kind: Schema.Literal("none") })),
  rejectExcessProperties(Schema.Struct({ kind: Schema.Literal("totp"), code: TotpCode })),
]);
export type PasswordResetFactor = typeof PasswordResetFactor.Type;

export const PasswordResetFinishRequest = rejectExcessProperties(
  Schema.Struct({
    attemptId: PasswordResetAttemptId,
    attemptSecret: PasswordResetAttemptSecret,
    password: BoundedPassword,
    factor: PasswordResetFactor,
  }),
);
export type PasswordResetFinishRequest = typeof PasswordResetFinishRequest.Type;

export const PasswordResetFinishResponse = rejectExcessProperties(
  Schema.Struct({ status: Schema.Literal("complete") }),
);
export type PasswordResetFinishResponse = typeof PasswordResetFinishResponse.Type;

export const ActiveSpaceSwitchRequest = rejectExcessProperties(
  Schema.Struct({ spaceId: HubSpaceId }),
);
export type ActiveSpaceSwitchRequest = typeof ActiveSpaceSwitchRequest.Type;

export const ActiveSpaceSwitchResponse = rejectExcessProperties(
  Schema.Struct({
    activeSpace: HubActiveSpaceSummary,
    spaces: HubSpaces,
  }).check(
    Schema.makeFilter((value) => {
      if (new Set(value.spaces.map((space) => space.id)).size !== value.spaces.length) {
        return "spaces must contain unique ids";
      }
      const matches = value.spaces.filter((space) => space.id === value.activeSpace.id);
      return matches.length === 1 && matches[0]?.role === value.activeSpace.role
        ? undefined
        : "active space must appear exactly once in spaces";
    }),
  ),
);
export type ActiveSpaceSwitchResponse = typeof ActiveSpaceSwitchResponse.Type;

export const DesktopInstallationId = Schema.String.check(
  Schema.isPattern(/^install_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(51),
).pipe(Schema.brand("DesktopInstallationId"));
export type DesktopInstallationId = typeof DesktopInstallationId.Type;

export const NativeNodeClaimId = Schema.String.check(
  Schema.isPattern(/^nclaim_[A-Za-z0-9_-]{22,43}$/),
  Schema.isMaxLength(50),
).pipe(Schema.brand("NativeNodeClaimId"));
export type NativeNodeClaimId = typeof NativeNodeClaimId.Type;

export const NativeNodeClaimEnvironmentId = Schema.String.check(
  Schema.isPattern(/^env_[A-Za-z0-9_-]{22}$/),
  Schema.isMaxLength(26),
).pipe(Schema.brand("NativeNodeClaimEnvironmentId"));
export type NativeNodeClaimEnvironmentId = typeof NativeNodeClaimEnvironmentId.Type;

export const NativeNodeClaimPublicKey = Schema.String.check(
  Schema.isMinLength(43),
  Schema.isMaxLength(43),
  Schema.isPattern(/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/),
).pipe(Schema.brand("NativeNodeClaimPublicKey"));
export type NativeNodeClaimPublicKey = typeof NativeNodeClaimPublicKey.Type;

const NativeNodeClaimMetadata = rejectExcessProperties(
  Schema.Struct({
    environmentId: NativeNodeClaimEnvironmentId,
    label: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
    platformOs: Schema.Literals(["darwin", "linux", "windows", "unknown"]),
    platformArch: Schema.Literals(["arm64", "x64", "other"]),
    clientVersion: Schema.String.check(Schema.isNonEmpty(), Schema.isMaxLength(64)),
    algorithm: Schema.Literal("ed25519"),
    publicKey: NativeNodeClaimPublicKey,
    fingerprint: HubNodePublicKeyFingerprint,
  }),
);

export const NativeNodeClaimStartRequest = rejectExcessProperties(
  Schema.Struct({
    installationId: DesktopInstallationId,
    node: NativeNodeClaimMetadata,
  }),
);
export type NativeNodeClaimStartRequest = typeof NativeNodeClaimStartRequest.Type;

export const NativeNodeClaimStartResponse = strictTimed({
  protocolVersion: Schema.Literal(HOSTED_IDENTITY_PROTOCOL_VERSION),
  transcriptVersion: Schema.Literal(NATIVE_NODE_CLAIM_TRANSCRIPT_VERSION),
  claimId: NativeNodeClaimId,
  challenge: Opaque256,
  accountId: HubAccountId,
  spaceId: HubSpaceId,
  sessionId: SessionId,
  dpopKeyThumbprint: Opaque256,
  installationId: DesktopInstallationId,
  environmentId: NativeNodeClaimEnvironmentId,
  nodeFingerprint: HubNodePublicKeyFingerprint,
});
export type NativeNodeClaimStartResponse = typeof NativeNodeClaimStartResponse.Type;

export const NativeNodeClaimFinishRequest = rejectExcessProperties(
  Schema.Struct({
    claimId: NativeNodeClaimId,
    challenge: Opaque256,
    signature: Schema.String.check(
      Schema.isMinLength(86),
      Schema.isMaxLength(86),
      Schema.isPattern(/^[A-Za-z0-9_-]{85}[AQgw]$/),
    ),
    idempotencyKey: IdempotencyKey,
  }),
);
export type NativeNodeClaimFinishRequest = typeof NativeNodeClaimFinishRequest.Type;

export const NativeNodeClaimFinishResponse = rejectExcessProperties(
  Schema.Struct({
    status: Schema.Literal("claimed"),
    disposition: Schema.Literals(["created", "reconnected"]),
    node: rejectExcessProperties(
      Schema.Struct({
        id: RelayNodeId,
        activeKeyId: Schema.String.check(
          Schema.isPattern(/^nkey_[A-Za-z0-9_-]{22}$/),
          Schema.isMaxLength(27),
        ),
        environmentId: NativeNodeClaimEnvironmentId,
        label: Schema.Trim.check(Schema.isNonEmpty(), Schema.isMaxLength(100)),
        fingerprint: HubNodePublicKeyFingerprint,
        effectiveRole: Schema.Literal("owner"),
      }),
    ),
  }),
);
export type NativeNodeClaimFinishResponse = typeof NativeNodeClaimFinishResponse.Type;

export const NativeNodeClaimError = Schema.Union([
  rejectExcessProperties(
    Schema.Struct({
      error: Schema.Literal("node_claim_rejected"),
      retryable: Schema.Literal(false),
    }),
  ),
  rejectExcessProperties(
    Schema.Struct({
      error: Schema.Literal("node_claim_unavailable"),
      retryable: Schema.Literal(true),
      retryAfterMs: Schema.optional(
        Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(300_000)),
      ),
    }),
  ),
]);
export type NativeNodeClaimError = typeof NativeNodeClaimError.Type;
