import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { createPrimaryAuth } from "./primaryAuth.ts";

function response(body: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => (typeof body === "string" ? body : JSON.stringify(body)),
  };
}

const session = {
  authenticated: false,
  auth: {
    policy: "local-only",
    bootstrapMethods: ["one-time-token"],
    sessionMethods: ["browser-session-cookie"],
    sessionCookieName: "ryco_session",
  },
};

describe("primary auth platform fakes", () => {
  it("uses one take-once pairing source and destroys it before the credential escapes", async () => {
    let pairingCredential: string | null = "pairing-token";
    const take = vi.fn(async () => {
      const value = pairingCredential;
      pairingCredential = null;
      return value;
    });
    const auth = createPrimaryAuth({
      endpoint: {
        origin: () => "https://app.test",
        readPrimaryTarget: () => null,
        resolveHttpUrl: (path) => `https://app.test${path}`,
        resolveWsUrl: (url) => url,
      },
      httpClient: { fetch: async () => response(session) },
      pairingCredentialSource: { take },
      readBootstrapCredential: () => null,
      sessionCredentials: {
        mode: "cookie",
        readCsrfToken: () => null,
        writeCsrfToken: () => undefined,
      },
    });

    expect(await auth.takePairingCredential()).toBe("pairing-token");
    expect(pairingCredential).toBeNull();
    expect(await auth.takePairingCredential()).toBeNull();
    expect(take).toHaveBeenCalledTimes(2);
  });

  it("single-flights silent desktop bootstrap and retries transient session reads with injected timing", async () => {
    let attempts = 0;
    const sleep = vi.fn(async () => undefined);
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/session")) {
        attempts += 1;
        if (attempts === 1) return response("temporarily unavailable", 503);
        if (attempts === 2) return response(session);
        return response({ ...session, authenticated: true });
      }
      return response({ authenticated: true });
    });
    const auth = createPrimaryAuth({
      endpoint: {
        origin: () => "https://app.test",
        readPrimaryTarget: () => null,
        resolveHttpUrl: (path) => `https://app.test${path}`,
        resolveWsUrl: (url) => url,
      },
      httpClient: { fetch },
      pairingCredentialSource: { take: async () => null },
      readBootstrapCredential: () => "desktop-bootstrap-token",
      sessionCredentials: {
        mode: "cookie",
        readCsrfToken: () => null,
        writeCsrfToken: () => undefined,
      },
      sleep,
    });

    const [left, right] = await Promise.all([
      auth.resolveInitialServerAuthGateState(),
      auth.resolveInitialServerAuthGateState(),
    ]);
    expect(left).toEqual({ status: "authenticated" });
    expect(right).toEqual({ status: "authenticated" });
    expect(fetch).toHaveBeenCalledTimes(4);
    expect(fetch).toHaveBeenNthCalledWith(
      3,
      "https://app.test/api/auth/bootstrap",
      expect.objectContaining({ body: JSON.stringify({ credential: "desktop-bootstrap-token" }) }),
    );
    expect(sleep).toHaveBeenCalledWith(500);
  });

  it("submits a manually entered pairing credential through the same fake HTTP boundary", async () => {
    const fetch = vi.fn(async () => response({ authenticated: true }));
    const auth = createPrimaryAuth({
      endpoint: {
        origin: () => "https://app.test",
        readPrimaryTarget: () => null,
        resolveHttpUrl: (path) => `https://app.test${path}`,
        resolveWsUrl: (url) => url,
      },
      httpClient: { fetch },
      pairingCredentialSource: { take: async () => null },
      readBootstrapCredential: () => null,
      sessionCredentials: {
        mode: "cookie",
        readCsrfToken: () => null,
        writeCsrfToken: () => undefined,
      },
    });

    await auth.submitServerAuthCredential("  manual-pairing-token  ");
    expect(fetch).toHaveBeenCalledWith(
      "https://app.test/api/auth/bootstrap",
      expect.objectContaining({ body: JSON.stringify({ credential: "manual-pairing-token" }) }),
    );
  });

  describe("control-plane deadlines", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    const authWith = (fetch: (url: string, init?: { signal?: AbortSignal }) => Promise<unknown>) =>
      createPrimaryAuth({
        endpoint: {
          origin: () => "https://app.test",
          readPrimaryTarget: () => null,
          resolveHttpUrl: (path) => `https://app.test${path}`,
          resolveWsUrl: (url) => url,
        },
        httpClient: { fetch: fetch as never },
        pairingCredentialSource: { take: async () => null },
        readBootstrapCredential: () => null,
        sessionCredentials: {
          mode: "cookie",
          readCsrfToken: () => null,
          writeCsrfToken: () => undefined,
        },
      });
    /** Never answers until aborted, like a request that reached a server before it listened. */
    const hang = (init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });

    it("retries a websocket token request that never answered", async () => {
      vi.useFakeTimers();
      let attempts = 0;
      const auth = authWith(async (_url, init) => {
        attempts += 1;
        if (attempts === 1) return hang(init);
        return response({ token: "ws-token", expiresAt: "2026-10-12T00:00:00.000Z" });
      });

      const issued = auth.issuePrimaryWebSocketToken();
      await vi.advanceTimersByTimeAsync(5_000 + 500);
      await expect(issued).resolves.toMatchObject({ token: "ws-token" });
      expect(attempts).toBe(2);
    });

    it("stops retrying once the connect attempt abandons the token request", async () => {
      vi.useFakeTimers();
      let attempts = 0;
      const auth = authWith(async () => {
        attempts += 1;
        return response("restarting", 503);
      });
      const attempt = new AbortController();

      const issued = auth.issuePrimaryWebSocketToken(attempt.signal).catch((error) => error);
      await vi.advanceTimersByTimeAsync(0);
      attempt.abort();
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await issued).toMatchObject({ status: 503 });
      expect(attempts).toBe(1);
    });

    it("bounds the session read that gates boot", async () => {
      vi.useFakeTimers();
      let attempts = 0;
      const auth = authWith(async (_url, init) => {
        attempts += 1;
        return attempts === 1 ? hang(init) : response({ ...session, authenticated: true });
      });

      const state = auth.fetchSessionState();
      await vi.advanceTimersByTimeAsync(5_500);
      await expect(state).resolves.toMatchObject({ authenticated: true });
    });
  });
});

describe("prefetched primary ws-token", () => {
  function setup(fetch: (url: string) => Promise<ReturnType<typeof response>>) {
    let nowMs = 1_000;
    const auth = createPrimaryAuth({
      endpoint: {
        origin: () => "https://app.test",
        readPrimaryTarget: () => null,
        resolveHttpUrl: (path) => `https://app.test${path}`,
        resolveWsUrl: (url) => url,
      },
      httpClient: { fetch: vi.fn(fetch) },
      pairingCredentialSource: { take: async () => null },
      readBootstrapCredential: () => null,
      sessionCredentials: {
        mode: "cookie",
        readCsrfToken: () => null,
        writeCsrfToken: () => undefined,
      },
      now: () => nowMs,
      sleep: async () => undefined,
    });
    return { auth, advance: (ms: number) => (nowMs += ms) };
  }

  it("hands the token requested alongside the session check to the first socket attempt only", async () => {
    let issued = 0;
    const fetch = vi.fn(async (url: string) => {
      if (url.endsWith("/api/auth/ws-token")) {
        issued += 1;
        return response({ token: `token-${issued}`, expiresAt: "2026-10-12T00:05:00.000Z" });
      }
      return response({ ...session, authenticated: true });
    });
    const { auth } = setup(fetch);

    auth.prefetchPrimaryWebSocketToken();
    expect(issued).toBe(1);
    expect((await auth.issuePrimaryWebSocketToken()).token).toBe("token-1");
    // The prefetched token is single use; the next attempt asks again.
    expect((await auth.issuePrimaryWebSocketToken()).token).toBe("token-2");
  });

  it("drops a prefetch that failed and asks again", async () => {
    let wsTokenRequests = 0;
    const { auth } = setup(async (url) => {
      if (!url.endsWith("/api/auth/ws-token")) return response(session);
      wsTokenRequests += 1;
      return wsTokenRequests === 1
        ? response("Unauthorized", 401)
        : response({ token: "fresh", expiresAt: "2026-10-12T00:05:00.000Z" });
    });

    auth.prefetchPrimaryWebSocketToken();
    expect((await auth.issuePrimaryWebSocketToken()).token).toBe("fresh");
    expect(wsTokenRequests).toBe(2);
  });

  it("never uses a stale or discarded prefetch", async () => {
    let issued = 0;
    const { auth, advance } = setup(async (url) => {
      if (!url.endsWith("/api/auth/ws-token")) return response(session);
      issued += 1;
      return response({ token: `token-${issued}`, expiresAt: "2026-10-12T00:05:00.000Z" });
    });

    auth.prefetchPrimaryWebSocketToken();
    advance(61_000);
    expect((await auth.issuePrimaryWebSocketToken()).token).toBe("token-2");

    auth.prefetchPrimaryWebSocketToken();
    auth.discardPrefetchedPrimaryWebSocketToken();
    expect((await auth.issuePrimaryWebSocketToken()).token).toBe("token-4");
  });
});
