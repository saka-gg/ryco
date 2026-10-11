import {
  NATIVE_HANDOFF_CALLBACK_URIS,
  NATIVE_HANDOFF_TRANSACTION_LIFETIME_MS,
  NativeHandoffConnectRedeemRequest,
  NativeHandoffConnectRedeemResponse,
  type NativeHandoffRedeemResponse,
  type NativeHandoffStartRequest,
} from "@ryco/contracts/native-handoff";
import { describe, expect, it, vi } from "vitest";

import type {
  NativeAuthorizationBrowserResult,
  NativeAuthorizationService,
} from "../platform/index.ts";
import {
  NativeHandoffClientError,
  createNativeHandoffAttempt,
  runNativeHandoff,
  runTypedNativeHandoff,
} from "./nativeHandoff.ts";

const OPAQUE_A = "A".repeat(43);
const OPAQUE_B = "B".repeat(43);
const CALLBACK = NATIVE_HANDOFF_CALLBACK_URIS[0];
const ORIGIN = "https://hub.example.test";
const NOW = 1_752_710_400_000;
const CLOCK_SKEW_TOLERANCE_MS = 60_000;

function platform(
  result: Awaited<ReturnType<NativeAuthorizationService["openSystemBrowser"]>> = {
    type: "success",
    url: `${CALLBACK}?code=${OPAQUE_B}&state=${OPAQUE_A}&handoff_id=${OPAQUE_A}`,
  },
): NativeAuthorizationService {
  let randomCall = 0;
  return {
    callbackUri: () => CALLBACK,
    deviceLabel: () => "Laurin’s iPhone",
    randomBytes: vi.fn(async (length) => {
      expect(length).toBe(32);
      randomCall += 1;
      return new Uint8Array(32).fill(randomCall === 1 ? 0 : 1);
    }),
    sha256: vi.fn(async () => new Uint8Array(32).fill(2)),
    openSystemBrowser: vi.fn(async () => result),
  };
}

const redeemed: NativeHandoffRedeemResponse = {
  account: {
    id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Ada",
    role: "owner",
    createdAt: NOW,
    disabledAt: null,
  },
  session: {
    id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
    accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    familyId: "sfam_aaaaaaaaaaaaaaaaaaaaaa",
    clientLabel: "Laurin’s iPhone",
    kind: "native",
    createdAt: NOW,
    expiresAt: NOW + 60_000,
    lastSeenAt: NOW,
    replacedBySessionId: null,
    revokedAt: null,
    revocationReasonCode: null,
  },
  token: OPAQUE_B,
};

describe("native handoff attempt", () => {
  it("creates fresh PKCE S256 and state without retaining platform authority", async () => {
    const service = platform();
    const attempt = await createNativeHandoffAttempt(service);

    expect(attempt).toEqual({
      callbackUri: CALLBACK,
      codeChallenge: "AgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgI",
      codeVerifier: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      deviceLabel: "Laurin’s iPhone",
      state: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(service.sha256).toHaveBeenCalledWith(
      new TextEncoder().encode("AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE"),
    );
  });

  it("rejects invalid platform randomness, callbacks, and device labels", async () => {
    await expect(
      createNativeHandoffAttempt({ ...platform(), randomBytes: async () => new Uint8Array(31) }),
    ).rejects.toMatchObject({ code: "platform_invalid" });
    await expect(
      createNativeHandoffAttempt({ ...platform(), callbackUri: () => "ryco://other" }),
    ).rejects.toMatchObject({ code: "callback_rejected" });
    await expect(
      createNativeHandoffAttempt({ ...platform(), deviceLabel: () => "x".repeat(65) }),
    ).rejects.toMatchObject({ code: "platform_invalid" });
  });
});

describe("runNativeHandoff", () => {
  it("opens the exact authorization URL and redeems only after matching state and handoff", async () => {
    const service = platform();
    const start = vi.fn(async (request: NativeHandoffStartRequest) => {
      expect(request).toMatchObject({
        redirectUri: CALLBACK,
        codeChallengeMethod: "S256",
        state: OPAQUE_A,
      });
      return {
        handoffId: OPAQUE_A,
        authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
        expiresAt: NOW + 60_000,
      } as const;
    });
    const redeem = vi.fn(async () => redeemed);

    const result = await runNativeHandoff({
      origin: ORIGIN,
      platform: service,
      now: () => NOW,
      start,
      redeem,
    });

    expect(service.openSystemBrowser).toHaveBeenCalledWith(
      `${ORIGIN}/native/authorize/${OPAQUE_A}`,
      CALLBACK,
      expect.any(AbortSignal),
    );
    expect(redeem).toHaveBeenCalledWith(
      {
        handoffId: OPAQUE_A,
        code: OPAQUE_B,
        codeVerifier: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
      },
      expect.any(AbortSignal),
    );
    expect(result).toEqual(redeemed);
  });

  it("runs a typed GitHub connect without allowing its result to become a session", async () => {
    const service = platform();
    const connect = {
      status: "connected",
      purpose: { kind: "connect_external_identity", provider: "github" },
      externalIdentity: {
        provider: "github",
        login: "octocat",
        displayName: "The Octocat",
        connectedAt: NOW,
        lastUsedAt: null,
      },
    } as const;
    const redeem = vi.fn(async () => connect);

    await expect(
      runTypedNativeHandoff({
        origin: ORIGIN,
        platform: service,
        now: () => NOW,
        purpose: { kind: "connect_external_identity", provider: "github" },
        redeemRequestSchema: NativeHandoffConnectRedeemRequest,
        redeemResponseSchema: NativeHandoffConnectRedeemResponse,
        buildRedeemRequest: (base) => ({
          ...base,
          purpose: { kind: "connect_external_identity" as const, provider: "github" as const },
        }),
        start: async (request) => {
          expect(request.purpose).toEqual({
            kind: "connect_external_identity",
            provider: "github",
          });
          return {
            handoffId: OPAQUE_A,
            authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
            expiresAt: NOW + 60_000,
          };
        },
        redeem,
      }),
    ).resolves.toEqual(connect);
    expect(redeem).toHaveBeenCalledWith(
      {
        handoffId: OPAQUE_A,
        code: OPAQUE_B,
        codeVerifier: "AQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQEBAQE",
        purpose: { kind: "connect_external_identity", provider: "github" },
      },
      expect.any(AbortSignal),
    );
    expect(JSON.stringify(redeem.mock.calls)).not.toContain("token");
  });

  it("fails closed on cross-origin authorization, callback mismatch, expiry, and cancellation", async () => {
    const cases = [
      {
        start: {
          handoffId: OPAQUE_A,
          authorizationUrl: `https://other.example.test/native/authorize/${OPAQUE_A}`,
          expiresAt: NOW + 60_000,
        },
        service: platform(),
        code: "authorization_rejected",
      },
      {
        start: {
          handoffId: OPAQUE_A,
          authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
          expiresAt: NOW + 60_000,
        },
        service: platform({
          type: "success",
          url: `${CALLBACK}?code=${OPAQUE_B}&state=${OPAQUE_B}&handoff_id=${OPAQUE_A}`,
        }),
        code: "callback_rejected",
      },
      {
        start: {
          handoffId: OPAQUE_A,
          authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
          expiresAt: NOW - CLOCK_SKEW_TOLERANCE_MS - 1,
        },
        service: platform(),
        code: "expired",
      },
      {
        start: {
          handoffId: OPAQUE_A,
          authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
          expiresAt: NOW + 60_000,
        },
        service: platform({ type: "cancel" }),
        code: "cancelled",
      },
    ] as const;

    for (const testCase of cases) {
      const redeem = vi.fn(async () => redeemed);
      await expect(
        runNativeHandoff({
          origin: ORIGIN,
          platform: testCase.service,
          now: () => NOW,
          start: async () => testCase.start,
          redeem,
        }),
      ).rejects.toMatchObject({ code: testCase.code });
      expect(redeem).not.toHaveBeenCalled();
    }
  });

  it("accepts start expiries at the bounded clock-skew limits", async () => {
    const expiries = [
      NOW - CLOCK_SKEW_TOLERANCE_MS,
      NOW + NATIVE_HANDOFF_TRANSACTION_LIFETIME_MS + CLOCK_SKEW_TOLERANCE_MS,
    ];

    for (const expiresAt of expiries) {
      const service = platform();
      const redeem = vi.fn(async () => redeemed);

      await expect(
        runNativeHandoff({
          origin: ORIGIN,
          platform: service,
          now: () => NOW,
          start: async () => ({
            handoffId: OPAQUE_A,
            authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
            expiresAt,
          }),
          redeem,
        }),
      ).resolves.toEqual(redeemed);
      expect(service.openSystemBrowser).toHaveBeenCalledOnce();
      expect(redeem).toHaveBeenCalledOnce();
    }
  });

  it("rejects start expiries beyond the bounded clock-skew limits", async () => {
    const cases = [
      {
        expiresAt: NOW - CLOCK_SKEW_TOLERANCE_MS - 1,
        code: "expired",
      },
      {
        expiresAt: NOW + NATIVE_HANDOFF_TRANSACTION_LIFETIME_MS + CLOCK_SKEW_TOLERANCE_MS + 1,
        code: "authorization_rejected",
      },
    ] as const;

    for (const testCase of cases) {
      const service = platform();
      const redeem = vi.fn(async () => redeemed);

      await expect(
        runNativeHandoff({
          origin: ORIGIN,
          platform: service,
          now: () => NOW,
          start: async () => ({
            handoffId: OPAQUE_A,
            authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
            expiresAt: testCase.expiresAt,
          }),
          redeem,
        }),
      ).rejects.toMatchObject({ code: testCase.code });
      expect(service.openSystemBrowser).not.toHaveBeenCalled();
      expect(redeem).not.toHaveBeenCalled();
    }
  });

  it("applies the bounded clock-skew tolerance when the browser returns", async () => {
    const expiresAt = NOW + 60_000;
    const cases = [
      {
        callbackNow: expiresAt + CLOCK_SKEW_TOLERANCE_MS,
        code: null,
      },
      {
        callbackNow: expiresAt + CLOCK_SKEW_TOLERANCE_MS + 1,
        code: "expired",
      },
    ] as const;

    for (const testCase of cases) {
      let currentTime = NOW;
      const service: NativeAuthorizationService = {
        ...platform(),
        openSystemBrowser: vi.fn(async () => {
          currentTime = testCase.callbackNow;
          return {
            type: "success" as const,
            url: `${CALLBACK}?code=${OPAQUE_B}&state=${OPAQUE_A}&handoff_id=${OPAQUE_A}`,
          };
        }),
      };
      const redeem = vi.fn(async () => redeemed);
      const result = runNativeHandoff({
        origin: ORIGIN,
        platform: service,
        now: () => currentTime,
        start: async () => ({
          handoffId: OPAQUE_A,
          authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
          expiresAt,
        }),
        redeem,
      });

      if (testCase.code === null) {
        await expect(result).resolves.toEqual(redeemed);
        expect(redeem).toHaveBeenCalledOnce();
      } else {
        await expect(result).rejects.toMatchObject({ code: testCase.code });
        expect(redeem).not.toHaveBeenCalled();
      }
    }
  });

  it("cancels a prior overlapping attempt and fences its late browser result", async () => {
    let releaseFirst = null as
      | ((value: { readonly type: "success"; readonly url: string }) => void)
      | null;
    const firstPlatform: NativeAuthorizationService = {
      ...platform(),
      openSystemBrowser: vi.fn(
        () =>
          new Promise<NativeAuthorizationBrowserResult>((resolve) => {
            releaseFirst = resolve;
          }),
      ),
    };
    const redeem = vi.fn(async () => redeemed);
    const client = {
      run: (service: NativeAuthorizationService) =>
        runNativeHandoff({
          origin: ORIGIN,
          platform: service,
          now: () => NOW,
          start: async () => ({
            handoffId: OPAQUE_A,
            authorizationUrl: `${ORIGIN}/native/authorize/${OPAQUE_A}`,
            expiresAt: NOW + 60_000,
          }),
          redeem,
          coordinatorKey: "test-overlap",
        }),
    };

    const first = client.run(firstPlatform);
    const firstResult = first.catch((error: unknown) => error);
    await vi.waitFor(() => expect(firstPlatform.openSystemBrowser).toHaveBeenCalledOnce());
    const second = client.run(platform());
    await expect(second).resolves.toEqual(redeemed);
    releaseFirst?.({
      type: "success",
      url: `${CALLBACK}?code=${OPAQUE_B}&state=${OPAQUE_A}&handoff_id=${OPAQUE_A}`,
    });
    await expect(firstResult).resolves.toMatchObject({ code: "superseded" });
    expect(redeem).toHaveBeenCalledTimes(1);
  });

  it("uses bounded client errors without reflecting callback data", () => {
    const error = new NativeHandoffClientError("callback_rejected");
    expect(error.message).toBe("The browser response could not be verified.");
    expect(JSON.stringify(error)).not.toContain("code=");
  });
});
