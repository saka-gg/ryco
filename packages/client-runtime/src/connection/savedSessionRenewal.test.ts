import type { AuthBearerBootstrapResult, AuthSessionState, EnvironmentId } from "@ryco/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { RemoteEnvironmentAuthHttpError } from "./remoteApi.ts";
import { SAVED_ENVIRONMENT_SESSION_CHECK_TIMEOUT_MS } from "./savedEnvironmentSession.ts";
import {
  createSavedSessionRenewal,
  SavedEnvironmentBearerUnavailableError,
  shouldRenewSavedSession,
} from "./savedSessionRenewal.ts";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = Date.parse("2026-10-04T12:00:00.000Z");
const environmentId = "env-direct" as EnvironmentId;

const bearerSession = (expiresInMs: number, overrides: Partial<Record<string, unknown>> = {}) =>
  ({
    authenticated: true,
    role: "client",
    sessionMethod: "bearer-session-token",
    expiresAt: new Date(NOW + expiresInMs).toISOString(),
    ...overrides,
  }) as unknown as AuthSessionState;

const rotation = (sessionToken: string) =>
  ({ sessionToken, role: "client" }) as unknown as AuthBearerBootstrapResult;

function createStore(initial: string) {
  let stored: string | null = initial;
  return {
    read: vi.fn(async () => stored),
    write: vi.fn(async (_environmentId: EnvironmentId, token: string) => {
      stored = token;
      return true;
    }),
    current: () => stored,
  };
}

describe("shouldRenewSavedSession", () => {
  it("renews a bearer pairing once its session is a day old", () => {
    expect(shouldRenewSavedSession(bearerSession(30 * DAY_MS), NOW)).toBe(false);
    expect(shouldRenewSavedSession(bearerSession(29 * DAY_MS + 60_000), NOW)).toBe(false);
    expect(shouldRenewSavedSession(bearerSession(29 * DAY_MS - 60_000), NOW)).toBe(true);
    expect(shouldRenewSavedSession(bearerSession(2 * DAY_MS), NOW)).toBe(true);
  });

  it("leaves cookie sessions, rejected sessions and unknown lifetimes alone", () => {
    expect(
      shouldRenewSavedSession(
        bearerSession(DAY_MS, { sessionMethod: "browser-session-cookie" }),
        NOW,
      ),
    ).toBe(false);
    expect(shouldRenewSavedSession(bearerSession(DAY_MS, { authenticated: false }), NOW)).toBe(
      false,
    );
    expect(shouldRenewSavedSession(bearerSession(DAY_MS, { expiresAt: undefined }), NOW)).toBe(
      false,
    );
  });
});

describe("createSavedSessionRenewal", () => {
  it("stores the successor, reads it back, and uses it once", async () => {
    const store = createStore("bearer-1");
    const rotate = vi.fn(async () => rotation("bearer-2"));
    const fetchSessionState = vi.fn(async () => bearerSession(30 * DAY_MS));
    const renewal = createSavedSessionRenewal({
      readBearerToken: store.read,
      writeBearerToken: store.write,
      now: () => NOW,
    });
    const request = {
      environmentId,
      session: bearerSession(20 * DAY_MS),
      bearerToken: "bearer-1",
      fetchSessionState,
      rotate,
    };

    // Two connects at once rotate once.
    const [first, second] = await Promise.all([renewal.renew(request), renewal.renew(request)]);

    expect([first, second]).toEqual(["bearer-2", "bearer-2"]);
    expect(rotate).toHaveBeenCalledOnce();
    expect(rotate).toHaveBeenCalledWith("bearer-1");
    expect(store.current()).toBe("bearer-2");
    // Its first use supersedes the old bearer on the node.
    expect(fetchSessionState).toHaveBeenCalledWith("bearer-2");
  });

  it("keeps the working bearer when the successor cannot be stored", async () => {
    const store = createStore("bearer-1");
    const fetchSessionState = vi.fn(async () => bearerSession(30 * DAY_MS));
    const renewal = createSavedSessionRenewal({
      readBearerToken: store.read,
      writeBearerToken: async () => false,
      now: () => NOW,
    });

    await expect(
      renewal.renew({
        environmentId,
        session: bearerSession(20 * DAY_MS),
        bearerToken: "bearer-1",
        fetchSessionState,
        rotate: async () => rotation("bearer-2"),
      }),
    ).resolves.toBe("bearer-1");
    expect(fetchSessionState).not.toHaveBeenCalled();
  });

  it("asks again after an outage, but not after the node declined", async () => {
    const store = createStore("bearer-1");
    const renewal = createSavedSessionRenewal({
      readBearerToken: store.read,
      writeBearerToken: store.write,
      now: () => NOW,
    });
    const outage = vi.fn(async (): Promise<AuthBearerBootstrapResult> => {
      throw new Error("fetch failed");
    });
    const declined = vi.fn(async (): Promise<AuthBearerBootstrapResult> => {
      throw new RemoteEnvironmentAuthHttpError("This pairing is a year old.", 409);
    });
    const request = {
      environmentId,
      session: bearerSession(20 * DAY_MS),
      bearerToken: "bearer-1",
      fetchSessionState: async () => bearerSession(20 * DAY_MS),
    };

    await expect(renewal.renew({ ...request, rotate: outage })).resolves.toBe("bearer-1");
    await expect(renewal.renew({ ...request, rotate: declined })).resolves.toBe("bearer-1");
    await expect(renewal.renew({ ...request, rotate: declined })).resolves.toBe("bearer-1");

    expect(outage).toHaveBeenCalledOnce();
    expect(declined).toHaveBeenCalledOnce();
    expect(store.current()).toBe("bearer-1");
  });

  it("never holds a connect on a renewal the node does not answer", async () => {
    vi.useFakeTimers();
    try {
      const store = createStore("bearer-1");
      const renewal = createSavedSessionRenewal({
        readBearerToken: store.read,
        writeBearerToken: store.write,
        now: () => NOW,
      });
      const request = {
        environmentId,
        session: bearerSession(20 * DAY_MS),
        bearerToken: "bearer-1",
        fetchSessionState: async () => bearerSession(20 * DAY_MS),
      };
      const hungRotate = vi.fn(() => new Promise<AuthBearerBootstrapResult>(() => undefined));

      // The rotation never answers: the connect goes on with the presented
      // bearer, which the node keeps valid.
      const stalled = renewal.renew({ ...request, rotate: hungRotate });
      await vi.advanceTimersByTimeAsync(SAVED_ENVIRONMENT_SESSION_CHECK_TIMEOUT_MS);
      await expect(stalled).resolves.toBe("bearer-1");
      expect(store.current()).toBe("bearer-1");

      // An unanswered rotation is not a refusal: the next connect asks again,
      // and its unanswered activation does not hold it either.
      const rotate = vi.fn(async () => rotation("bearer-2"));
      const renewed = renewal.renew({
        ...request,
        rotate,
        fetchSessionState: () => new Promise<AuthSessionState>(() => undefined),
      });
      await vi.advanceTimersByTimeAsync(SAVED_ENVIRONMENT_SESSION_CHECK_TIMEOUT_MS);
      await expect(renewed).resolves.toBe("bearer-2");
      expect(rotate).toHaveBeenCalledOnce();
      expect(store.current()).toBe("bearer-2");
    } finally {
      vi.useRealTimers();
    }
  });

  it("presents only the bearer stored now, never one remembered from earlier", async () => {
    let read: () => Promise<string | null> = async () => "bearer-2";
    const renewal = createSavedSessionRenewal({
      readBearerToken: () => read(),
      writeBearerToken: async () => true,
    });

    await expect(renewal.readBearerToken(environmentId)).resolves.toBe("bearer-2");
    // A locked keychain, a failed decrypt, a pruned browser copy: the attempt
    // fails and retries rather than presenting a bearer that may be superseded.
    read = async () => {
      throw new Error("errSecInteractionNotAllowed");
    };
    await expect(renewal.readBearerToken(environmentId)).rejects.toBeInstanceOf(
      SavedEnvironmentBearerUnavailableError,
    );
    read = async () => null;
    await expect(renewal.readBearerToken(environmentId)).rejects.toBeInstanceOf(
      SavedEnvironmentBearerUnavailableError,
    );
  });

  describe("keepRenewed", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("renews a pairing that stays connected each time it falls due", async () => {
      const store = createStore("bearer-1");
      let current = true;
      // bearer-1 was issued ten days ago; each renewal lives thirty days.
      const issuedAt = new Map<string, number>([["bearer-1", NOW - 10 * DAY_MS]]);
      const fetchSessionState = vi.fn(async (bearerToken: string) =>
        bearerSession(issuedAt.get(bearerToken)! + 30 * DAY_MS - NOW),
      );
      const rotate = vi.fn(async () => {
        const next = `bearer-${issuedAt.size + 1}`;
        issuedAt.set(next, Date.now());
        return rotation(next);
      });
      const renewal = createSavedSessionRenewal({
        readBearerToken: store.read,
        writeBearerToken: store.write,
      });
      renewal.keepRenewed({
        environmentId,
        session: await fetchSessionState("bearer-1"),
        isCurrent: () => current,
        fetchSessionState,
        rotate,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(rotate).toHaveBeenCalledExactlyOnceWith("bearer-1");
      expect(store.current()).toBe("bearer-2");

      // The renewal itself is due a day later, not before.
      await vi.advanceTimersByTimeAsync(DAY_MS - 60_000);
      expect(rotate).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2 * 60_000);
      expect(rotate).toHaveBeenLastCalledWith("bearer-2");
      expect(store.current()).toBe("bearer-3");

      // Replaced (disconnected, removed, paired again): it stops.
      current = false;
      fetchSessionState.mockClear();
      await vi.advanceTimersByTimeAsync(5 * DAY_MS);
      expect(fetchSessionState).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
    });

    it("arms nothing for a session that never renews", () => {
      const store = createStore("cookie");
      const renewal = createSavedSessionRenewal({
        readBearerToken: store.read,
        writeBearerToken: store.write,
      });
      renewal.keepRenewed({
        environmentId,
        session: bearerSession(DAY_MS, { sessionMethod: "browser-session-cookie" }),
        isCurrent: () => true,
        fetchSessionState: async () => bearerSession(DAY_MS),
        rotate: async () => rotation("never"),
      });

      expect(vi.getTimerCount()).toBe(0);
    });
  });
});
