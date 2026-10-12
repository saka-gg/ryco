import {
  NATIVE_HANDOFF_TRANSACTION_LIFETIME_MS,
  NativeHandoffApproveResponse,
  NativeHandoffCallbackUri,
  NativeHandoffCancelResponse,
  NativeHandoffRedeemRequest,
  NativeHandoffRedeemResponse,
  NativeHandoffStartRequest,
  NativeHandoffStartResponse,
  type NativeHandoffCallbackUri as NativeHandoffCallbackUriType,
  type NativeHandoffPurpose as NativeHandoffPurposeType,
  type NativeHandoffRedeemRequest as NativeHandoffRedeemRequestType,
  type NativeHandoffRedeemResponse as NativeHandoffRedeemResponseType,
  type NativeHandoffStartRequest as NativeHandoffStartRequestType,
} from "@ryco/contracts/native-handoff";
import * as Schema from "effect/Schema";

import type { NativeAuthorizationService } from "../platform/index.ts";
import { encodeBase64Url } from "../relay/base64url.ts";

export type NativeHandoffClientErrorCode =
  | "authorization_rejected"
  | "callback_rejected"
  | "cancelled"
  | "expired"
  | "platform_invalid"
  | "superseded";

const ERROR_MESSAGES: Readonly<Record<NativeHandoffClientErrorCode, string>> = {
  authorization_rejected: "The Hub authorization request could not be verified.",
  callback_rejected: "The browser response could not be verified.",
  cancelled: "Authorization was cancelled.",
  expired: "The authorization request expired. Try again.",
  platform_invalid: "Secure browser authorization is unavailable on this device.",
  superseded: "A newer authorization request replaced this one.",
};

const NATIVE_HANDOFF_CLOCK_SKEW_TOLERANCE_MS = 60_000;

/** Bounded, secret-free errors safe for the shared controller to present. */
export class NativeHandoffClientError extends Error {
  readonly code: NativeHandoffClientErrorCode;

  constructor(code: NativeHandoffClientErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = code === "cancelled" || code === "superseded" ? "AbortError" : "NativeHandoffError";
    this.code = code;
  }
}

export interface NativeHandoffAttempt {
  readonly callbackUri: NativeHandoffCallbackUriType;
  readonly codeChallenge: string;
  readonly codeVerifier: string;
  readonly deviceLabel: string;
  readonly state: string;
}

export interface NativeHandoffTransport {
  readonly start: (request: NativeHandoffStartRequestType, signal: AbortSignal) => Promise<unknown>;
  readonly redeem: (
    request: NativeHandoffRedeemRequestType,
    signal: AbortSignal,
  ) => Promise<unknown>;
}

export interface RunNativeHandoffInput extends NativeHandoffTransport {
  readonly origin: string;
  readonly platform: NativeAuthorizationService;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  /**
   * Attempts with the same key supersede one another. HostedHubApi passes its
   * Hub origin; tests may provide an isolated key.
   */
  readonly coordinatorKey?: string;
}

export interface RunTypedNativeHandoffInput<
  RedeemRequestSchema extends Schema.Top,
  RedeemResponseSchema extends Schema.Top,
> {
  readonly origin: string;
  readonly platform: NativeAuthorizationService;
  readonly purpose?: NativeHandoffPurposeType;
  readonly redeemRequestSchema: RedeemRequestSchema;
  readonly redeemResponseSchema: RedeemResponseSchema;
  readonly buildRedeemRequest: (
    base: NativeHandoffRedeemRequestType,
  ) => RedeemRequestSchema["Type"];
  readonly start: (request: NativeHandoffStartRequestType, signal: AbortSignal) => Promise<unknown>;
  readonly redeem: (request: RedeemRequestSchema["Type"], signal: AbortSignal) => Promise<unknown>;
  readonly now?: () => number;
  readonly signal?: AbortSignal;
  readonly coordinatorKey?: string;
}

interface ActiveAttempt {
  readonly generation: number;
  readonly controller: AbortController;
  superseded: boolean;
}

const activeAttempts = new Map<string, ActiveAttempt>();

function decodeStrict<S extends Schema.Top>(schema: S, value: unknown): S["Type"] {
  return Schema.decodeUnknownSync(schema as unknown as Schema.Decoder<unknown>)(value, {
    onExcessProperty: "error",
  }) as S["Type"];
}

function asciiBytes(value: string): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) bytes[index] = value.charCodeAt(index);
  return bytes;
}

async function exactRandom256(
  platform: NativeAuthorizationService,
): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = await platform.randomBytes(32);
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== 32) {
    throw new NativeHandoffClientError("platform_invalid");
  }
  return Uint8Array.from(bytes);
}

function constantTimeEqual(left: string, right: string): boolean {
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) {
    difference |= (left.charCodeAt(index) || 0) ^ (right.charCodeAt(index) || 0);
  }
  return difference === 0;
}

function beginAttempt(
  key: string,
  outerSignal?: AbortSignal,
): {
  readonly active: ActiveAttempt;
  readonly isCurrent: () => boolean;
  readonly cleanup: () => void;
} {
  const previous = activeAttempts.get(key);
  if (previous) previous.superseded = true;
  previous?.controller.abort();
  const active = {
    generation: (previous?.generation ?? 0) + 1,
    controller: new AbortController(),
    superseded: false,
  };
  activeAttempts.set(key, active);
  const abort = () => active.controller.abort();
  if (outerSignal?.aborted) abort();
  else outerSignal?.addEventListener("abort", abort, { once: true });
  const isCurrent = () => activeAttempts.get(key) === active && !active.controller.signal.aborted;
  return {
    active,
    isCurrent,
    cleanup: () => {
      outerSignal?.removeEventListener("abort", abort);
      if (activeAttempts.get(key) === active) activeAttempts.delete(key);
    },
  };
}

function assertCurrent(active: ActiveAttempt, isCurrent: () => boolean): void {
  if (isCurrent()) return;
  throw new NativeHandoffClientError(active.superseded ? "superseded" : "cancelled");
}

function assertStartExpiry(expiresAt: number, clientNow: number): void {
  const remainingMs = expiresAt - clientNow;
  if (remainingMs < -NATIVE_HANDOFF_CLOCK_SKEW_TOLERANCE_MS) {
    throw new NativeHandoffClientError("expired");
  }
  if (
    remainingMs >
    NATIVE_HANDOFF_TRANSACTION_LIFETIME_MS + NATIVE_HANDOFF_CLOCK_SKEW_TOLERANCE_MS
  ) {
    throw new NativeHandoffClientError("authorization_rejected");
  }
}

function assertBrowserResultNotExpired(expiresAt: number, clientNow: number): void {
  if (clientNow - expiresAt > NATIVE_HANDOFF_CLOCK_SKEW_TOLERANCE_MS) {
    throw new NativeHandoffClientError("expired");
  }
}

function callbackValues(
  callbackUrl: string,
  expected: Pick<NativeHandoffAttempt, "callbackUri" | "state"> & { readonly handoffId: string },
): { readonly code: string } {
  let url: URL;
  try {
    url = new URL(callbackUrl);
  } catch {
    throw new NativeHandoffClientError("callback_rejected");
  }
  if (url.searchParams.has("error")) {
    try {
      decodeStrict(NativeHandoffCancelResponse, { redirectUri: callbackUrl });
    } catch {
      throw new NativeHandoffClientError("callback_rejected");
    }
    const state = url.searchParams.get("state") ?? "";
    const handoffId = url.searchParams.get("handoff_id") ?? "";
    if (
      !constantTimeEqual(state, expected.state) ||
      !constantTimeEqual(handoffId, expected.handoffId)
    ) {
      throw new NativeHandoffClientError("callback_rejected");
    }
    throw new NativeHandoffClientError("cancelled");
  }
  try {
    decodeStrict(NativeHandoffApproveResponse, { redirectUri: callbackUrl });
  } catch {
    throw new NativeHandoffClientError("callback_rejected");
  }
  const callbackBase = `${url.protocol}//${url.host}${url.pathname}`;
  const state = url.searchParams.get("state") ?? "";
  const handoffId = url.searchParams.get("handoff_id") ?? "";
  if (
    callbackBase !== expected.callbackUri ||
    !constantTimeEqual(state, expected.state) ||
    !constantTimeEqual(handoffId, expected.handoffId)
  ) {
    throw new NativeHandoffClientError("callback_rejected");
  }
  return { code: url.searchParams.get("code")! };
}

/** Create one in-memory PKCE/state attempt from platform-owned primitives. */
export async function createNativeHandoffAttempt(
  platform: NativeAuthorizationService,
): Promise<NativeHandoffAttempt> {
  let callbackUri: NativeHandoffCallbackUriType;
  try {
    callbackUri = decodeStrict(NativeHandoffCallbackUri, platform.callbackUri());
  } catch {
    throw new NativeHandoffClientError("callback_rejected");
  }
  const deviceLabel = platform.deviceLabel().trim();
  if (deviceLabel.length === 0 || Array.from(deviceLabel).length > 64) {
    throw new NativeHandoffClientError("platform_invalid");
  }
  const state = encodeBase64Url(await exactRandom256(platform));
  const codeVerifier = encodeBase64Url(await exactRandom256(platform));
  const digest = await platform.sha256(asciiBytes(codeVerifier));
  if (!(digest instanceof Uint8Array) || digest.byteLength !== 32) {
    throw new NativeHandoffClientError("platform_invalid");
  }
  const attempt = {
    callbackUri,
    codeChallenge: encodeBase64Url(digest),
    codeVerifier,
    deviceLabel,
    state,
  };
  try {
    decodeStrict(NativeHandoffStartRequest, {
      redirectUri: attempt.callbackUri,
      codeChallenge: attempt.codeChallenge,
      codeChallengeMethod: "S256",
      state: attempt.state,
      deviceLabel: attempt.deviceLabel,
    });
  } catch {
    throw new NativeHandoffClientError("platform_invalid");
  }
  return attempt;
}

/**
 * Run one complete native public-client authorization transaction.
 *
 * Secrets remain local to this call. A late result from a cancelled or replaced
 * browser attempt is fenced before redemption, and the full redemption payload
 * is decoded before it can reach a credential writer.
 */
export async function runTypedNativeHandoff<
  RedeemRequestSchema extends Schema.Top,
  RedeemResponseSchema extends Schema.Top,
>(
  input: RunTypedNativeHandoffInput<RedeemRequestSchema, RedeemResponseSchema>,
): Promise<RedeemResponseSchema["Type"]> {
  const key = input.coordinatorKey ?? input.origin;
  const { active, isCurrent, cleanup } = beginAttempt(key, input.signal);
  const now = input.now ?? Date.now;
  try {
    assertCurrent(active, isCurrent);
    const attempt = await createNativeHandoffAttempt(input.platform);
    assertCurrent(active, isCurrent);
    const startRequest = decodeStrict(NativeHandoffStartRequest, {
      redirectUri: attempt.callbackUri,
      codeChallenge: attempt.codeChallenge,
      codeChallengeMethod: "S256",
      state: attempt.state,
      deviceLabel: attempt.deviceLabel,
      ...(input.purpose ? { purpose: input.purpose } : {}),
    });
    let start: typeof NativeHandoffStartResponse.Type;
    try {
      start = decodeStrict(
        NativeHandoffStartResponse,
        await input.start(startRequest, active.controller.signal),
      );
    } catch (error) {
      if (!isCurrent()) assertCurrent(active, isCurrent);
      if (error instanceof NativeHandoffClientError) throw error;
      throw new NativeHandoffClientError("authorization_rejected");
    }
    const issuedAt = now();
    let authorizationUrl: URL;
    try {
      authorizationUrl = new URL(start.authorizationUrl);
    } catch {
      throw new NativeHandoffClientError("authorization_rejected");
    }
    if (authorizationUrl.origin !== new URL(input.origin).origin) {
      throw new NativeHandoffClientError("authorization_rejected");
    }
    assertStartExpiry(start.expiresAt, issuedAt);
    const browserResult = await input.platform.openSystemBrowser(
      start.authorizationUrl,
      attempt.callbackUri,
      active.controller.signal,
    );
    assertCurrent(active, isCurrent);
    if (browserResult.type !== "success") {
      throw new NativeHandoffClientError(
        browserResult.type === "locked" ? "authorization_rejected" : "cancelled",
      );
    }
    assertBrowserResultNotExpired(start.expiresAt, now());
    const { code } = callbackValues(browserResult.url, {
      callbackUri: attempt.callbackUri,
      state: attempt.state,
      handoffId: start.handoffId,
    });
    assertCurrent(active, isCurrent);
    let redeemed: RedeemResponseSchema["Type"];
    try {
      redeemed = decodeStrict(
        input.redeemResponseSchema,
        await input.redeem(
          decodeStrict(
            input.redeemRequestSchema,
            input.buildRedeemRequest(
              decodeStrict(NativeHandoffRedeemRequest, {
                handoffId: start.handoffId,
                code,
                codeVerifier: attempt.codeVerifier,
              }),
            ),
          ),
          active.controller.signal,
        ),
      );
    } catch (error) {
      if (!isCurrent()) assertCurrent(active, isCurrent);
      throw error;
    }
    assertCurrent(active, isCurrent);
    return redeemed;
  } finally {
    cleanup();
  }
}

export async function runNativeHandoff(
  input: RunNativeHandoffInput,
): Promise<NativeHandoffRedeemResponseType> {
  return runTypedNativeHandoff({
    ...input,
    redeemRequestSchema: NativeHandoffRedeemRequest,
    redeemResponseSchema: NativeHandoffRedeemResponse,
    buildRedeemRequest: (base) => base,
  });
}
