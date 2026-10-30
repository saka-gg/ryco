import type {
  DpopProofInput,
  EndpointService,
  HttpClientService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";
import { describe, expect, it, vi } from "vite-plus/test";

import { HostedHubApi } from "./api.ts";
import { nativePushHubSupport } from "./nativePush.ts";

const HUB = "https://hub.example.test";
const TOKEN = "a1".repeat(32);

interface RecordedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: unknown;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function hubApi(
  mode: "bearer" | "cookie",
  answer: (request: RecordedRequest) => Response,
): {
  readonly api: HostedHubApi;
  readonly requests: RecordedRequest[];
  readonly proofs: DpopProofInput[];
} {
  const requests: RecordedRequest[] = [];
  const proofs: DpopProofInput[] = [];
  const httpClient: HttpClientService = {
    fetch: async (url, init) => {
      const request = {
        url: String(url),
        method: init?.method ?? "GET",
        headers: { ...(init?.headers as Record<string, string> | undefined) },
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      };
      requests.push(request);
      return answer(request);
    },
  };
  const endpoint: EndpointService = {
    origin: () => HUB,
    readPrimaryTarget: () => null,
    resolveHttpUrl: (pathname) => pathname,
    resolveWsUrl: (wsBaseUrl) => wsBaseUrl,
  };
  const sessionCredentials: SessionCredentialsService =
    mode === "bearer"
      ? {
          mode: "bearer",
          readCsrfToken: () => null,
          writeCsrfToken: () => undefined,
          readBearerToken: () => "native-session",
          writeBearerToken: () => undefined,
        }
      : { mode: "cookie", readCsrfToken: () => "csrf", writeCsrfToken: () => undefined };
  const api = new HostedHubApi({
    endpoint,
    httpClient,
    sessionCredentials,
    dpopSigner: {
      sign: async (input) => {
        proofs.push(input);
        return `proof-${input.method}`;
      },
    },
    passkeyCeremony: {
      authenticate: vi.fn(async () => ({ id: "unused" }) as never),
      register: vi.fn(async () => ({ id: "unused" }) as never),
    },
  });
  return { api, requests, proofs };
}

describe("the Hub's push capability", () => {
  it("is null for a Hub without push, which answers 404", async () => {
    const { api, requests } = hubApi("bearer", () => json({ error: "push_unavailable" }, 404));
    await expect(api.getNativePushCapability()).resolves.toBeNull();
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `GET ${HUB}/api/native/push/capability`,
    ]);
  });

  it("is null for an older Hub without the route, whatever its 404 body", async () => {
    const { api } = hubApi("bearer", () => new Response("Not Found", { status: 404 }));
    await expect(api.getNativePushCapability()).resolves.toBeNull();
  });

  it("reads platforms and topics, and ignores fields a newer Hub adds", async () => {
    const { api, proofs } = hubApi("bearer", () =>
      json({
        protocolVersion: 1,
        platforms: ["ios"],
        topics: ["dev.ryco.app"],
        maxDevices: 4,
      }),
    );
    await expect(api.getNativePushCapability()).resolves.toEqual({
      protocolVersion: 1,
      platforms: ["ios"],
      topics: ["dev.ryco.app"],
    });
    // A public route: the proof carries no session token.
    expect(proofs).toEqual([{ method: "GET", url: `${HUB}/api/native/push/capability` }]);
  });

  it("fails on a malformed document and on other errors instead of reporting no push", async () => {
    await expect(
      hubApi("bearer", () =>
        json({ protocolVersion: 2, platforms: ["ios"], topics: [] }),
      ).api.getNativePushCapability(),
    ).rejects.toMatchObject({ code: "invalid_response" });
    await expect(
      hubApi("bearer", () => json({ error: "unavailable" }, 503)).api.getNativePushCapability(),
    ).rejects.toMatchObject({ status: 503 });
  });
});

describe("the device's push registration with the Hub", () => {
  it("puts the APNs token under the native session and deletes it again", async () => {
    const { api, requests, proofs } = hubApi("bearer", () => json({ ok: true }));
    await api.registerNativePush({
      platform: "ios",
      token: TOKEN,
      environment: "sandbox",
      topic: "dev.ryco.app.dev",
    });
    await api.unregisterNativePush();

    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      `PUT ${HUB}/api/native/push/registration`,
      `DELETE ${HUB}/api/native/push/registration`,
    ]);
    expect(requests[0]?.body).toEqual({
      platform: "ios",
      token: TOKEN,
      environment: "sandbox",
      topic: "dev.ryco.app.dev",
    });
    expect(requests[1]?.body).toBeUndefined();
    for (const request of requests) {
      expect(request.headers.Authorization).toBe("DPoP native-session");
    }
    // The proof names the real method, or the Hub refuses it.
    expect(proofs.map((proof) => [proof.method, proof.token])).toEqual([
      ["PUT", "native-session"],
      ["DELETE", "native-session"],
    ]);
  });

  it("refuses a malformed token before any request, and a browser session", async () => {
    const bearer = hubApi("bearer", () => json({ ok: true }));
    await expect(
      bearer.api.registerNativePush({
        platform: "ios",
        token: "not-a-token",
        environment: "production",
        topic: "dev.ryco.app",
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(bearer.requests).toEqual([]);

    const cookie = hubApi("cookie", () => json({ ok: true }));
    await expect(
      cookie.api.registerNativePush({
        platform: "ios",
        token: TOKEN,
        environment: "production",
        topic: "dev.ryco.app",
      }),
    ).rejects.toMatchObject({ code: "native_only_transport" });
    await expect(cookie.api.unregisterNativePush()).rejects.toMatchObject({
      code: "native_only_transport",
    });
    expect(cookie.requests).toEqual([]);
  });

  it("keeps the Hub's refusal code for the caller to explain", async () => {
    const { api } = hubApi("bearer", () => json({ error: "push_enrollment_required" }, 409));
    await expect(
      api.registerNativePush({
        platform: "ios",
        token: TOKEN,
        environment: "production",
        topic: "dev.ryco.app",
      }),
    ).rejects.toMatchObject({ status: 409, wireCode: "push_enrollment_required" });
  });
});

describe("nativePushHubSupport", () => {
  const capability = { protocolVersion: 1, platforms: ["ios"], topics: ["dev.ryco.app"] } as const;

  it("is available only for a platform and topic the Hub sends to", () => {
    expect(nativePushHubSupport(capability, { platform: "ios", topic: "dev.ryco.app" })).toBe(
      "available",
    );
    expect(nativePushHubSupport(null, { platform: "ios", topic: "dev.ryco.app" })).toBe(
      "hub-unsupported",
    );
    expect(
      nativePushHubSupport(
        { ...capability, platforms: [] },
        { platform: "ios", topic: "dev.ryco.app" },
      ),
    ).toBe("platform-unsupported");
    expect(nativePushHubSupport(capability, { platform: "ios", topic: "dev.ryco.app.dev" })).toBe(
      "topic-unsupported",
    );
  });
});
