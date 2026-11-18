import { describe, expect, it } from "@effect/vitest";
import { Schema } from "effect";

import {
  ACTIVE_SPACE_SWITCH_PATH,
  ActiveSpaceSwitchResponse,
  EXTERNAL_IDENTITY_CONFIG_PATH,
  EXTERNAL_IDENTITY_GITHUB_CALLBACK_PATH,
  EXTERNAL_IDENTITY_PENDING_PATH,
  EXTERNAL_IDENTITY_PROTOCOL_VERSION,
  EXTERNAL_IDENTITY_SIGNUP_FINISH_PATH,
  EXTERNAL_IDENTITY_START_PATH,
  ExternalIdentityAuthorizationStartRequest,
  ExternalIdentityAuthorizationStartResponse,
  ExternalIdentityConfigResponse,
  ExternalIdentityPendingResponse,
  ExternalIdentitySignupFinishRequest,
  GITHUB_EXTERNAL_IDENTITY_CONNECT_PATH,
  GITHUB_EXTERNAL_IDENTITY_DISCONNECT_PATH,
  HostedAccountEmailResponse,
  HostedAccountSecurityResponse,
  BrowserExternalIdentityConnectRequest,
  BrowserExternalIdentityConnectResponse,
  ExternalIdentityDisconnectRequest,
  ExternalIdentityDisconnectResponse,
  HOSTED_IDENTITY_PROTOCOL_VERSION,
  HubAccountId,
  HubBrowserSessionResponse,
  HubNormalizedEmail,
  HubSpaceId,
  HubUsername,
  NATIVE_NODE_CLAIM_FINISH_PATH,
  NATIVE_NODE_CLAIM_START_PATH,
  NATIVE_NODE_CLAIM_TRANSCRIPT_VERSION,
  NATIVE_IDENTITY_ATTEMPT_CANCEL_PATH,
  NATIVE_IDENTITY_EMAIL_START_PATH,
  NATIVE_IDENTITY_EMAIL_VERIFY_PATH,
  NATIVE_IDENTITY_PASSWORD_FINISH_PATH,
  NATIVE_IDENTITY_PASSWORD_RESET_FINISH_PATH,
  NATIVE_IDENTITY_PASSWORD_RESET_REQUEST_PATH,
  NATIVE_IDENTITY_PASSWORD_RESET_VERIFY_PATH,
  NATIVE_IDENTITY_PASSWORD_START_PATH,
  NATIVE_IDENTITY_PROTOCOL_VERSION,
  NATIVE_IDENTITY_RECOVERY_CODE_PATH,
  NATIVE_IDENTITY_SIGNUP_PASSKEY_FINISH_PATH,
  NATIVE_IDENTITY_SIGNUP_PASSKEY_OPTIONS_PATH,
  NATIVE_IDENTITY_SIGNUP_PASSWORD_FINISH_PATH,
  NATIVE_IDENTITY_SIGNUP_USERNAME_PATH,
  NativeIdentityAttemptCancelRequest,
  NativeIdentityAttemptCancelResponse,
  NativeIdentityEmailStartRequest,
  NativeIdentityEmailStartResponse,
  NativeIdentityEmailVerifyRequest,
  NativeIdentityEmailVerifyResponse,
  NativeIdentityPasswordFinishRequest,
  NativeIdentityPasswordResetFinishRequest,
  NativeIdentityPasswordResetFinishResponse,
  NativeIdentityPasswordResetRequest,
  NativeIdentityPasswordResetResponse,
  NativeIdentityPasswordResetVerifyRequest,
  NativeIdentityPasswordResetVerifyResponse,
  NativeIdentityPasswordStartRequest,
  NativeIdentityPasswordStartResponse,
  NativeIdentityRecoveryCodeRequest,
  NativeIdentityRecoveryResponse,
  NativeIdentitySessionResponse,
  NativeIdentitySignupFinishResponse,
  NativeIdentitySignupPasskeyFinishRequest,
  NativeIdentitySignupPasskeyOptionsRequest,
  NativeIdentitySignupPasskeyOptionsResponse,
  NativeIdentitySignupPasswordFinishRequest,
  NativeIdentitySignupUsernameRequest,
  NativeIdentitySignupUsernameResponse,
  NativeNodeClaimError,
  NativeNodeClaimFinishRequest,
  NativeNodeClaimFinishResponse,
  NativeNodeClaimStartRequest,
  NativeNodeClaimStartResponse,
  PASSWORD_LOGIN_FINISH_PATH,
  PASSWORD_LOGIN_START_PATH,
  PASSWORD_RESET_FINISH_PATH,
  PASSWORD_RESET_REQUEST_PATH,
  PASSWORD_RESET_VERIFY_PATH,
  PUBLIC_SIGNUP_PASSKEY_FINISH_PATH,
  PUBLIC_SIGNUP_PASSKEY_OPTIONS_PATH,
  PUBLIC_SIGNUP_PASSWORD_FINISH_PATH,
  PUBLIC_SIGNUP_CONFIG_PATH,
  PUBLIC_SIGNUP_START_PATH,
  PUBLIC_SIGNUP_VERIFY_PATH,
  PasswordLoginFinishRequest,
  PasswordLoginStartRequest,
  PasswordLoginStartResponse,
  PasswordResetFinishRequest,
  PasswordResetFinishResponse,
  PasswordResetRequest,
  PasswordResetRequestResponse,
  PasswordResetVerifyRequest,
  PasswordResetVerifyResponse,
  PublicSignupFinishResponse,
  PublicSignupConfigResponse,
  PublicSignupPasskeyFinishRequest,
  PublicSignupPasskeyOptionsRequest,
  PublicSignupPasskeyOptionsResponse,
  PublicSignupPasswordFinishRequest,
  PublicSignupStartRequest,
  PublicSignupStartResponse,
  PublicSignupVerifyRequest,
  PublicSignupVerifyResponse,
} from "./hostedIdentity.ts";

const opaque = "A".repeat(43);
const opaqueB = "B".repeat(43);
const opaqueC = "C".repeat(43);
const accountId = "acct_aaaaaaaaaaaaaaaaaaaaaa";
const sessionId = "sess_aaaaaaaaaaaaaaaaaaaaaa";
const spaceId = "space_aaaaaaaaaaaaaaaaaaaaaa";
const otherSpaceId = "space_bbbbbbbbbbbbbbbbbbbaaa";
const issuedAt = 1_752_710_400_000;
const expiresAt = issuedAt + 15 * 60_000;

const strictDecode = <S extends Schema.Top>(schema: S, input: unknown): S["Type"] =>
  Schema.decodeUnknownSync(schema as unknown as Schema.Decoder<unknown>)(input, {
    onExcessProperty: "error",
  }) as S["Type"];

const activeSpace = {
  id: spaceId,
  kind: "personal",
  displayName: "Ada's space",
  role: "owner",
} as const;

const browserIdentity = {
  account: {
    id: accountId,
    username: "ada_dev",
    displayName: "Ada",
    createdAt: issuedAt,
    disabledAt: null,
  },
  session: {
    id: sessionId,
    accountId,
    activeSpaceId: spaceId,
    createdAt: issuedAt,
    expiresAt: issuedAt + 86_400_000,
    lastSeenAt: issuedAt,
    revokedAt: null,
    revocationReasonCode: null,
  },
  activeSpace,
  spaces: [activeSpace],
  csrfToken: "csrf-sensitive-canary",
} as const;

describe("hosted identity route and version constants", () => {
  it("pins all public identity and native claim routes", () => {
    expect({
      PUBLIC_SIGNUP_START_PATH,
      PUBLIC_SIGNUP_CONFIG_PATH,
      PUBLIC_SIGNUP_VERIFY_PATH,
      PUBLIC_SIGNUP_PASSKEY_OPTIONS_PATH,
      PUBLIC_SIGNUP_PASSKEY_FINISH_PATH,
      PUBLIC_SIGNUP_PASSWORD_FINISH_PATH,
      PASSWORD_LOGIN_START_PATH,
      PASSWORD_LOGIN_FINISH_PATH,
      PASSWORD_RESET_REQUEST_PATH,
      PASSWORD_RESET_VERIFY_PATH,
      PASSWORD_RESET_FINISH_PATH,
      ACTIVE_SPACE_SWITCH_PATH,
      NATIVE_NODE_CLAIM_START_PATH,
      NATIVE_NODE_CLAIM_FINISH_PATH,
      NATIVE_IDENTITY_EMAIL_START_PATH,
      NATIVE_IDENTITY_EMAIL_VERIFY_PATH,
      NATIVE_IDENTITY_SIGNUP_USERNAME_PATH,
      NATIVE_IDENTITY_SIGNUP_PASSKEY_OPTIONS_PATH,
      NATIVE_IDENTITY_SIGNUP_PASSKEY_FINISH_PATH,
      NATIVE_IDENTITY_SIGNUP_PASSWORD_FINISH_PATH,
      NATIVE_IDENTITY_PASSWORD_START_PATH,
      NATIVE_IDENTITY_PASSWORD_FINISH_PATH,
      NATIVE_IDENTITY_RECOVERY_CODE_PATH,
      NATIVE_IDENTITY_PASSWORD_RESET_REQUEST_PATH,
      NATIVE_IDENTITY_PASSWORD_RESET_VERIFY_PATH,
      NATIVE_IDENTITY_PASSWORD_RESET_FINISH_PATH,
      NATIVE_IDENTITY_ATTEMPT_CANCEL_PATH,
      EXTERNAL_IDENTITY_CONFIG_PATH,
      EXTERNAL_IDENTITY_START_PATH,
      EXTERNAL_IDENTITY_PENDING_PATH,
      EXTERNAL_IDENTITY_SIGNUP_FINISH_PATH,
      GITHUB_EXTERNAL_IDENTITY_CONNECT_PATH,
      GITHUB_EXTERNAL_IDENTITY_DISCONNECT_PATH,
      EXTERNAL_IDENTITY_GITHUB_CALLBACK_PATH,
    }).toEqual({
      PUBLIC_SIGNUP_START_PATH: "/api/public-signup/start",
      PUBLIC_SIGNUP_CONFIG_PATH: "/api/public-signup/config",
      PUBLIC_SIGNUP_VERIFY_PATH: "/api/public-signup/verify",
      PUBLIC_SIGNUP_PASSKEY_OPTIONS_PATH: "/api/public-signup/passkey/options",
      PUBLIC_SIGNUP_PASSKEY_FINISH_PATH: "/api/public-signup/passkey/finish",
      PUBLIC_SIGNUP_PASSWORD_FINISH_PATH: "/api/public-signup/password/finish",
      PASSWORD_LOGIN_START_PATH: "/api/auth/password/start",
      PASSWORD_LOGIN_FINISH_PATH: "/api/auth/password/finish",
      PASSWORD_RESET_REQUEST_PATH: "/api/auth/password-reset/request",
      PASSWORD_RESET_VERIFY_PATH: "/api/auth/password-reset/verify",
      PASSWORD_RESET_FINISH_PATH: "/api/auth/password-reset/finish",
      ACTIVE_SPACE_SWITCH_PATH: "/api/auth/spaces/active",
      NATIVE_NODE_CLAIM_START_PATH: "/api/native/node-claims/start",
      NATIVE_NODE_CLAIM_FINISH_PATH: "/api/native/node-claims/finish",
      NATIVE_IDENTITY_EMAIL_START_PATH: "/api/auth/native/identity/email/start",
      NATIVE_IDENTITY_EMAIL_VERIFY_PATH: "/api/auth/native/identity/email/verify",
      NATIVE_IDENTITY_SIGNUP_USERNAME_PATH: "/api/auth/native/identity/signup/username",
      NATIVE_IDENTITY_SIGNUP_PASSKEY_OPTIONS_PATH:
        "/api/auth/native/identity/signup/passkey/options",
      NATIVE_IDENTITY_SIGNUP_PASSKEY_FINISH_PATH: "/api/auth/native/identity/signup/passkey/finish",
      NATIVE_IDENTITY_SIGNUP_PASSWORD_FINISH_PATH:
        "/api/auth/native/identity/signup/password/finish",
      NATIVE_IDENTITY_PASSWORD_START_PATH: "/api/auth/native/identity/password/start",
      NATIVE_IDENTITY_PASSWORD_FINISH_PATH: "/api/auth/native/identity/password/finish",
      NATIVE_IDENTITY_RECOVERY_CODE_PATH: "/api/auth/native/identity/recovery-code",
      NATIVE_IDENTITY_PASSWORD_RESET_REQUEST_PATH:
        "/api/auth/native/identity/password-reset/request",
      NATIVE_IDENTITY_PASSWORD_RESET_VERIFY_PATH: "/api/auth/native/identity/password-reset/verify",
      NATIVE_IDENTITY_PASSWORD_RESET_FINISH_PATH: "/api/auth/native/identity/password-reset/finish",
      NATIVE_IDENTITY_ATTEMPT_CANCEL_PATH: "/api/auth/native/identity/attempt/cancel",
      EXTERNAL_IDENTITY_CONFIG_PATH: "/api/auth/external/config",
      EXTERNAL_IDENTITY_START_PATH: "/api/auth/external/start",
      EXTERNAL_IDENTITY_PENDING_PATH: "/api/auth/external/pending",
      EXTERNAL_IDENTITY_SIGNUP_FINISH_PATH: "/api/auth/external/signup/finish",
      GITHUB_EXTERNAL_IDENTITY_CONNECT_PATH: "/api/account/external-identities/github/connect",
      GITHUB_EXTERNAL_IDENTITY_DISCONNECT_PATH:
        "/api/account/external-identities/github/disconnect",
      EXTERNAL_IDENTITY_GITHUB_CALLBACK_PATH: "/api/auth/external/github/callback",
    });
    expect(HOSTED_IDENTITY_PROTOCOL_VERSION).toBe(1);
    expect(NATIVE_NODE_CLAIM_TRANSCRIPT_VERSION).toBe(1);
    expect(NATIVE_IDENTITY_PROTOCOL_VERSION).toBe(2);
    expect(EXTERNAL_IDENTITY_PROTOCOL_VERSION).toBe(1);
  });
});

describe("external identity contracts", () => {
  const summary = {
    provider: "github",
    login: "octocat",
    displayName: "The Octocat",
    connectedAt: issuedAt,
    lastUsedAt: issuedAt + 1_000,
  } as const;

  it("accepts a versioned empty or GitHub-only provider policy", () => {
    expect(strictDecode(ExternalIdentityConfigResponse, { version: 1, providers: [] })).toEqual({
      version: 1,
      providers: [],
    });
    expect(
      strictDecode(ExternalIdentityConfigResponse, {
        version: 1,
        providers: [{ provider: "github", login: true, signup: false, link: true }],
      }),
    ).toBeTruthy();

    for (const invalid of [
      { version: 2, providers: [] },
      {
        version: 1,
        providers: [{ provider: "gitlab", login: true, signup: true, link: true }],
      },
      {
        version: 1,
        providers: [
          { provider: "github", login: true, signup: true, link: true },
          { provider: "github", login: true, signup: true, link: true },
        ],
      },
      {
        version: 1,
        providers: [
          {
            provider: "github",
            login: true,
            signup: true,
            link: true,
            scopes: ["repo"],
          },
        ],
      },
    ]) {
      expect(() => strictDecode(ExternalIdentityConfigResponse, invalid)).toThrow();
    }
  });

  it("strictly bounds browser authorization and pending signup presentation", () => {
    const start = {
      provider: "github",
      intent: "authenticate",
      returnTo: "/account?source=github",
    } as const;
    expect(strictDecode(ExternalIdentityAuthorizationStartRequest, start)).toEqual(start);
    expect(
      strictDecode(ExternalIdentityAuthorizationStartResponse, {
        authorizationUrl:
          "https://github.com/login/oauth/authorize?client_id=client&state=state&code_challenge=challenge&code_challenge_method=S256&prompt=select_account",
        expiresAt,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(ExternalIdentityPendingResponse, {
        status: "signup",
        provider: "github",
        suggestedUsername: "octocat",
        displayName: "The Octocat",
        expiresAt,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(ExternalIdentityPendingResponse, {
        status: "error",
        provider: "github",
        code: "external_identity_email_conflict",
      }),
    ).toBeTruthy();
    expect(
      strictDecode(ExternalIdentitySignupFinishRequest, {
        provider: "github",
        username: "octocat",
        antiBotAssertion: "turnstile-assertion",
        idempotencyKey: opaque,
      }),
    ).toBeTruthy();

    for (const invalid of [
      { ...start, provider: "gitlab" },
      { ...start, returnTo: "https://evil.test/account" },
      { ...start, returnTo: "//evil.test/account" },
      { ...start, returnTo: "/account#secret" },
      { ...start, clientSecret: "must-not-survive" },
    ]) {
      expect(() => strictDecode(ExternalIdentityAuthorizationStartRequest, invalid)).toThrow();
    }

    for (const invalidPending of [
      { status: "error", provider: "github", code: "provider_body_said_no" },
      {
        status: "error",
        provider: "github",
        code: "external_authorization_rejected",
        description: "provider-sensitive-canary",
      },
    ]) {
      expect(() => strictDecode(ExternalIdentityPendingResponse, invalidPending)).toThrow();
    }

    for (const authorizationUrl of [
      "http://github.com/login/oauth/authorize?state=x",
      "https://evil.test/login/oauth/authorize?state=x",
      "https://user:pass@github.com/login/oauth/authorize?state=x",
      "https://github.com/login/oauth/authorize#token",
      "https://github.com/settings/apps",
    ]) {
      expect(() =>
        strictDecode(ExternalIdentityAuthorizationStartResponse, {
          authorizationUrl,
          expiresAt,
        }),
      ).toThrow();
    }
  });

  it("decodes the account-email read and keeps the pending pair consistent", () => {
    const decode = Schema.decodeUnknownSync(HostedAccountEmailResponse);
    const pending = {
      email: { address: "ada@example.test", verified: true },
      pendingAddress: "lovelace@example.test",
      pendingExpiresAt: 1_800_000_000_000,
    };
    expect(decode(pending)).toEqual(pending);
    expect(decode({ email: null, pendingAddress: null, pendingExpiresAt: null })).toBeTruthy();
    // The Hub may extend this read; an unknown member is dropped, not refused.
    expect(decode({ ...pending, futureMember: 1 })).toEqual(pending);
    for (const invalid of [
      { ...pending, pendingExpiresAt: null },
      { ...pending, pendingAddress: null },
      { ...pending, pendingAddress: "Lovelace@example.test" },
      { ...pending, pendingExpiresAt: -1 },
      { ...pending, email: { address: "ada@example.test", verified: true, extra: 1 } },
    ]) {
      expect(() => decode(invalid)).toThrow();
    }
  });

  it("exposes only bounded external identity presentation metadata", () => {
    expect(
      strictDecode(HostedAccountSecurityResponse, {
        passwordConfigured: true,
        totpEnrolled: false,
        emailDeliveryConfigured: true,
        email: { address: "ada@example.test", verified: true },
        externalIdentities: [summary],
      }),
    ).toBeTruthy();
    expect(
      strictDecode(HostedAccountSecurityResponse, {
        passwordConfigured: false,
        totpEnrolled: false,
        emailDeliveryConfigured: false,
        email: null,
        externalIdentities: [],
      }),
    ).toBeTruthy();

    for (const extra of [
      { subject: "12345" },
      { accessToken: "github-sensitive-canary" },
      { email: "octocat@example.test" },
      { scopes: ["repo"] },
      { internalLinkId: "link-sensitive-canary" },
    ]) {
      expect(() =>
        strictDecode(HostedAccountSecurityResponse, {
          passwordConfigured: true,
          totpEnrolled: false,
          emailDeliveryConfigured: true,
          email: null,
          externalIdentities: [{ ...summary, ...extra }],
        }),
      ).toThrow();
    }

    for (const invalidSummary of [
      { ...summary, provider: "gitlab" },
      { ...summary, login: "" },
      { ...summary, login: "x".repeat(101) },
      { ...summary, displayName: "x".repeat(201) },
      { ...summary, connectedAt: -1 },
      { ...summary, lastUsedAt: summary.connectedAt - 1 },
    ]) {
      expect(() =>
        strictDecode(HostedAccountSecurityResponse, {
          passwordConfigured: true,
          totpEnrolled: false,
          emailDeliveryConfigured: true,
          email: null,
          externalIdentities: [invalidSummary],
        }),
      ).toThrow();
    }
  });

  it("keeps connect and disconnect outcomes token-free and typed", () => {
    expect(strictDecode(BrowserExternalIdentityConnectRequest, {})).toEqual({});
    expect(strictDecode(BrowserExternalIdentityConnectRequest, { totpCode: "123456" })).toEqual({
      totpCode: "123456",
    });
    expect(
      strictDecode(BrowserExternalIdentityConnectResponse, {
        status: "connected",
        externalIdentity: summary,
      }),
    ).toBeTruthy();
    expect(strictDecode(ExternalIdentityDisconnectRequest, {})).toEqual({});
    expect(
      strictDecode(ExternalIdentityDisconnectResponse, {
        status: "disconnected",
        signedOut: true,
      }),
    ).toBeTruthy();

    expect(() =>
      strictDecode(BrowserExternalIdentityConnectResponse, {
        status: "connected",
        externalIdentity: { ...summary, token: "must-not-survive" },
      }),
    ).toThrow();
    expect(() =>
      strictDecode(ExternalIdentityDisconnectResponse, {
        status: "connected",
        signedOut: false,
      }),
    ).toThrow();
  });
});

describe("native identity v2 contracts", () => {
  const attemptId = "nident_aaaaaaaaaaaaaaaaaaaaaa";
  const loginAttemptId = "nlogin_aaaaaaaaaaaaaaaaaaaaaa";
  const resetAttemptId = "nreset_aaaaaaaaaaaaaaaaaaaaaa";
  const activation = { attemptId, activationSecret: opaqueB } as const;
  const nativeIdentity = {
    account: browserIdentity.account,
    session: browserIdentity.session,
    activeSpace,
    spaces: [activeSpace],
  } as const;
  const nativeSession = {
    status: "complete",
    identity: nativeIdentity,
    token: opaqueC,
  } as const;

  it("starts with email only and reveals the account branch only after mailbox proof", () => {
    const start = {
      email: "ada@example.test",
      antiBotAssertion: "anti-bot-sensitive-canary",
    } as const;
    const started = {
      status: "accepted",
      attemptId,
      attemptSecret: opaque,
      resendAfterMs: 30_000,
      issuedAt,
      expiresAt,
    } as const;
    expect(strictDecode(NativeIdentityEmailStartRequest, start)).toEqual(start);
    expect(strictDecode(NativeIdentityEmailStartResponse, started)).toEqual(started);
    expect(() =>
      strictDecode(NativeIdentityEmailStartRequest, { ...start, username: "too_early" }),
    ).toThrow();

    const verify = {
      attemptId,
      attemptSecret: opaque,
      proof: { kind: "email_code", code: "123456" },
    } as const;
    expect(strictDecode(NativeIdentityEmailVerifyRequest, verify)).toEqual(verify);
    for (const status of ["existing_account", "new_account"] as const) {
      const response = {
        status,
        attemptId,
        activationSecret: opaqueB,
        issuedAt,
        expiresAt,
      } as const;
      expect(strictDecode(NativeIdentityEmailVerifyResponse, response)).toEqual(response);
    }
    expect(() =>
      strictDecode(NativeIdentityEmailVerifyResponse, {
        status: "new_account",
        attemptId,
        activationSecret: opaqueB,
        accountId,
        issuedAt,
        expiresAt,
      }),
    ).toThrow();
  });

  it("claims username only after proof and completes signup with one primary credential", () => {
    expect(
      strictDecode(NativeIdentitySignupUsernameRequest, { ...activation, username: "ada_dev" }),
    ).toBeTruthy();
    expect(strictDecode(NativeIdentitySignupUsernameResponse, { status: "claimed" })).toBeTruthy();
    expect(strictDecode(NativeIdentitySignupPasskeyOptionsRequest, activation)).toEqual(activation);
    expect(
      strictDecode(NativeIdentitySignupPasskeyOptionsResponse, {
        options: { challenge: opaque, rp: { name: "Ryco Hub" } },
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeIdentitySignupPasskeyFinishRequest, {
        ...activation,
        response: { id: "credential" },
        idempotencyKey: opaqueC,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeIdentitySignupPasswordFinishRequest, {
        ...activation,
        password: "password-sensitive-canary",
        idempotencyKey: opaqueC,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeIdentitySignupFinishResponse, {
        ...nativeSession,
        recoveryCodes: ["recovery-sensitive-canary"],
      }),
    ).toBeTruthy();
  });

  it("separates username and mailbox-proven password starts and mints no browser state", () => {
    const usernameStart = {
      kind: "username",
      username: "ada_dev",
      password: "password-sensitive-canary",
    } as const;
    const mailboxStart = {
      kind: "verified_email",
      attemptId,
      activationSecret: opaqueB,
      password: "password-sensitive-canary",
    } as const;
    expect(strictDecode(NativeIdentityPasswordStartRequest, usernameStart)).toEqual(usernameStart);
    expect(strictDecode(NativeIdentityPasswordStartRequest, mailboxStart)).toEqual(mailboxStart);

    const started = {
      status: "factor_required",
      attemptId: loginAttemptId,
      attemptSecret: opaque,
      factor: "totp",
      issuedAt,
      expiresAt,
    } as const;
    expect(strictDecode(NativeIdentityPasswordStartResponse, started)).toEqual(started);
    expect(
      strictDecode(NativeIdentityPasswordFinishRequest, {
        attemptId: loginAttemptId,
        attemptSecret: opaque,
        factor: "totp",
        code: "123456",
      }),
    ).toBeTruthy();
    expect(strictDecode(NativeIdentitySessionResponse, nativeSession)).toEqual(nativeSession);
    expect(() =>
      strictDecode(NativeIdentitySessionResponse, {
        ...nativeSession,
        identity: { ...nativeIdentity, csrfToken: "csrf-must-not-survive" },
      }),
    ).toThrow();
    expect(() =>
      strictDecode(HubBrowserSessionResponse, { ...browserIdentity, token: opaqueC }),
    ).toThrow();
  });

  it("rotates recovery codes and keeps password reset explicitly sessionless", () => {
    expect(
      strictDecode(NativeIdentityRecoveryCodeRequest, {
        code: "recovery-sensitive-canary",
        idempotencyKey: opaque,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeIdentityRecoveryResponse, {
        ...nativeSession,
        recoveryCodes: ["rotated-recovery-sensitive-canary"],
      }),
    ).toBeTruthy();

    const reset = { identifier: "ada_dev" } as const;
    expect(strictDecode(NativeIdentityPasswordResetRequest, reset)).toEqual(reset);
    const resetStarted = {
      status: "accepted",
      attemptId: resetAttemptId,
      attemptSecret: opaque,
      resendAfterMs: 30_000,
      issuedAt,
      expiresAt,
    } as const;
    expect(strictDecode(NativeIdentityPasswordResetResponse, resetStarted)).toEqual(resetStarted);
    expect(
      strictDecode(NativeIdentityPasswordResetVerifyRequest, {
        attemptId: resetAttemptId,
        attemptSecret: opaque,
        proof: { kind: "link_token", token: opaqueB },
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeIdentityPasswordResetVerifyResponse, {
        status: "verified",
        attemptId: resetAttemptId,
        resetSecret: opaqueC,
        requiresTotp: true,
        issuedAt,
        expiresAt,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeIdentityPasswordResetFinishRequest, {
        attemptId: resetAttemptId,
        resetSecret: opaqueC,
        password: "new-password-sensitive-canary",
        factor: { kind: "totp", code: "123456" },
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeIdentityPasswordResetFinishResponse, { status: "complete" }),
    ).toBeTruthy();
    expect(() =>
      strictDecode(NativeIdentityPasswordResetFinishResponse, {
        status: "complete",
        token: opaqueC,
      }),
    ).toThrow();
  });

  it("cancels only an exact bound attempt envelope", () => {
    expect(
      strictDecode(NativeIdentityAttemptCancelRequest, {
        attemptId,
        attemptSecret: opaque,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeIdentityAttemptCancelRequest, {
        attemptId,
        attemptSecret: opaqueB,
      }),
    ).toBeTruthy();
    expect(strictDecode(NativeIdentityAttemptCancelResponse, { status: "cancelled" })).toBeTruthy();
    expect(() =>
      strictDecode(NativeIdentityAttemptCancelRequest, {
        attemptId,
        attemptSecret: opaque,
        origin: "https://hub.example.test",
      }),
    ).toThrow();
  });
});

describe("hosted username, email, and space authority", () => {
  it("accepts only canonical lowercase usernames and emails", () => {
    expect(strictDecode(HubUsername, "ada_2026")).toBe("ada_2026");
    expect(strictDecode(HubNormalizedEmail, "ada@example.test")).toBe("ada@example.test");

    for (const username of ["ab", "Ada", "ada-dev", " ada", "a".repeat(33)]) {
      expect(() => strictDecode(HubUsername, username)).toThrow();
    }
    for (const email of [
      "Ada@example.test",
      " ada@example.test",
      "ada@example.test ",
      "missing-at.test",
      `${"a".repeat(250)}@x.test`,
    ]) {
      expect(() => strictDecode(HubNormalizedEmail, email)).toThrow();
    }
  });

  it("exports the bounded account id used by native E2EE contracts", () => {
    expect(strictDecode(HubAccountId, accountId)).toBe(accountId);
    expect(() => strictDecode(HubAccountId, `acct_${"a".repeat(21)}`)).toThrow();
    expect(() => strictDecode(HubAccountId, "acct_not+base64url")).toThrow();
  });

  it("brands bounded space ids and rejects malformed ids", () => {
    expect(strictDecode(HubSpaceId, spaceId)).toBe(spaceId);
    for (const value of ["space_short", "org_aaaaaaaaaaaaaaaaaaaaaa", `${spaceId}/other`]) {
      expect(() => strictDecode(HubSpaceId, value)).toThrow();
    }
  });

  it("requires one matching active-space membership in browser session responses", () => {
    expect(strictDecode(HubBrowserSessionResponse, browserIdentity)).toEqual(browserIdentity);

    for (const invalid of [
      {
        ...browserIdentity,
        session: { ...browserIdentity.session, accountId: "acct_bbbbbbbbbbbbbbbbbbbbbb" },
      },
      {
        ...browserIdentity,
        session: { ...browserIdentity.session, activeSpaceId: otherSpaceId },
      },
      { ...browserIdentity, spaces: [] },
      {
        ...browserIdentity,
        spaces: [
          activeSpace,
          { ...activeSpace, id: otherSpaceId },
          { ...activeSpace, id: otherSpaceId },
        ],
      },
      {
        ...browserIdentity,
        spaces: [activeSpace, { ...activeSpace, id: otherSpaceId }],
        activeSpace: { ...activeSpace, role: "operator" },
      },
      { ...browserIdentity, internalRole: "platform_admin" },
    ]) {
      expect(() => strictDecode(HubBrowserSessionResponse, invalid)).toThrow();
    }
  });
});

describe("public signup configuration", () => {
  it("accepts only disabled, development bypass, or bounded Turnstile configuration", () => {
    expect(strictDecode(PublicSignupConfigResponse, { status: "disabled" })).toEqual({
      status: "disabled",
    });
    expect(
      strictDecode(PublicSignupConfigResponse, {
        status: "enabled",
        antiBot: { provider: "bypass" },
      }),
    ).toEqual({ status: "enabled", antiBot: { provider: "bypass" } });
    expect(
      strictDecode(PublicSignupConfigResponse, {
        status: "enabled",
        antiBot: { provider: "turnstile", siteKey: "0x4AAAAAAAAAAABBBBBBBBBB" },
      }),
    ).toEqual({
      status: "enabled",
      antiBot: { provider: "turnstile", siteKey: "0x4AAAAAAAAAAABBBBBBBBBB" },
    });
    expect(() =>
      strictDecode(PublicSignupConfigResponse, {
        status: "enabled",
        antiBot: { provider: "turnstile", siteKey: "short" },
      }),
    ).toThrow();
  });
});

describe("public signup contracts", () => {
  const start = {
    username: "ada_dev",
    email: "ada@example.test",
    antiBotAssertion: "anti-bot-sensitive-canary",
  } as const;
  const startResponse = {
    status: "accepted",
    attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
    attemptSecret: opaque,
    resendAfterMs: 30_000,
    issuedAt,
    expiresAt,
  } as const;

  it("accepts a strict, uniformly accepted signup start", () => {
    expect(strictDecode(PublicSignupStartRequest, start)).toEqual(start);
    expect(strictDecode(PublicSignupStartResponse, startResponse)).toEqual(startResponse);

    for (const invalid of [
      { ...start, username: "Ada" },
      { ...start, email: "ADA@example.test" },
      { ...start, antiBotAssertion: "" },
      { ...start, provider: "resend" },
    ]) {
      expect(() => strictDecode(PublicSignupStartRequest, invalid)).toThrow();
    }
    expect(() =>
      strictDecode(PublicSignupStartResponse, { ...startResponse, expiresAt: issuedAt }),
    ).toThrow();
    expect(() =>
      strictDecode(PublicSignupStartResponse, {
        ...startResponse,
        available: true,
      }),
    ).toThrow();
  });

  it("keeps mailbox proof and activation secrets in exact discriminated envelopes", () => {
    const linkRequest = {
      attemptId: startResponse.attemptId,
      attemptSecret: opaque,
      proof: { kind: "link_token", token: opaqueB },
    } as const;
    const codeRequest = {
      ...linkRequest,
      proof: { kind: "email_code", code: "123456" },
    } as const;
    expect(strictDecode(PublicSignupVerifyRequest, linkRequest)).toEqual(linkRequest);
    expect(strictDecode(PublicSignupVerifyRequest, codeRequest)).toEqual(codeRequest);
    expect(
      strictDecode(PublicSignupVerifyResponse, {
        status: "verified",
        attemptId: startResponse.attemptId,
        activationSecret: opaqueC,
        issuedAt,
        expiresAt,
      }),
    ).toBeTruthy();

    for (const proof of [
      { kind: "link_token", code: "123456" },
      { kind: "email_code", token: opaqueB },
      { kind: "email_code", code: "12ab56" },
      { kind: "email_code", code: "1234567" },
      { kind: "provider", token: opaqueB },
    ]) {
      expect(() => strictDecode(PublicSignupVerifyRequest, { ...linkRequest, proof })).toThrow();
    }
  });

  it("supports passkey and password completion without provider or persistence fields", () => {
    const activation = {
      attemptId: startResponse.attemptId,
      activationSecret: opaqueC,
    } as const;
    expect(strictDecode(PublicSignupPasskeyOptionsRequest, activation)).toEqual(activation);
    expect(
      strictDecode(PublicSignupPasskeyOptionsResponse, {
        options: { challenge: opaque, rp: { name: "Ryco Hub" } },
      }),
    ).toBeTruthy();
    expect(() => strictDecode(PublicSignupPasskeyOptionsResponse, {})).toThrow();
    expect(() =>
      strictDecode(PublicSignupPasskeyOptionsResponse, { options: "not-an-object" }),
    ).toThrow();
    expect(
      strictDecode(PublicSignupPasskeyFinishRequest, {
        ...activation,
        response: { id: "credential" },
        idempotencyKey: opaqueB,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(PublicSignupPasswordFinishRequest, {
        ...activation,
        password: "password-sensitive-canary",
        idempotencyKey: opaqueB,
      }),
    ).toBeTruthy();
    expect(() =>
      strictDecode(PublicSignupPasswordFinishRequest, {
        ...activation,
        password: "a".repeat(11),
        idempotencyKey: opaqueB,
      }),
    ).toThrow();

    const completed = {
      status: "complete",
      identity: browserIdentity,
      recoveryCodes: ["recovery-sensitive-canary"],
    } as const;
    expect(strictDecode(PublicSignupFinishResponse, completed)).toEqual(completed);
    expect(() =>
      strictDecode(PublicSignupFinishResponse, {
        ...completed,
        resendMessageId: "provider-internal",
      }),
    ).toThrow();
  });
});

describe("password login and reset contracts", () => {
  it("reveals exactly one second-factor kind only after password start", () => {
    const start = {
      identifier: "ada_dev",
      password: "password-sensitive-canary",
    } as const;
    expect(strictDecode(PasswordLoginStartRequest, start)).toEqual(start);

    for (const factor of ["totp", "email_code"] as const) {
      const response = {
        status: "factor_required",
        attemptId: "login_aaaaaaaaaaaaaaaaaaaaaa",
        attemptSecret: opaque,
        factor,
        issuedAt,
        expiresAt,
      } as const;
      expect(strictDecode(PasswordLoginStartResponse, response)).toEqual(response);
      expect(
        strictDecode(PasswordLoginFinishRequest, {
          attemptId: response.attemptId,
          attemptSecret: opaque,
          factor,
          code: "123456",
        }),
      ).toBeTruthy();
    }

    expect(() =>
      strictDecode(PasswordLoginFinishRequest, {
        attemptId: "login_aaaaaaaaaaaaaaaaaaaaaa",
        attemptSecret: opaque,
        factor: "totp",
        emailCode: "123456",
      }),
    ).toThrow();
    for (const factor of ["totp", "email_code"] as const) {
      expect(() =>
        strictDecode(PasswordLoginFinishRequest, {
          attemptId: "login_aaaaaaaaaaaaaaaaaaaaaa",
          attemptSecret: opaque,
          factor,
          code: "1234567",
        }),
      ).toThrow();
    }
  });

  it("keeps reset uniform, single-use, and explicitly sessionless", () => {
    expect(strictDecode(PasswordResetRequest, { identifier: "ada@example.test" })).toBeTruthy();
    expect(strictDecode(PasswordResetRequestResponse, { status: "accepted" })).toBeTruthy();
    expect(strictDecode(PasswordResetVerifyRequest, { token: opaque })).toBeTruthy();
    expect(
      strictDecode(PasswordResetVerifyResponse, {
        status: "verified",
        attemptId: "reset_aaaaaaaaaaaaaaaaaaaaaa",
        attemptSecret: opaqueB,
        requiresTotp: true,
        issuedAt,
        expiresAt,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(PasswordResetFinishRequest, {
        attemptId: "reset_aaaaaaaaaaaaaaaaaaaaaa",
        attemptSecret: opaqueB,
        password: "new-password-sensitive-canary",
        factor: { kind: "totp", code: "123456" },
      }),
    ).toBeTruthy();
    expect(strictDecode(PasswordResetFinishResponse, { status: "complete" })).toBeTruthy();
    expect(() =>
      strictDecode(PasswordResetFinishResponse, {
        status: "complete",
        session: browserIdentity.session,
      }),
    ).toThrow();
  });
});

describe("space switch contract", () => {
  it("requires the selected active space to be one exact current membership", () => {
    const switched = {
      activeSpace: { ...activeSpace, id: otherSpaceId, role: "operator" },
      spaces: [activeSpace, { ...activeSpace, id: otherSpaceId, role: "operator" }],
    } as const;
    expect(strictDecode(ActiveSpaceSwitchResponse, switched)).toEqual(switched);
    expect(() =>
      strictDecode(ActiveSpaceSwitchResponse, { ...switched, spaces: [activeSpace] }),
    ).toThrow();
    expect(() =>
      strictDecode(ActiveSpaceSwitchResponse, {
        ...switched,
        spaces: [...switched.spaces, switched.spaces[0]],
      }),
    ).toThrow();
  });
});

describe("native automatic-node claim contracts", () => {
  const fingerprint = `SHA256:${"A".repeat(42)}E`;
  const installationId = "install_aaaaaaaaaaaaaaaaaaaaaa";
  const environmentId = "env_aaaaaaaaaaaaaaaaaaaaaa";
  const claimId = "nclaim_aaaaaaaaaaaaaaaaaaaaaa";
  const node = {
    environmentId,
    label: "Ada's Mac",
    platformOs: "darwin",
    platformArch: "arm64",
    clientVersion: "0.1.8",
    algorithm: "ed25519",
    publicKey: opaque,
    fingerprint,
  } as const;

  it("binds a start response to account, space, session, DPoP key, install, and node", () => {
    expect(strictDecode(NativeNodeClaimStartRequest, { installationId, node })).toBeTruthy();
    const response = {
      protocolVersion: 1,
      transcriptVersion: 1,
      claimId,
      challenge: opaqueB,
      accountId,
      spaceId,
      sessionId,
      dpopKeyThumbprint: opaqueC,
      installationId,
      environmentId,
      nodeFingerprint: fingerprint,
      issuedAt,
      expiresAt,
    } as const;
    expect(strictDecode(NativeNodeClaimStartResponse, response)).toEqual(response);

    for (const invalid of [
      { ...response, protocolVersion: 2 },
      { ...response, transcriptVersion: 2 },
      { ...response, environmentId: "desktop-main" },
      { ...response, expiresAt: issuedAt },
      { ...response, rawDpopProof: "must-not-survive" },
    ]) {
      expect(() => strictDecode(NativeNodeClaimStartResponse, invalid)).toThrow();
    }
  });

  it("accepts only one bounded signature and returns no reusable claim credential", () => {
    expect(
      strictDecode(NativeNodeClaimFinishRequest, {
        claimId,
        challenge: opaqueB,
        signature: `${"A".repeat(85)}Q`,
        idempotencyKey: opaque,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeNodeClaimFinishResponse, {
        status: "claimed",
        disposition: "created",
        node: {
          id: "node_aaaaaaaaaaaaaaaaaaaaaa",
          activeKeyId: "nkey_aaaaaaaaaaaaaaaaaaaaaa",
          environmentId,
          label: node.label,
          fingerprint,
          effectiveRole: "owner",
        },
      }),
    ).toBeTruthy();
    expect(() =>
      strictDecode(NativeNodeClaimFinishRequest, {
        claimId,
        challenge: opaqueB,
        signature: `${"A".repeat(85)}B`,
        idempotencyKey: opaque,
      }),
    ).toThrow();
  });

  it("collapses claim failures into stable non-enumerating envelopes", () => {
    expect(
      strictDecode(NativeNodeClaimError, {
        error: "node_claim_rejected",
        retryable: false,
      }),
    ).toBeTruthy();
    expect(
      strictDecode(NativeNodeClaimError, {
        error: "node_claim_unavailable",
        retryable: true,
        retryAfterMs: 1_000,
      }),
    ).toBeTruthy();
    for (const invalid of [
      { error: "wrong_account", retryable: false },
      { error: "node_claim_rejected", retryable: true },
      { error: "node_claim_unavailable", retryable: true, databaseCode: "SQLITE_BUSY" },
    ]) {
      expect(() => strictDecode(NativeNodeClaimError, invalid)).toThrow();
    }
  });
});
