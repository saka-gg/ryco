import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type {
  DpopProofInput,
  DpopSignerService,
  EndpointService,
  HttpClientService,
  NativeAuthorizationService,
  PasskeyCeremonyService,
  SessionCredentialsService,
} from "@ryco/client-runtime/platform";

import { HostedHubApi, HostedHubApiError } from "./api";
import { encodeBase64Url } from "../relay/base64url";

const PASSKEY_ID = "pkey_aaaaaaaaaaaaaaaaaaaaaa";

const originalFetch = globalThis.fetch;
const originalWindow = globalThis.window;

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** In-memory CSRF holder mirroring the web `SessionCredentials` adapter. */
function inMemorySessionCredentials(): SessionCredentialsService {
  let csrfToken: string | null = null;
  return {
    mode: "cookie",
    readCsrfToken: () => csrfToken,
    writeCsrfToken: (token) => {
      csrfToken = token;
    },
  };
}

/** Mirrors the web `HttpClient` adapter: promotes plain headers to `Headers`. */
const fakeHttpClient: HttpClientService = {
  fetch: (url, init) =>
    init === undefined
      ? globalThis.fetch(url)
      : globalThis.fetch(url, {
          ...init,
          ...(init.headers && typeof init.headers === "object"
            ? { headers: new Headers(init.headers as Record<string, string>) }
            : {}),
        } as RequestInit),
};

/** The promoted `Headers` of a recorded request, without unsafe optional chaining. */
function headersOf(init: RequestInit | undefined): Headers {
  return init?.headers as Headers;
}

const fakeEndpoint: EndpointService = {
  origin: () => (globalThis.window as unknown as { location: { origin: string } }).location.origin,
  readPrimaryTarget: () => null,
  resolveHttpUrl: (pathname) => pathname,
  resolveWsUrl: (wsBaseUrl) => wsBaseUrl,
};

function createApi(passkeyCeremony?: Partial<PasskeyCeremonyService>): HostedHubApi {
  return new HostedHubApi({
    endpoint: fakeEndpoint,
    httpClient: fakeHttpClient,
    sessionCredentials: inMemorySessionCredentials(),
    passkeyCeremony: {
      authenticate: vi.fn(async () => ({ id: "authenticate-not-used" }) as never),
      register: vi.fn(async () => ({ id: "register-not-used" }) as never),
      ...passkeyCeremony,
    },
  });
}

const session = {
  account: {
    id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    displayName: "Ada",
    role: "owner",
    createdAt: 1_752_710_400_000,
    disabledAt: null,
  },
  session: {
    id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
    accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
    createdAt: 1_752_710_400_000,
    expiresAt: 1_752_796_800_000,
    lastSeenAt: 1_752_710_400_000,
    revokedAt: null,
    revocationReasonCode: null,
  },
  csrfToken: "csrf-canary",
} as const;

function hostedNode(id: string) {
  return {
    id,
    environmentId: "env_aaaaaaaaaaaaaaaaaaaaaa",
    label: "Studio",
    platformOs: "linux",
    platformArch: "arm64",
    clientVersion: "0.9.0",
    createdAt: 1,
    updatedAt: 2,
    lastAuthenticatedAt: 2,
    revokedAt: null,
    revocationReasonCode: null,
    grant: { id: "grant_aaaaaaaaaaaaaaaaaaaaaa", role: "operator" },
    effectiveRole: "operator",
    presence: { online: true, lastHeartbeatAt: 3 },
  } as const;
}

/** The minimum registration challenge `validatePasskeyRegistrationOptions` accepts. */
const registrationOptions = {
  challenge: encodeBase64Url(new Uint8Array([7, 8, 9])),
  rp: { name: "Ryco Hub" },
  user: { id: encodeBase64Url(new Uint8Array([4, 5])), name: "ada", displayName: "Ada" },
  pubKeyCredParams: [{ type: "public-key", alg: -7 }],
} as const;

beforeEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://hub.example.test" } },
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  Object.defineProperty(globalThis, "window", { configurable: true, value: originalWindow });
  vi.restoreAllMocks();
});

describe("HostedHubApi", () => {
  it("validates the exact fail-closed bootstrap availability response", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response({ available: true }));
    await expect(api.getBootstrapAvailability()).resolves.toBe(true);

    globalThis.fetch = vi.fn(async () => response({ available: true, detail: "unexpected" }));
    await expect(api.getBootstrapAvailability()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("uses the existing same-origin first-owner WebAuthn registration endpoints", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const register = vi.fn(async () => ({ id: "passkey-response-canary" }) as never);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1
        ? response({
            options: {
              challenge: encodeBase64Url(new Uint8Array([1, 2, 3])),
              rp: { name: "Ryco Hub" },
              user: {
                id: encodeBase64Url(new Uint8Array([4, 5])),
                name: "ada",
                displayName: "Ada",
              },
              pubKeyCredParams: [{ type: "public-key", alg: -7 }],
            },
          })
        : response({ ...session, recoveryCodes: ["recovery-sensitive-canary"] }, 201);
    });

    const api = createApi({ register });
    const result = await api.bootstrapOwner({
      credential: "bootstrap-sensitive-canary",
      displayName: "Ada",
      passkeyLabel: "Primary",
    });

    expect(requests.map(({ input }) => input)).toEqual([
      "/api/auth/bootstrap/registration/options",
      "/api/auth/bootstrap/registration/verify",
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
      credential: "bootstrap-sensitive-canary",
      displayName: "Ada",
      passkeyLabel: "Primary",
    });
    // The fail-closed codec runs in front of the platform ceremony seam: the
    // ceremony receives already-validated options with a decoded challenge.
    expect(register).toHaveBeenCalledOnce();
    const registeredOptions = register.mock.calls[0]![0] as {
      challenge: Uint8Array;
      rp: { name: string };
    };
    expect([...new Uint8Array(registeredOptions.challenge)]).toEqual([1, 2, 3]);
    expect(registeredOptions.rp.name).toBe("Ryco Hub");
    expect(register.mock.calls[0]![1]).toBeUndefined();
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      response: { id: "passkey-response-canary" },
    });
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(result.recoveryCodes).toEqual(["recovery-sensitive-canary"]);
    expect(requests.map(({ input }) => String(input)).join(" ")).not.toContain(
      "bootstrap-sensitive-canary",
    );
  });

  it("uses same-origin no-store cookie requests and session-bound CSRF", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1
        ? response(session)
        : response(
            {
              ticket: "ticket-sensitive-canary",
              expiresAt: Date.now() + 60_000,
              protocolMajor: 1,
              protocolMinor: 2,
            },
            201,
          );
    });
    const api = createApi();
    await api.restoreSession();
    const issued = await api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa");
    expect(issued.ticket).toBe("ticket-sensitive-canary");
    expect(requests[0]?.input).toBe("/api/auth/session");
    expect(requests[0]?.init).toMatchObject({ credentials: "same-origin", cache: "no-store" });
    expect(requests[1]?.input).toBe("/api/relay/tickets");
    const headers = requests[1]?.init?.headers as Headers;
    expect(headers.get("X-Ryco-CSRF")).toBe("csrf-canary");
    expect(JSON.stringify(requests)).not.toContain("ticket-sensitive-canary");
    expect(String(requests[1]?.input)).not.toContain("node_aaaaaaaaaaaaaaaaaaaaaa");
  });

  it.each([2, 3] as const)(
    "offers the current relay version and accepts selected minor %i",
    async (protocolMinor) => {
      const api = createApi();
      globalThis.fetch = vi.fn(async () => response(session));
      await api.restoreSession();
      const fetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
        response(
          { ticket: "ticket", expiresAt: Date.now() + 60_000, protocolMajor: 1, protocolMinor },
          201,
        ),
      );
      globalThis.fetch = fetch;
      await expect(api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa")).resolves.toMatchObject({
        protocolMinor,
      });
      expect(JSON.parse(String(fetch.mock.calls[0]?.[1]?.body))).toMatchObject({
        protocolMinor: 3,
      });
    },
  );

  it("retries an old Hub's explicit schema rejection once with minor 2", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "invalid_request" }, 400))
      .mockResolvedValueOnce(
        response(
          { ticket: "ticket", expiresAt: Date.now() + 60_000, protocolMajor: 1, protocolMinor: 2 },
          201,
        ),
      );
    globalThis.fetch = fetch;
    await expect(api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa")).resolves.toMatchObject({
      protocolMinor: 2,
    });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch.mock.calls.map((call) => JSON.parse(String(call[1]?.body)).protocolMinor)).toEqual(
      [3, 2],
    );
    expect(
      fetch.mock.calls.every((call) => headersOf(call[1]).get("X-Ryco-CSRF") === "csrf-canary"),
    ).toBe(true);
  });

  it.each([0, 1, 4, "3"])(
    "rejects an unsupported selected relay minor %s",
    async (protocolMinor) => {
      const api = createApi();
      globalThis.fetch = vi.fn(async () => response(session));
      await api.restoreSession();
      globalThis.fetch = vi.fn(async () =>
        response(
          { ticket: "ticket", expiresAt: Date.now() + 60_000, protocolMajor: 1, protocolMinor },
          201,
        ),
      );
      await expect(api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({
        code: "invalid_response",
      });
      expect(globalThis.fetch).toHaveBeenCalledOnce();
    },
  );

  it("rejects a widened response after retrying a legacy Hub", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response({ error: "invalid_request" }, 400))
      .mockResolvedValueOnce(
        response(
          { ticket: "ticket", expiresAt: Date.now() + 60_000, protocolMajor: 1, protocolMinor: 3 },
          201,
        ),
      );
    await expect(api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    [401, "unauthorized"],
    [403, "forbidden"],
    [409, "unsupported_version"],
    [500, "internal_error"],
  ] as const)("never repeats ticket issuance after %i %s", async (status, code) => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();
    const fetch = vi.fn(async () => response({ error: code }, status));
    globalThis.fetch = fetch;
    await expect(api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({
      status,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });

  it("keeps the legacy ticket response grant-free", async () => {
    const api = createApi();
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(response(session))
      .mockResolvedValueOnce(
        response({
          ticket: "ticket-sensitive-canary",
          expiresAt: Date.now() + 60_000,
          protocolMajor: 1,
          protocolMinor: 2,
          deviceGrant: "must-not-cross-the-browser-boundary",
        }),
      );
    await api.restoreSession();
    await expect(api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("lists, renames, and revokes account E2EE devices with cookie CSRF separation", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const revoked = {
      ...nativeE2eeEnrollment,
      enrollmentRevision: 2,
      deviceAuthEpoch: 3,
      status: "revoked",
      updatedAt: nativeE2eeNow + 1,
      revokedAt: nativeE2eeNow + 1,
    } as const;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      switch (requests.length) {
        case 1:
          return response(session);
        case 2:
          return response({ protocolVersion: 1, devices: [nativeE2eeEnrollment] });
        case 3:
          return response({
            protocolVersion: 1,
            enrollment: { ...nativeE2eeEnrollment, enrollmentRevision: 2, deviceLabel: "Phone" },
          });
        default:
          return response({ protocolVersion: 1, enrollment: revoked });
      }
    });
    const api = createApi();
    await api.restoreSession();

    await expect(api.listE2eeDevices()).resolves.toEqual([nativeE2eeEnrollment]);
    await expect(
      api.renameE2eeDevice(nativeE2eeEnrollmentId, {
        expectedEnrollmentRevision: 1,
        deviceLabel: "Phone",
      }),
    ).resolves.toMatchObject({ enrollmentRevision: 2, deviceLabel: "Phone" });
    await expect(
      api.revokeE2eeDevice(nativeE2eeEnrollmentId, {
        expectedEnrollmentRevision: 2,
        reasonCode: "owner_requested",
      }),
    ).resolves.toMatchObject({ status: "revoked" });

    expect(requests.map(({ input }) => String(input))).toEqual([
      "/api/auth/session",
      "/api/account/e2ee/devices",
      `/api/account/e2ee/devices/${nativeE2eeEnrollmentId}/rename`,
      `/api/account/e2ee/devices/${nativeE2eeEnrollmentId}/revoke`,
    ]);
    expect(headersOf(requests[1]?.init).get("X-Ryco-CSRF")).toBeNull();
    expect(headersOf(requests[2]?.init).get("X-Ryco-CSRF")).toBe("csrf-canary");
    expect(headersOf(requests[3]?.init).get("X-Ryco-CSRF")).toBe("csrf-canary");
  });

  it("returns stable bounded errors without reflecting response details", async () => {
    globalThis.fetch = vi.fn(async () =>
      response({ error: "session_invalid", details: "sensitive-response-canary" }, 401),
    );
    const api = createApi();
    const error = await api.restoreSession().catch((cause) => cause);
    expect(error).toBeInstanceOf(HostedHubApiError);
    expect((error as Error).message).toBe("Your Hub session has expired.");
    expect((error as Error).message).not.toContain("sensitive-response-canary");
  });

  it("rejects disabled accounts and revoked sessions returned by a malformed Hub", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () =>
      response({
        ...session,
        account: { ...session.account, disabledAt: Date.now() },
      }),
    );
    await expect(api.restoreSession()).rejects.toMatchObject({ code: "session_invalid" });

    globalThis.fetch = vi.fn(async () =>
      response({
        ...session,
        session: { ...session.session, revokedAt: Date.now() },
      }),
    );
    await expect(api.restoreSession()).rejects.toMatchObject({ code: "session_invalid" });
  });

  it("bounds opaque account identifiers by their canonical E2EE UTF-8 limit", async () => {
    const api = createApi();
    for (const accountId of ["", "a".repeat(257), "😀".repeat(65)]) {
      globalThis.fetch = vi.fn(async () =>
        response({
          ...session,
          account: { ...session.account, id: accountId },
          session: { ...session.session, accountId },
        }),
      );
      await expect(api.restoreSession()).rejects.toMatchObject({ code: "invalid_response" });
      expect(api.hasSessionMaterial).toBe(false);
    }

    for (const accountId of ["a".repeat(256), "😀".repeat(64), "acct\u0000opaque", "é", "é"]) {
      globalThis.fetch = vi.fn(async () =>
        response({
          ...session,
          account: { ...session.account, id: accountId },
          session: { ...session.session, accountId },
        }),
      );
      const restored = await api.restoreSession();
      expect(restored.account.id).toBe(accountId);
      expect(restored.session.accountId).toBe(accountId);
    }
  });

  it("validates canonical relay node identifiers at response and request boundaries", async () => {
    const api = createApi();
    const invalid = [
      "",
      `node_${"n".repeat(21)}`,
      `node_${"n".repeat(44)}`,
      `node_${"n".repeat(21)}+`,
      `node_${"n".repeat(10)}\u0000${"n".repeat(11)}`,
    ];
    for (const nodeId of invalid) {
      globalThis.fetch = vi.fn(async () => response({ nodes: [hostedNode(nodeId)] }));
      await expect(api.listNodes()).rejects.toMatchObject({ code: "invalid_response" });

      const request = vi.fn(async () =>
        response({ ticket: "ticket", expiresAt: 1, protocolMajor: 1, protocolMinor: 2 }, 201),
      );
      globalThis.fetch = request;
      await expect(api.issueRelayTicket(nodeId)).rejects.toMatchObject({ code: "invalid_request" });
      expect(request).not.toHaveBeenCalled();
    }

    for (const nodeId of [`node_${"n".repeat(22)}`, `node_${"n".repeat(43)}`]) {
      globalThis.fetch = vi.fn(async () => response({ nodes: [hostedNode(nodeId)] }));
      await expect(api.listNodes()).resolves.toMatchObject([{ id: nodeId }]);
    }

    const maxNodeId = `node_${"m".repeat(43)}`;
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();
    const request = vi.fn(async () =>
      response({ ticket: "ticket", expiresAt: 1, protocolMajor: 1, protocolMinor: 2 }, 201),
    );
    globalThis.fetch = request;
    await expect(api.issueRelayTicket(maxNodeId)).resolves.toMatchObject({ ticket: "ticket" });
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(request.mock.calls[0]?.[1]?.body))).toEqual({
      nodeId: maxNodeId,
      capability: "ryco.rpc",
      protocolMajor: 1,
      protocolMinor: 3,
    });
  });

  it("rejects malformed directory and ticket responses", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();
    globalThis.fetch = vi.fn(async () => response({ nodes: [{ id: "node_bad" }] }));
    await expect(api.listNodes()).rejects.toMatchObject({ code: "invalid_response" });
    globalThis.fetch = vi.fn(async () => response({ ticket: "bad" }, 201));
    await expect(api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("rejects unsafe session and relay timestamps", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () =>
      response({ ...session, account: { ...session.account, createdAt: 1.5 } }),
    );
    await expect(api.restoreSession()).rejects.toMatchObject({ code: "invalid_response" });

    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();
    globalThis.fetch = vi.fn(async () =>
      response({
        ticket: "ticket",
        expiresAt: Number.POSITIVE_INFINITY,
        protocolMajor: 1,
        protocolMinor: 2,
      }),
    );
    await expect(api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("accepts the bounded directory contract and discards unexpected metadata", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();
    globalThis.fetch = vi.fn(async () =>
      response({
        nodes: [
          {
            ...hostedNode("node_aaaaaaaaaaaaaaaaaaaaaa"),
            unexpectedSensitiveMetadata: "directory-sensitive-canary",
          },
        ],
      }),
    );
    const nodes = await api.listNodes();
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({ label: "Studio", effectiveRole: "operator" });
    expect(JSON.stringify(nodes)).not.toContain("directory-sensitive-canary");
  });

  it("accepts optional browser-eligibility capabilities and rejects partial capability records", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();
    globalThis.fetch = vi.fn(async () =>
      response({
        nodes: [
          {
            ...hostedNode("node_aaaaaaaaaaaaaaaaaaaaaa"),
            capabilities: { repositoryIdentity: true, nativeClientRequired: true },
          },
        ],
      }),
    );
    await expect(api.listNodes()).resolves.toMatchObject([
      { capabilities: { repositoryIdentity: true, nativeClientRequired: true } },
    ]);

    globalThis.fetch = vi.fn(async () =>
      response({
        nodes: [
          {
            ...hostedNode("node_aaaaaaaaaaaaaaaaaaaaaa"),
            capabilities: { nativeClientRequired: true },
          },
        ],
      }),
    );
    await expect(api.listNodes()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("renames a node with a trimmed bounded body and session-bound CSRF", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1 ? response(session) : response({ ok: true });
    });
    const api = createApi();
    await api.restoreSession();

    await expect(
      api.renameNode("node_aaaaaaaaaaaaaaaaaaaaaa", "  Release node  "),
    ).resolves.toBeUndefined();

    expect(requests[1]?.input).toBe("/api/admin/nodes/node_aaaaaaaaaaaaaaaaaaaaaa/rename");
    expect(requests[1]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(headersOf(requests[1]?.init).get("X-Ryco-CSRF")).toBe("csrf-canary");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ label: "Release node" });
  });

  it("revokes a node with the reason code the Hub's strict body schema requires", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1 ? response(session) : response({ ok: true });
    });
    const api = createApi();
    await api.restoreSession();

    await expect(
      api.revokeNode("node_aaaaaaaaaaaaaaaaaaaaaa", "owner_revoked"),
    ).resolves.toBeUndefined();

    expect(requests[1]?.input).toBe("/api/admin/nodes/node_aaaaaaaaaaaaaaaaaaaaaa/revoke");
    expect(requests[1]?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(headersOf(requests[1]?.init).get("X-Ryco-CSRF")).toBe("csrf-canary");
    // `reasonCode` is REQUIRED and the schema is strict, so neither omitting it
    // nor adding a field alongside it is a request the Hub will accept.
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ reasonCode: "owner_revoked" });
  });

  it("rejects invalid node revoke input before any I/O", async () => {
    const fetchSpy = vi.fn(async () => response({ ok: true }));
    globalThis.fetch = fetchSpy;
    const api = createApi();

    await expect(api.revokeNode("node_bad", "owner_revoked")).rejects.toMatchObject({
      code: "invalid_request",
    });
    // The Hub's `REASON` is `/^[a-z0-9._-]{1,64}$/`. A sentence, an empty value,
    // or an over-long one is a 400 that names no field.
    for (const reason of ["", "Owner revoked", "a".repeat(65)]) {
      await expect(api.revokeNode("node_aaaaaaaaaaaaaaaaaaaaaa", reason)).rejects.toMatchObject({
        code: "invalid_request",
      });
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed on malformed and refused node revoke responses", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();

    globalThis.fetch = vi.fn(async () => response({ ok: true, detail: "revoke-sensitive-canary" }));
    const malformed = await api
      .revokeNode("node_aaaaaaaaaaaaaaaaaaaaaa", "owner_revoked")
      .catch((cause) => cause);
    expect(malformed).toMatchObject({ code: "invalid_response" });
    expect((malformed as Error).message).not.toContain("revoke-sensitive-canary");

    // A second revoke of the same node: the Hub's update is conditioned on the
    // node not already being revoked, so it answers `node_not_found`.
    globalThis.fetch = vi.fn(async () => response({ error: "node_not_found" }, 404));
    await expect(
      api.revokeNode("node_aaaaaaaaaaaaaaaaaaaaaa", "owner_revoked"),
    ).rejects.toMatchObject({ status: 404 });

    globalThis.fetch = vi.fn(async () => response({ error: "node_forbidden" }, 403));
    await expect(
      api.revokeNode("node_aaaaaaaaaaaaaaaaaaaaaa", "owner_revoked"),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("rejects invalid node rename input before any I/O", async () => {
    const fetchSpy = vi.fn(async () => response({ ok: true }));
    globalThis.fetch = fetchSpy;
    const api = createApi();

    await expect(api.renameNode("node_bad", "Studio")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(api.renameNode("node_aaaaaaaaaaaaaaaaaaaaaa", " ")).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      api.renameNode("node_aaaaaaaaaaaaaaaaaaaaaa", "N".repeat(101)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("fails closed on malformed and forbidden node rename responses", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();

    globalThis.fetch = vi.fn(async () => response({ ok: true, detail: "rename-sensitive-canary" }));
    const malformed = await api
      .renameNode("node_aaaaaaaaaaaaaaaaaaaaaa", "Studio")
      .catch((cause) => cause);
    expect(malformed).toMatchObject({ code: "invalid_response" });
    expect((malformed as Error).message).not.toContain("rename-sensitive-canary");

    globalThis.fetch = vi.fn(async () => response({ error: "forbidden" }, 403));
    await expect(api.renameNode("node_aaaaaaaaaaaaaaaaaaaaaa", "Studio")).rejects.toMatchObject({
      code: "forbidden",
      status: 403,
    });
  });

  it("forwards caller cancellation through a node rename", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();

    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = vi.fn(async (_input, init) => {
      expect(init?.signal?.aborted).toBe(true);
      throw new DOMException("cancelled", "AbortError");
    });

    await expect(
      api.renameNode("node_aaaaaaaaaaaaaaaaaaaaaa", "Studio", controller.signal),
    ).rejects.toMatchObject({ name: "AbortError" });
  });

  it("classifies transport unavailability without reflecting network detail", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => {
      throw new Error("sensitive-network-provider-detail");
    });

    const error = await api.restoreSession().catch((cause) => cause);

    expect(error).toMatchObject({
      code: "unavailable",
      reason: "transport-unavailable",
      message: "Ryco could not reach the Hub. Check your connection and try again.",
    });
    expect((error as Error).message).not.toContain("sensitive-network-provider-detail");
  });

  it("distinguishes the request deadline from caller cancellation", async () => {
    vi.useFakeTimers();
    try {
      const api = createApi();
      globalThis.fetch = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () =>
              reject(new DOMException("deadline", "AbortError")),
            );
          }),
      );

      const pending = api.restoreSession();
      const rejection = expect(pending).rejects.toMatchObject({
        code: "timeout",
        reason: "request-timeout",
        message: "The Hub did not respond in time. Check your connection and try again.",
      });
      await vi.advanceTimersByTimeAsync(30_000);
      await rejection;
    } finally {
      vi.useRealTimers();
    }
  });

  it("looks up, approves, and denies enrollments with session-bound CSRF", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const enrollment = {
      id: "enr_aaaaaaaaaaaaaaaaaaaaaa",
      label: "Studio",
      platformOs: "darwin",
      platformArch: "arm64",
      clientVersion: "0.1.8",
      algorithm: "ed25519",
      fingerprint: `SHA256:${"a".repeat(43)}`,
      createdAt: 10,
      expiresAt: 20,
    } as const;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      if (requests.length === 1) return response(session);
      if (requests.length === 2) return response({ enrollment });
      if (requests.length === 3) {
        return response({
          node: {
            id: "node_aaaaaaaaaaaaaaaaaaaaaa",
            environmentId: "env_aaaaaaaaaaaaaaaaaaaaaa",
          },
          grant: { id: "grant_aaaaaaaaaaaaaaaaaaaaaa", role: "owner" },
        });
      }
      return response({ ok: true });
    });

    const api = createApi();
    await api.restoreSession();
    await expect(api.lookupNodeEnrollment("ABCD-EFGH")).resolves.toEqual(enrollment);
    await expect(api.approveNodeEnrollment("ABCD-EFGH")).resolves.toBeUndefined();
    await expect(api.denyNodeEnrollment("ABCD-EFGH")).resolves.toBeUndefined();

    expect(requests.slice(1).map(({ input }) => input)).toEqual([
      "/api/admin/node-enrollments/lookup",
      "/api/admin/node-enrollments/approve",
      "/api/admin/node-enrollments/deny",
    ]);
    for (const request of requests.slice(1)) {
      const headers = request.init?.headers;
      expect(headers).toBeInstanceOf(Headers);
      expect((headers as Headers).get("X-Ryco-CSRF")).toBe("csrf-canary");
      expect(String(request.input)).not.toContain("ABCD-EFGH");
      expect(JSON.parse(String(request.init?.body))).toEqual({ deviceCode: "ABCD-EFGH" });
    }
  });

  it("lists account passkeys over the cookie transport and drops unexpected metadata", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1
        ? response(session)
        : response({
            passkeys: [
              {
                id: "credential-aaa",
                label: "Studio laptop",
                createdAt: 10,
                lastUsedAt: null,
                backupEligible: true,
                backupState: false,
                revokedAt: null,
                revocationReasonCode: null,
                unexpectedSensitiveMetadata: "passkey-sensitive-canary",
              },
            ],
          });
    });
    const api = createApi();
    await api.restoreSession();

    const passkeys = await api.listPasskeys();

    expect(requests[1]?.input).toBe("/api/account/passkeys");
    expect(requests[1]?.init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
    expect(passkeys).toEqual([
      {
        id: "credential-aaa",
        label: "Studio laptop",
        createdAt: 10,
        lastUsedAt: null,
        backupEligible: true,
        backupState: false,
        revokedAt: null,
        revocationReasonCode: null,
      },
    ]);
    expect(JSON.stringify(passkeys)).not.toContain("passkey-sensitive-canary");
  });

  it("reads a strict bounded account-security posture over the cookie transport", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1
        ? response(session)
        : response({
            passwordConfigured: true,
            totpEnrolled: false,
            emailDeliveryConfigured: true,
            email: { address: "ada@example.test", verified: true },
            externalIdentities: [
              {
                provider: "github",
                login: "octocat",
                displayName: "The Octocat",
                connectedAt: 10,
                lastUsedAt: null,
              },
            ],
          });
    });
    const api = createApi();
    await api.restoreSession();

    await expect(api.getAccountSecurity()).resolves.toEqual({
      passwordConfigured: true,
      totpEnrolled: false,
      emailDeliveryConfigured: true,
      email: { address: "ada@example.test", verified: true },
      externalIdentities: [
        {
          provider: "github",
          login: "octocat",
          displayName: "The Octocat",
          connectedAt: 10,
          lastUsedAt: null,
        },
      ],
    });
    expect(requests[1]?.input).toBe("/api/account/security");
    expect(requests[1]?.init).toMatchObject({
      method: "GET",
      credentials: "same-origin",
      cache: "no-store",
    });
  });

  it("rejects malformed or widened account-security responses", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();

    for (const payload of [
      { passwordConfigured: false, totpEnrolled: false },
      {
        passwordConfigured: "false",
        totpEnrolled: false,
        emailDeliveryConfigured: false,
        email: null,
      },
      {
        passwordConfigured: false,
        totpEnrolled: false,
        emailDeliveryConfigured: "false",
        email: null,
      },
      {
        passwordConfigured: false,
        totpEnrolled: false,
        emailDeliveryConfigured: false,
        email: { address: "ada@example.test", verified: false, token: "sensitive-canary" },
      },
      {
        passwordConfigured: false,
        totpEnrolled: false,
        emailDeliveryConfigured: false,
        email: null,
        passwordHash: "sensitive-canary",
      },
    ]) {
      globalThis.fetch = vi.fn(async () => response(payload));
      await expect(api.getAccountSecurity()).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("rejects malformed passkey lists", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();

    globalThis.fetch = vi.fn(async () => response({ passkeys: {} }));
    await expect(api.listPasskeys()).rejects.toMatchObject({ code: "invalid_response" });

    // The credential-id constraint is a response-projection bound: no request
    // path is built from an id, so this is about what may reach a view model.
    globalThis.fetch = vi.fn(async () => response({ passkeys: [{ id: "not a base64url id" }] }));
    await expect(api.listPasskeys()).rejects.toMatchObject({ code: "invalid_response" });

    // F7: an unbounded list is not a list.
    globalThis.fetch = vi.fn(async () =>
      response({
        passkeys: Array.from({ length: 257 }, (_value, index) => ({ id: `cred${index}` })),
      }),
    );
    await expect(api.listPasskeys()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("adds a passkey on the live session without minting or clobbering one", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const register = vi.fn(async () => ({ id: "added-passkey-canary" }) as never);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      if (requests.length === 1) return response(session);
      if (requests.length === 2) return response({ options: registrationOptions });
      // The add-passkey verify ROTATES the session: it returns the replacement
      // account/session plus a fresh CSRF token, and revokes the old session.
      return response(
        {
          ...session,
          csrfToken: "csrf-rotated-canary",
          passkey: { id: PASSKEY_ID, label: "Phone" },
        },
        201,
      );
    });
    const api = createApi({ register });
    await api.restoreSession();

    const added = await api.addPasskey({ passkeyLabel: "Phone" });

    expect(requests.slice(1).map(({ input }) => input)).toEqual([
      "/api/account/passkeys/registration/options",
      "/api/account/passkeys/registration/verify",
    ]);
    for (const request of requests.slice(1)) {
      // An authenticated ceremony: the session CSRF token rides both calls.
      expect(headersOf(request.init).get("X-Ryco-CSRF")).toBe("csrf-canary");
      expect(request.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    }
    // The Hub parses this body strictly and its member is `label`. Sending
    // `passkeyLabel` — which is what the two PRE-SESSION ceremonies take — is a
    // 400 before the ceremony starts.
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ label: "Phone" });
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({
      response: { id: "added-passkey-canary" },
    });
    expect(added).toEqual({
      passkey: {
        id: PASSKEY_ID,
        label: "Phone",
        createdAt: null,
        lastUsedAt: null,
        backupEligible: null,
        backupState: null,
        revokedAt: null,
        revocationReasonCode: null,
      },
      confirmed: true,
    });

    // The ROTATED session is adopted: the next CSRF-bound call presents the new
    // token, not the revoked one. Keeping the old token would 403 every later
    // mutation, and `isSessionFailure` does not match 403 — the session would
    // wedge until a reload.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return response({ ok: true });
    });
    await api.denyNodeEnrollment("ABCD-EFGH");
    expect(headersOf(requests[3]?.init).get("X-Ryco-CSRF")).toBe("csrf-rotated-canary");
  });

  it("never adopts an unvalidated CSRF token from an add-passkey verify", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      if (requests.length === 1) return response(session);
      if (requests.length === 2) return response({ options: registrationOptions });
      // A bare csrfToken with no account/session is not a validated session
      // response. The route DOES rotate, so the value must be adopted — but only
      // after the whole payload validates. An unreadable body is rejected and
      // displaces nothing.
      if (requests.length === 3) return response({ csrfToken: "csrf-unvalidated-canary" }, 201);
      return response({ ok: true });
    });
    const api = createApi({ register: vi.fn(async () => ({ id: "added" }) as never) });
    await api.restoreSession();

    await expect(api.addPasskey({ passkeyLabel: null })).rejects.toMatchObject({
      code: "invalid_response",
    });
    await api.denyNodeEnrollment("ABCD-EFGH");

    // The pre-existing token still works; the unvalidated one never landed.
    expect(headersOf(requests[3]?.init).get("X-Ryco-CSRF")).toBe("csrf-canary");
  });

  it("regenerates recovery codes as a mutation and rejects malformed lists", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1
        ? response(session)
        : // This route rotates the session too: fresh CSRF token, old one revoked.
          response({
            ...session,
            csrfToken: "csrf-rotated-canary",
            recoveryCodes: ["recovery-sensitive-canary"],
          });
    });
    const api = createApi();
    await api.restoreSession();

    await expect(api.regenerateRecoveryCodes()).resolves.toEqual(["recovery-sensitive-canary"]);

    expect(requests[1]?.input).toBe("/api/account/recovery-codes");
    expect(requests[1]?.init).toMatchObject({ method: "POST", credentials: "same-origin" });
    expect(headersOf(requests[1]?.init).get("X-Ryco-CSRF")).toBe("csrf-canary");
    // No code is ever echoed back to the Hub or placed in a URL.
    expect(JSON.stringify(requests)).not.toContain("recovery-sensitive-canary");

    // The replacement CSRF token is adopted, so the next mutation is not a 403.
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return response({ ok: true });
    });
    await api.denyNodeEnrollment("ABCD-EFGH");
    expect(headersOf(requests[2]?.init).get("X-Ryco-CSRF")).toBe("csrf-rotated-canary");

    globalThis.fetch = vi.fn(async () => response({ ...session, recoveryCodes: [] }));
    await expect(api.regenerateRecoveryCodes()).rejects.toMatchObject({ code: "invalid_response" });
    globalThis.fetch = vi.fn(async () => response({ ...session, recoveryCodes: [1, 2] }));
    await expect(api.regenerateRecoveryCodes()).rejects.toMatchObject({ code: "invalid_response" });
    globalThis.fetch = vi.fn(async () =>
      response({ ...session, recoveryCodes: Array.from({ length: 257 }, () => "code") }),
    );
    await expect(api.regenerateRecoveryCodes()).rejects.toMatchObject({ code: "invalid_response" });
    // A valid code list with NO replacement session is still a rejection: this
    // route always rotates, so a body without one cannot be read as success.
    globalThis.fetch = vi.fn(async () => response({ recoveryCodes: ["orphan"] }));
    await expect(api.regenerateRecoveryCodes()).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("does not apply the new recovery-code bounds to the pre-existing session paths", async () => {
    // A cap guessed for the new route must never reject a real registration
    // response: on bootstrap that would strand a user whose account already
    // exists server-side.
    const api = createApi({ register: vi.fn(async () => ({ id: "registered" }) as never) });
    const recoveryCodes = Array.from({ length: 300 }, () => "x".repeat(600));
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return call === 1
        ? response({ options: registrationOptions })
        : response({ ...session, recoveryCodes }, 201);
    });

    const result = await api.bootstrapOwner({
      credential: "bootstrap-sensitive-canary",
      displayName: "Ada",
      passkeyLabel: null,
    });
    expect(result.recoveryCodes).toHaveLength(300);
  });

  it("keeps browser-only registration reachable on the cookie transport", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1
        ? response({ options: registrationOptions })
        : response(session, 201);
    });
    const api = createApi({ register: vi.fn(async () => ({ id: "registered" }) as never) });

    await expect(
      api.redeemInvitation({
        secret: "invitation-sensitive-canary",
        displayName: "Ada",
        passkeyLabel: null,
      }),
    ).resolves.toMatchObject({ account: session.account });
    expect(requests.map(({ input }) => input)).toEqual([
      "/api/auth/invitations/registration/options",
      "/api/auth/invitations/registration/verify",
    ]);
    // The pre-session mint ceremony carries no CSRF token.
    expect(headersOf(requests[0]?.init).get("X-Ryco-CSRF")).toBeNull();
  });

  it("rejects malformed enrollment lookup and approval responses", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () => response(session));
    await api.restoreSession();

    globalThis.fetch = vi.fn(async () => response({ enrollment: { id: "enr_bad" } }));
    await expect(api.lookupNodeEnrollment("ABCD-EFGH")).rejects.toMatchObject({
      code: "invalid_response",
    });

    globalThis.fetch = vi.fn(async () => response({ node: {}, grant: {} }));
    await expect(api.approveNodeEnrollment("ABCD-EFGH")).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});

describe("HostedHubApi account credential management", () => {
  /** A restored cookie session, and the recorder every case below asserts on. */
  async function authenticated(): Promise<{
    readonly api: HostedHubApi;
    readonly requests: Array<{ input: RequestInfo | URL; init?: RequestInit }>;
    readonly reply: (value: unknown, status?: number) => void;
  }> {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    let next: { body: unknown; status: number } = { body: { ok: true }, status: 200 };
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1 ? response(session) : response(next.body, next.status);
    });
    const api = createApi();
    await api.restoreSession();
    return {
      api,
      requests,
      reply: (value, status = 200) => {
        next = { body: value, status };
      },
    };
  }

  it("posts every credential mutation to its Hub route with session-bound CSRF", async () => {
    const { api, requests } = await authenticated();

    await expect(
      api.setPassword({ password: "password-sensitive-canary" }),
    ).resolves.toBeUndefined();
    await expect(api.removePassword()).resolves.toBeUndefined();
    await expect(api.confirmTotpEnrollment({ code: "123456" })).resolves.toBeUndefined();
    await expect(api.revokeTotp()).resolves.toBeUndefined();
    await expect(
      api.requestEmailVerification({ email: "ada@example.test" }),
    ).resolves.toBeUndefined();
    await expect(api.revokePasskey(PASSKEY_ID)).resolves.toBeUndefined();

    expect(requests.slice(1).map(({ input }) => input)).toEqual([
      "/api/account/password",
      "/api/account/password/remove",
      "/api/account/totp/enrollment/verify",
      "/api/account/totp/revoke",
      "/api/account/email/verification",
      `/api/account/passkeys/${PASSKEY_ID}/revoke`,
    ]);
    for (const request of requests.slice(1)) {
      expect(request.init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      // Cookie transport: CSRF, never a bearer/DPoP header.
      expect(headersOf(request.init).get("X-Ryco-CSRF")).toBe("csrf-canary");
      expect(headersOf(request.init).get("Authorization")).toBeNull();
      expect(headersOf(request.init).get("DPoP")).toBeNull();
    }
    expect(requests.slice(1).map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      { password: "password-sensitive-canary" },
      {},
      { code: "123456" },
      {},
      { email: "ada@example.test" },
      {},
    ]);
    // A credential is never placed in a URL, only in a body over TLS.
    expect(requests.map(({ input }) => String(input)).join(" ")).not.toContain(
      "password-sensitive-canary",
    );
    expect(requests.map(({ input }) => String(input)).join(" ")).not.toContain("ada@example.test");
  });

  it("threads the fallback-session step-up code and omits it when there is none", async () => {
    const { api, requests } = await authenticated();

    await api.setPassword({ password: "pw", totpCode: "123456" });
    await api.removePassword({ totpCode: "234567" });
    await api.revokeTotp({ totpCode: "345678" });
    await api.requestEmailVerification({ email: "ada@example.test", totpCode: "456789" });

    expect(requests.slice(1, 5).map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      { password: "pw", totpCode: "123456" },
      { totpCode: "234567" },
      { totpCode: "345678" },
      { email: "ada@example.test", totpCode: "456789" },
    ]);

    // Absent and empty are both "no code submitted": the member is omitted
    // rather than sent as "", so the Hub can answer "a code is required" instead
    // of "that code is wrong".
    const bodies: Array<Record<string, unknown>> = [];
    await api.removePassword();
    await api.removePassword({});
    await api.removePassword({ totpCode: "" });
    for (const request of requests.slice(-3)) bodies.push(JSON.parse(String(request.init?.body)));
    expect(bodies).toEqual([{}, {}, {}]);
    for (const body of bodies) expect("totpCode" in body).toBe(false);
  });

  it("sends the step-up code on a recovery-code rotation and on an add-passkey verify", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      if (requests.length === 1) return response(session);
      if (requests.length === 2) {
        return response({ ...session, csrfToken: "csrf-r1", recoveryCodes: ["fresh"] });
      }
      if (requests.length === 3) return response({ options: registrationOptions });
      return response({ ...session, csrfToken: "csrf-r2", passkey: { id: PASSKEY_ID } }, 201);
    });
    const api = createApi({ register: vi.fn(async () => ({ id: "added" }) as never) });
    await api.restoreSession();

    await api.regenerateRecoveryCodes({ totpCode: "123456" });
    await api.addPasskey({ passkeyLabel: "Phone", totpCode: "234567" });

    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ totpCode: "123456" });
    // The step-up rides the verify only. The options body is the Hub's strict
    // `{ label }` shape and an unexpected member would be rejected outright.
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual({ label: "Phone" });
    expect(JSON.parse(String(requests[3]?.init?.body))).toEqual({
      response: { id: "added" },
      totpCode: "234567",
    });
  });

  it("never adds a step-up member to the pre-session registration ceremonies", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return requests.length === 1
        ? response({ options: registrationOptions })
        : response(session, 201);
    });
    const api = createApi({ register: vi.fn(async () => ({ id: "registered" }) as never) });

    await api.bootstrapOwner({ credential: "c", displayName: "Ada", passkeyLabel: null });

    // The Hub's bootstrap verify body is strict `{ response }`.
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({ response: { id: "registered" } });
  });

  it("begins TOTP enrolment and bounds both secret members", async () => {
    const { api, requests, reply } = await authenticated();
    reply({
      secretBase32: "JBSWY3DPEHPK3PXP",
      provisioningUri: "otpauth://totp/Ryco%20Hub:ada?secret=JBSWY3DPEHPK3PXP&issuer=Ryco%20Hub",
      unexpectedSensitiveMetadata: "totp-extra-canary",
    });

    const enrollment = await api.beginTotpEnrollment();

    expect(requests[1]?.input).toBe("/api/account/totp/enrollment/options");
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({});
    expect(enrollment).toEqual({
      secretBase32: "JBSWY3DPEHPK3PXP",
      provisioningUri: "otpauth://totp/Ryco%20Hub:ada?secret=JBSWY3DPEHPK3PXP&issuer=Ryco%20Hub",
    });
    // Only the two contract members are projected.
    expect(JSON.stringify(enrollment)).not.toContain("totp-extra-canary");
  });

  it("rejects a TOTP enrolment whose secret or provisioning URI is not bounded", async () => {
    const { api, reply } = await authenticated();
    const uri = "otpauth://totp/Ryco:ada?secret=JBSWY3DPEHPK3PXP";

    reply({ provisioningUri: uri });
    await expect(api.beginTotpEnrollment()).rejects.toMatchObject({ code: "invalid_response" });
    reply({ secretBase32: "", provisioningUri: uri });
    await expect(api.beginTotpEnrollment()).rejects.toMatchObject({ code: "invalid_response" });
    reply({ secretBase32: "x".repeat(257), provisioningUri: uri });
    await expect(api.beginTotpEnrollment()).rejects.toMatchObject({ code: "invalid_response" });
    reply({ secretBase32: "JBSWY3DPEHPK3PXP", provisioningUri: `otpauth://${"x".repeat(2049)}` });
    await expect(api.beginTotpEnrollment()).rejects.toMatchObject({ code: "invalid_response" });

    // A URI a surface would render as a link or a QR must carry the otpauth
    // scheme. Anything else is a malformed response, not a provisioning URI.
    for (const hostile of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "https://evil.example.test/otpauth://totp/x",
      "",
    ]) {
      reply({ secretBase32: "JBSWY3DPEHPK3PXP", provisioningUri: hostile });
      await expect(api.beginTotpEnrollment()).rejects.toMatchObject({ code: "invalid_response" });
    }
  });

  it("keeps the TOTP secret out of every request, error, and later call", async () => {
    const { api, requests, reply } = await authenticated();
    reply({
      secretBase32: "TOTPSECRETSENSITIVECANARY",
      provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
    });

    const enrollment = await api.beginTotpEnrollment();
    expect(enrollment.secretBase32).toBe("TOTPSECRETSENSITIVECANARY");

    // Confirming enrolment sends the user's 6-digit code, never the secret.
    reply({ ok: true });
    await api.confirmTotpEnrollment({ code: "123456" });
    expect(JSON.stringify(requests)).not.toContain("TOTPSECRETSENSITIVECANARY");

    // A malformed enrolment must not reflect the secret it did receive.
    reply({ secretBase32: "TOTPSECRETSENSITIVECANARY", provisioningUri: "javascript:alert(1)" });
    const error = await api.beginTotpEnrollment().catch((cause) => cause);
    expect(error).toBeInstanceOf(HostedHubApiError);
    expect(JSON.stringify({ message: (error as Error).message, error })).not.toContain(
      "TOTPSECRETSENSITIVECANARY",
    );
  });

  it("fails closed on a passkey id that is not the Hub's credential shape", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      return response(session);
    });
    const api = createApi();
    await api.restoreSession();
    const before = requests.length;

    for (const hostile of [
      "",
      "pkey_short",
      `pkey_${"a".repeat(23)}`,
      "sess_aaaaaaaaaaaaaaaaaaaaaa",
      `${PASSKEY_ID}/../../admin/accounts`,
      `../../admin/sessions/${PASSKEY_ID}/revoke`,
      "pkey_aaaaaaaaaaaaaaaaaaaa%2F",
      `${PASSKEY_ID}?x=1`,
      `${PASSKEY_ID}#x`,
      "https://evil.example.test/api/account/passkeys/pkey_aaaaaaaaaaaaaaaaaaaaaa/revoke",
    ]) {
      // A distinct code: this client refused its own input, so the error must
      // not blame the Hub for a malformed response.
      await expect(api.revokePasskey(hostile)).rejects.toMatchObject({
        code: "invalid_credential_id",
      });
    }

    // Nothing reached the wire: an unvalidated id is never interpolated into a
    // path, not even one the endpoint guard would have rejected afterwards.
    expect(requests).toHaveLength(before);
  });

  it("rejects an acknowledgement that is not exactly { ok: true }", async () => {
    const { api, reply } = await authenticated();

    for (const body of [
      { ok: false },
      { ok: "true" },
      {},
      // A route whose whole contract is an acknowledgement has no business
      // handing over session material, and this client will not take it.
      { ok: true, token: "native-token-unvalidated-canary" },
      { ok: true, csrfToken: "csrf-unvalidated-canary" },
    ]) {
      reply(body);
      await expect(api.revokeTotp()).rejects.toMatchObject({ code: "invalid_response" });
    }

    // The live session is untouched by any of it.
    reply({ ok: true });
    await expect(api.removePassword()).resolves.toBeUndefined();
  });

  it("maps a Hub refusal to a bounded error without reflecting its detail", async () => {
    const { api, reply } = await authenticated();
    reply({ error: "invalid_request", detail: "totp-detail-sensitive-canary" }, 400);

    const error = await api.setPassword({ password: "pw" }).catch((cause) => cause);

    expect(error).toBeInstanceOf(HostedHubApiError);
    expect((error as HostedHubApiError).code).toBe("invalid_request");
    expect((error as Error).message).not.toContain("totp-detail-sensitive-canary");
  });

  it("omits a step-up code that is only whitespace", async () => {
    const { api, requests } = await authenticated();

    // A controlled input the user has focused but not filled yields " " or "\n",
    // not a code. Sending it turns "hasn't typed anything" into a failed attempt.
    for (const blank of ["", " ", "   ", "\n", "\t", " \n\t "]) {
      await api.removePassword({ totpCode: blank });
    }
    for (const request of requests.slice(1)) {
      expect(JSON.parse(String(request.init?.body))).toEqual({});
    }

    // A real code surrounded by whitespace is still a real code, and is sent
    // exactly as given — normalising it is the Hub's business, not this client's.
    await api.removePassword({ totpCode: " 123456 " });
    expect(JSON.parse(String(requests.at(-1)?.init?.body))).toEqual({ totpCode: " 123456 " });
  });

  it("narrows a bare 403 to the one thing it can mean on each route", async () => {
    // The Hub's error body is only `{ error: <code> }` — the reason code is
    // audited server-side and never sent. A raw `forbidden` would surface as
    // "You are not authorized to perform this action.", which tells a user who
    // simply needs to type a TOTP code precisely nothing.
    const { api, reply } = await authenticated();
    reply({ error: "forbidden" }, 403);

    for (const call of [
      () => api.setPassword({ password: "pw" }),
      () => api.removePassword(),
      () => api.revokeTotp(),
      () => api.requestEmailVerification({ email: "ada@example.test" }),
      () => api.regenerateRecoveryCodes(),
    ]) {
      const error = await call().catch((cause) => cause);
      expect(error).toMatchObject({ code: "step_up_required", status: 403 });
      expect((error as Error).message).toBe(
        "Enter a current code from your authenticator app to confirm this change.",
      );
    }

    // TOTP enrolment's 403 is a different thing entirely: it requires a passkey
    // session, and no code the user could type would satisfy it.
    for (const call of [
      () => api.beginTotpEnrollment(),
      () => api.confirmTotpEnrollment({ code: "123456" }),
    ]) {
      const error = await call().catch((cause) => cause);
      expect(error).toMatchObject({ code: "passkey_session_required", status: 403 });
      expect((error as Error).message).toBe(
        "Sign in with a passkey on this device to change two-factor settings.",
      );
    }

    // A 403 with no account intent is left exactly as the Hub sent it.
    reply({ error: "forbidden" }, 403);
    await expect(api.listPasskeys()).rejects.toMatchObject({ code: "forbidden" });
  });

  it("keeps the wire code and marks a narrowed one as inferred", async () => {
    // The narrowing is a client-side guess: the Hub sends `forbidden` and keeps
    // its reason in its audit log. A consumer that renders a TOTP prompt off
    // `step_up_required` needs to know it is acting on an inference — an
    // unrelated 403 (a role check added later, a proxy, a WAF, an operator
    // lockout) reaches this same branch and no code the user types can satisfy
    // it, so the real cause must stay recoverable.
    const { api, reply } = await authenticated();
    reply({ error: "forbidden" }, 403);

    const inferred = await api.revokeTotp().catch((cause) => cause);
    expect(inferred).toBeInstanceOf(HostedHubApiError);
    expect(inferred).toMatchObject({
      code: "step_up_required",
      wireCode: "forbidden",
      inferred: true,
      intent: "revoke-totp",
    });

    // A code that was not narrowed reports itself as received, not inferred.
    reply({ error: "rate_limited" }, 429);
    const untouched = await api.revokeTotp().catch((cause) => cause);
    expect(untouched).toMatchObject({
      code: "rate_limited",
      wireCode: "rate_limited",
      inferred: false,
    });

    // And so does a 403 on a route with nothing to narrow it to.
    reply({ error: "forbidden" }, 403);
    const unnarrowed = await api.listPasskeys().catch((cause) => cause);
    expect(unnarrowed).toMatchObject({
      code: "forbidden",
      wireCode: "forbidden",
      inferred: false,
    });
  });

  it("does not narrow a 403 on a ceremony leg that has no step-up gate", async () => {
    // The add-passkey step-up rides the *verify* call. The options call mints a
    // challenge and has no such gate, so a `forbidden` there cannot be a
    // step-up — calling it one would prompt for a code that route never checks.
    const requests: Array<RequestInfo | URL> = [];
    const register = vi.fn(async () => ({ id: "added" }) as never);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(input);
      if (requests.length === 1) return response(session);
      return response({ error: "forbidden" }, 403);
    });
    const api = createApi({ register });
    await api.restoreSession();

    const optionsLeg = await api.addPasskey({ passkeyLabel: null }).catch((cause) => cause);

    expect(requests.at(-1)).toBe("/api/account/passkeys/registration/options");
    expect(optionsLeg).toMatchObject({
      code: "forbidden",
      wireCode: "forbidden",
      inferred: false,
      // The intent still rides along, so the error still says which operation
      // it belongs to — only the narrowing is suppressed.
      intent: "add-passkey",
    });
    expect(register).not.toHaveBeenCalled();

    // The verify leg, which does have the gate, still narrows.
    const verifyRequests: Array<RequestInfo | URL> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      verifyRequests.push(input);
      if (verifyRequests.length === 1) return response(session);
      if (verifyRequests.length === 2) return response({ options: registrationOptions });
      return response({ error: "forbidden" }, 403);
    });
    const verifyApi = createApi({ register });
    await verifyApi.restoreSession();

    const verifyLeg = await verifyApi.addPasskey({ passkeyLabel: null }).catch((cause) => cause);

    expect(verifyRequests.at(-1)).toBe("/api/account/passkeys/registration/verify");
    expect(verifyLeg).toMatchObject({
      code: "step_up_required",
      wireCode: "forbidden",
      inferred: true,
    });
  });

  it("gives each route-specific 409 an accurate message", async () => {
    const { api, reply } = await authenticated();
    reply({ error: "conflict" }, 409);

    const cases: ReadonlyArray<readonly [() => Promise<unknown>, string]> = [
      [() => api.setPassword({ password: "pw" }), "That password has appeared in a known breach."],
      [() => api.revokePasskey(PASSKEY_ID), "That is the only passkey left on this account."],
      [() => api.beginTotpEnrollment(), "Two-factor authentication is already set up"],
      [() => api.confirmTotpEnrollment({ code: "1" }), "This setup is no longer in progress."],
      [
        () => api.requestEmailVerification({ email: "ada@example.test" }),
        "That email address is already in use.",
      ],
    ];
    for (const [call, fragment] of cases) {
      const error = await call().catch((cause) => cause);
      expect(error).toMatchObject({ code: "conflict", status: 409 });
      // The generic "The request has already been used." is wrong for every one
      // of these and leaves the user with no idea what to do next.
      expect((error as Error).message).toContain(fragment);
      expect((error as Error).message).not.toBe("The request has already been used.");
    }

    // A wrong TOTP code is not a failed passkey.
    reply({ error: "authentication_failed" }, 401);
    const totp = await api.confirmTotpEnrollment({ code: "000000" }).catch((cause) => cause);
    expect((totp as Error).message).toBe(
      "That code is not correct. Check your authenticator app and try again.",
    );
  });

  it("bounds the error code it will adopt from a response body", async () => {
    const { api, reply } = await authenticated();

    for (const hostile of [
      "x".repeat(65),
      "Forbidden",
      "step up required",
      "<script>alert(1)</script>",
      "../../etc/passwd",
      42,
      { nested: true },
    ]) {
      reply({ error: hostile }, 400);
      const error = await api.removePassword().catch((cause) => cause);
      // Unrecognisable codes collapse to the neutral one rather than becoming an
      // unbounded string a surface might switch on or render.
      expect((error as HostedHubApiError).code).toBe("unavailable");
      expect((error as Error).message).toBe("Hub is temporarily unavailable.");
    }

    reply({ error: "rate_limited" }, 429);
    await expect(api.removePassword()).rejects.toMatchObject({ code: "rate_limited" });
  });

  it("projects the widened passkey record and tolerates members it does not know", async () => {
    const { api, reply } = await authenticated();
    reply({
      passkeys: [
        {
          id: PASSKEY_ID,
          label: "Studio laptop",
          createdAt: 10,
          lastUsedAt: 20,
          backupEligible: true,
          backupState: true,
          revokedAt: 30,
          revocationReasonCode: "owner_revoked",
        },
        // A record whose optional members are absent or malformed still lists:
        // one unfamiliar field must not blank a list the user needs to revoke
        // from.
        {
          id: "pkey_bbbbbbbbbbbbbbbbbbbbbb",
          backupEligible: "yes",
          backupState: 1,
          revokedAt: 1.5,
          revocationReasonCode: "x".repeat(257),
        },
      ],
    });

    await expect(api.listPasskeys()).resolves.toEqual([
      {
        id: PASSKEY_ID,
        label: "Studio laptop",
        createdAt: 10,
        lastUsedAt: 20,
        backupEligible: true,
        backupState: true,
        revokedAt: 30,
        revocationReasonCode: "owner_revoked",
      },
      {
        id: "pkey_bbbbbbbbbbbbbbbbbbbbbb",
        label: null,
        createdAt: null,
        lastUsedAt: null,
        backupEligible: null,
        backupState: null,
        revokedAt: null,
        revocationReasonCode: null,
      },
    ]);
  });
});

/** In-memory bearer credentials mirroring a native (DPoP) adapter. */
function inMemoryBearerCredentials(): SessionCredentialsService & {
  readonly current: () => string | null;
} {
  let bearerToken: string | null = null;
  return {
    mode: "bearer",
    readCsrfToken: () => null,
    writeCsrfToken: () => undefined,
    readBearerToken: () => bearerToken,
    writeBearerToken: (token) => {
      bearerToken = token;
    },
    current: () => bearerToken,
  };
}

/** A DPoP signer that records its inputs and returns a deterministic proof. */
function recordingDpopSigner(): {
  readonly calls: DpopProofInput[];
  readonly service: DpopSignerService;
} {
  const calls: DpopProofInput[] = [];
  return {
    calls,
    service: {
      sign: async (input) => {
        calls.push(input);
        return `proof:${input.method}:${input.url}:${input.token ? "ath" : "no-ath"}`;
      },
    },
  };
}

function createBearerApi(
  service: DpopSignerService,
  credentials: SessionCredentialsService,
  passkeyCeremony?: Partial<PasskeyCeremonyService>,
): HostedHubApi {
  return new HostedHubApi({
    endpoint: fakeEndpoint,
    httpClient: fakeHttpClient,
    sessionCredentials: credentials,
    dpopSigner: service,
    passkeyCeremony: {
      authenticate: vi.fn(async () => ({ id: "authenticate-not-used" }) as never),
      register: vi.fn(async () => ({ id: "register-not-used" }) as never),
      ...passkeyCeremony,
    },
  });
}

const accountAndSession = {
  account: session.account,
  session: session.session,
} as const;

const nativeE2eeOpaque = "A".repeat(43);
const nativeE2eeEnrollmentId = `enr_${"e".repeat(22)}`;
const nativeE2eeNow = 1_788_451_200_000;
const nativeE2eeEnrollment = {
  enrollmentId: nativeE2eeEnrollmentId,
  enrollmentRevision: 1,
  accountAuthEpoch: 3,
  deviceAuthEpoch: 2,
  platform: "ios",
  appVersion: "0.1.20",
  reportedKeyBacking: "secure-enclave",
  deviceLabel: "Ada’s iPhone",
  identityFingerprint: nativeE2eeOpaque,
  agreementFingerprint: nativeE2eeOpaque,
  clientPrekeyCertificateDigest: nativeE2eeOpaque,
  certificateExpiresAt: nativeE2eeNow + 86_400_000,
  status: "active",
  createdAt: nativeE2eeNow,
  updatedAt: nativeE2eeNow,
  lastUsedAt: null,
  revokedAt: null,
} as const;

const nativeE2eeEnrollmentRequest = {
  protocolVersion: 1,
  hubOrigin: "https://hub.example.test",
  accountId: session.account.id,
  enrollmentId: nativeE2eeEnrollmentId,
  identityPublicKey: "B".repeat(87),
  identityFingerprint: nativeE2eeOpaque,
  agreementPublicKey: nativeE2eeOpaque,
  agreementFingerprint: nativeE2eeOpaque,
  clientPrekeyCertificate: "C".repeat(120),
  clientPrekeyCertificateDigest: nativeE2eeOpaque,
  certificateExpiresAt: nativeE2eeEnrollment.certificateExpiresAt,
  platform: "ios",
  appVersion: "0.1.20",
  reportedKeyBacking: "secure-enclave",
  deviceLabel: "Ada’s iPhone",
  requestedMaximumRole: "operator",
  requestedCapabilities: ["ryco.rpc"],
  enrollmentNonce: nativeE2eeOpaque,
  idempotencyKey: nativeE2eeOpaque,
} as const;

const nativeE2eeTicketRequest = {
  protocolVersion: 1,
  nodeId: "node_aaaaaaaaaaaaaaaaaaaaaa",
  capability: "ryco.rpc",
  protocolMajor: 1,
  protocolMinor: 3,
  suiteId: 2,
  enrollmentId: nativeE2eeEnrollmentId,
  enrollmentRevision: 1,
  clientPrekeyCertificateDigest: nativeE2eeOpaque,
} as const;

const nativeE2eeTicket = {
  protocolVersion: 1,
  ticket: nativeE2eeOpaque,
  ticketId: `rtk_${"t".repeat(22)}`,
  expiresAt: nativeE2eeNow + 60_000,
  protocolMajor: 1,
  protocolMinor: 3,
  suiteId: 2,
  deviceGrant: "G".repeat(200),
  deviceGrantDigest: nativeE2eeOpaque,
  nodeCapabilityStatement: "S".repeat(200),
  nodeCapabilityStatementDigest: nativeE2eeOpaque,
  keysetGeneration: 7,
  capability: "ryco.rpc",
  effectiveRole: "operator",
} as const;

describe("HostedHubApi bearer (native/DPoP) transport", () => {
  it("uses authenticated DPoP for strict enrollment, keyset, and account-grant tickets", async () => {
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      if (pathname === "/api/native/e2ee/devices/current") {
        return response({ protocolVersion: 1, enrollment: nativeE2eeEnrollment });
      }
      if (pathname === "/api/native/e2ee/grant-keys") {
        return response({
          protocolVersion: 1,
          generation: 7,
          keys: [
            {
              keyId: `hgk_${"k".repeat(22)}`,
              publicKey: nativeE2eeOpaque,
              notBefore: nativeE2eeNow - 1_000,
              notAfter: nativeE2eeNow + 120_000,
            },
          ],
        });
      }
      return response(nativeE2eeTicket, 201);
    });
    const api = createBearerApi(service, credentials);

    await expect(api.upsertE2eeDeviceEnrollment(nativeE2eeEnrollmentRequest)).resolves.toEqual(
      nativeE2eeEnrollment,
    );
    await expect(api.getE2eeGrantVerificationKeys()).resolves.toMatchObject({ generation: 7 });
    await expect(api.issueAccountGrantRelayTicket(nativeE2eeTicketRequest)).resolves.toEqual(
      nativeE2eeTicket,
    );

    expect(requests.map((request) => new URL(request.input).pathname)).toEqual([
      "/api/native/e2ee/devices/current",
      "/api/native/e2ee/grant-keys",
      "/api/native/relay/tickets/account-grant",
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual(nativeE2eeEnrollmentRequest);
    expect(JSON.parse(String(requests[2]?.init?.body))).toEqual(nativeE2eeTicketRequest);
    for (const request of requests) {
      const headers = headersOf(request.init);
      expect(headers.get("Authorization")).toBe("DPoP native-token-canary");
      expect(headers.get("DPoP")).toMatch(/:ath$/);
      expect(headers.get("X-Ryco-CSRF")).toBeNull();
      expect(request.init?.credentials).toBe("omit");
    }
    expect(calls).toHaveLength(3);
  });

  it("rejects native E2EE routes from cookie sessions before I/O", async () => {
    const fetchSpy = vi.fn(async () => response({}));
    globalThis.fetch = fetchSpy;
    const api = createApi();

    await expect(api.upsertE2eeDeviceEnrollment(nativeE2eeEnrollmentRequest)).rejects.toMatchObject(
      {
        code: "native_only_transport",
      },
    );
    await expect(api.getE2eeGrantVerificationKeys()).rejects.toMatchObject({
      code: "native_only_transport",
    });
    await expect(api.issueAccountGrantRelayTicket(nativeE2eeTicketRequest)).rejects.toMatchObject({
      code: "native_only_transport",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("strictly rejects mixed or malformed native ticket and keyset responses", async () => {
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const api = createBearerApi(service, credentials);

    globalThis.fetch = vi.fn(async () => response({ ...nativeE2eeTicket, protocolMinor: 2 }));
    await expect(api.issueAccountGrantRelayTicket(nativeE2eeTicketRequest)).rejects.toMatchObject({
      code: "invalid_response",
    });
    globalThis.fetch = vi.fn(async () => response({ ...nativeE2eeTicket, browserTicket: true }));
    await expect(api.issueAccountGrantRelayTicket(nativeE2eeTicketRequest)).rejects.toMatchObject({
      code: "invalid_response",
    });
    globalThis.fetch = vi.fn(async () =>
      response({
        protocolVersion: 1,
        generation: 7,
        keys: [
          {
            keyId: `hgk_${"k".repeat(22)}`,
            publicKey: nativeE2eeOpaque,
            notBefore: nativeE2eeNow,
            notAfter: nativeE2eeNow + 10,
          },
          {
            keyId: `hgk_${"k".repeat(22)}`,
            publicKey: nativeE2eeOpaque,
            notBefore: nativeE2eeNow,
            notAfter: nativeE2eeNow + 10,
          },
        ],
      }),
    );
    await expect(api.getE2eeGrantVerificationKeys()).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("fails closed when bearer credentials lack a DPoP signer or token holder", () => {
    const { service } = recordingDpopSigner();
    // Missing signer.
    const missingSigner = (() => {
      try {
        return new HostedHubApi({
          endpoint: fakeEndpoint,
          httpClient: fakeHttpClient,
          sessionCredentials: inMemoryBearerCredentials(),
          passkeyCeremony: { authenticate: vi.fn(), register: vi.fn() },
        });
      } catch (error) {
        return error;
      }
    })();
    expect(missingSigner).toMatchObject({
      reason: "missing-signer",
      message:
        "Secure session signing is unavailable on this device. Restart the app, then try again.",
    });
    // Missing bearer-token holder (only the cookie CSRF slots present).
    const missingTokenHolder = (() => {
      try {
        return new HostedHubApi({
          endpoint: fakeEndpoint,
          httpClient: fakeHttpClient,
          sessionCredentials: {
            mode: "bearer",
            readCsrfToken: () => null,
            writeCsrfToken: () => undefined,
          },
          dpopSigner: service,
          passkeyCeremony: { authenticate: vi.fn(), register: vi.fn() },
        });
      } catch (error) {
        return error;
      }
    })();
    expect(missingTokenHolder).toMatchObject({
      reason: "missing-token",
      message: "This device no longer has its secure Hub session. Sign in again to continue.",
    });
  });

  it("routes login through native passkey endpoints with a mint proof and no CSRF", async () => {
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return requests.length === 1
        ? response({ options: { challenge: encodeBase64Url(new Uint8Array([1, 2, 3])) } })
        : response({ ...accountAndSession, token: "native-token-canary" });
    });
    const authenticate = vi.fn(async () => ({ id: "assertion-canary" }) as never);
    const api = createBearerApi(service, credentials, { authenticate });

    const result = await api.signIn();

    // Native endpoints, presented as absolute Hub URLs.
    expect(requests.map((request) => request.input)).toEqual([
      "https://hub.example.test/api/auth/native/passkey/options",
      "https://hub.example.test/api/auth/native/passkey/verify",
    ]);
    for (const request of requests) {
      const headers = request.init?.headers as Headers;
      expect(headers.get("DPoP")).toMatch(/^proof:POST:/);
      // Mint ceremony: no bearer token presented, no cookie/CSRF.
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("X-Ryco-CSRF")).toBeNull();
      expect(request.init?.credentials).toBe("omit");
    }
    // The signer was invoked without a token on both ceremony calls (no ath).
    expect(calls.every((call) => call.token === undefined)).toBe(true);
    // The native token is persisted but never surfaced in the returned view.
    expect(credentials.current()).toBe("native-token-canary");
    expect(api.hasSessionMaterial).toBe(true);
    expect(JSON.stringify(result)).not.toContain("native-token-canary");
    expect(result).toMatchObject({ account: session.account, session: session.session });
    expect("csrfToken" in result).toBe(false);
  });

  it("offers an explicit native passkey login that never opens the browser handoff", async () => {
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    const openSystemBrowser = vi.fn<NativeAuthorizationService["openSystemBrowser"]>();
    const authenticate = vi.fn(async () => ({ id: "assertion-canary" }) as never);
    const requests: string[] = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return requests.length === 1
        ? response({ options: { challenge: encodeBase64Url(new Uint8Array([1, 2, 3])) } })
        : response({ ...accountAndSession, token: "native-token-canary" });
    });
    const api = new HostedHubApi({
      endpoint: fakeEndpoint,
      httpClient: fakeHttpClient,
      sessionCredentials: credentials,
      dpopSigner: service,
      passkeyCeremony: { authenticate, register: vi.fn() },
      nativeAuthorization: {
        callbackUri: () => "ryco://hosted/complete",
        deviceLabel: () => "Ryco mobile",
        randomBytes: async (length) => new Uint8Array(length),
        sha256: async () => new Uint8Array(32),
        openSystemBrowser,
      },
    });

    await expect(api.signInWithNativePasskey()).resolves.toEqual({
      session: expect.objectContaining(accountAndSession),
      token: "native-token-canary",
    });
    expect(requests).toEqual([
      "https://hub.example.test/api/auth/native/passkey/options",
      "https://hub.example.test/api/auth/native/passkey/verify",
    ]);
    expect(openSystemBrowser).not.toHaveBeenCalled();
    expect(credentials.current()).toBeNull();
    expect(api.hasSessionMaterial).toBe(false);
  });

  it("attaches Authorization DPoP + an ath proof on authenticated requests, no CSRF", async () => {
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return response(
        {
          ticket: "ticket-sensitive-canary",
          expiresAt: Date.now() + 60_000,
          protocolMajor: 1,
          protocolMinor: 2,
        },
        201,
      );
    });
    const api = createBearerApi(service, credentials);

    const issued = await api.issueRelayTicket("node_aaaaaaaaaaaaaaaaaaaaaa");

    expect(issued.ticket).toBe("ticket-sensitive-canary");
    expect(requests[0]?.input).toBe("https://hub.example.test/api/relay/tickets");
    const headers = requests[0]?.init?.headers as Headers;
    expect(headers.get("Authorization")).toBe("DPoP native-token-canary");
    expect(headers.get("DPoP")).toBe("proof:POST:https://hub.example.test/api/relay/tickets:ath");
    // Bearer mode drops CSRF and never sends an ambient cookie.
    expect(headers.get("X-Ryco-CSRF")).toBeNull();
    expect(requests[0]?.init?.credentials).toBe("omit");
    // The signer bound the presented token (ath branch) to this request.
    expect(calls[0]).toEqual({
      method: "POST",
      url: "https://hub.example.test/api/relay/tickets",
      token: "native-token-canary",
    });
    // The directory refresh (a GET) works under bearer mode with no CSRF.
    globalThis.fetch = vi.fn(async () => response({ nodes: [] }));
    await expect(api.listNodes()).resolves.toEqual([]);
  });

  it("renames a node over DPoP without cookies or CSRF", async () => {
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return response({ ok: true });
    });
    const api = createBearerApi(service, credentials);

    await api.renameNode("node_aaaaaaaaaaaaaaaaaaaaaa", "Studio");

    const url = "https://hub.example.test/api/admin/nodes/node_aaaaaaaaaaaaaaaaaaaaaa/rename";
    expect(requests[0]?.input).toBe(url);
    expect(requests[0]?.init).toMatchObject({ method: "POST", credentials: "omit" });
    expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({ label: "Studio" });
    const headers = headersOf(requests[0]?.init);
    expect(headers.get("Authorization")).toBe("DPoP native-token-canary");
    expect(headers.get("DPoP")).toBe(`proof:POST:${url}:ath`);
    expect(headers.get("X-Ryco-CSRF")).toBeNull();
    expect(calls[0]).toEqual({ method: "POST", url, token: "native-token-canary" });
  });

  it("fails closed on an authenticated bearer request with no persisted token", async () => {
    const { service } = recordingDpopSigner();
    const api = createBearerApi(service, inMemoryBearerCredentials());
    const fetchSpy = vi.fn(async () => response({ nodes: [] }));
    globalThis.fetch = fetchSpy;
    await expect(api.listNodes()).rejects.toMatchObject({
      code: "session_invalid",
      reason: "missing-token",
      message: "This device no longer has its secure Hub session. Sign in again to continue.",
    });
    // The request must never reach the wire without a bound token.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports proof signing failures without exposing signer detail or making a request", async () => {
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const signerDetail = "sensitive-keystore-provider-detail";
    const api = createBearerApi(
      {
        sign: async () => {
          throw new Error(signerDetail);
        },
      },
      credentials,
    );
    const fetchSpy = vi.fn(async () => response({ nodes: [] }));
    globalThis.fetch = fetchSpy;

    const error = await api.listNodes().catch((cause) => cause);

    expect(error).toMatchObject({
      reason: "proof-signing-failed",
      message:
        "This device could not verify its secure Hub session. Unlock the device and try again; if it continues, sign in again.",
    });
    expect((error as Error).message).not.toContain(signerDetail);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("classifies an explicit authenticated-session invalidation without reflecting response detail", async () => {
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const api = createBearerApi(service, credentials);
    globalThis.fetch = vi.fn(async () =>
      response({ error: "session_invalid", details: "sensitive-native-session-detail" }, 401),
    );

    const error = await api.listNodes().catch((cause) => cause);

    expect(error).toMatchObject({
      code: "session_invalid",
      reason: "token-invalidated",
      message: "Your secure Hub session is no longer valid. Sign in again to continue.",
    });
    expect((error as Error).message).not.toContain("sensitive-native-session-detail");
  });

  it("fails closed before any I/O on browser-only routes in bearer mode", async () => {
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const fetchSpy = vi.fn(async () => response({}));
    globalThis.fetch = fetchSpy;
    const register = vi.fn(async () => ({ id: "never-registered" }) as never);
    const api = createBearerApi(service, credentials, { register });

    await expect(
      api.bootstrapOwner({
        credential: "bootstrap-sensitive-canary",
        displayName: "Ada",
        passkeyLabel: null,
      }),
    ).rejects.toMatchObject({
      code: "browser_only_transport",
      message: "This action is only available in a browser.",
    });
    await expect(
      api.redeemInvitation({
        secret: "invitation-sensitive-canary",
        displayName: "Ada",
        passkeyLabel: null,
      }),
    ).rejects.toMatchObject({ code: "browser_only_transport" });

    // Nothing reached the wire, no proof was minted, and the user was never
    // prompted for a passkey they could not have used.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(register).not.toHaveBeenCalled();
    // The refusal is inert: it consumed no session material.
    expect(credentials.current()).toBe("native-token-canary");

    // The guard is scoped — native passkey *login* is still issued. Asserted by
    // driving it, not inferred from the token being untouched.
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return call === 1
        ? response({ options: { challenge: encodeBase64Url(new Uint8Array([1, 2, 3])) } })
        : response({ ...accountAndSession, token: "native-token-relogin-canary" });
    });
    await expect(api.signIn()).resolves.toMatchObject({ account: session.account });
    expect(credentials.current()).toBe("native-token-relogin-canary");
  });

  it("adds a passkey over DPoP without minting or clearing the native session", async () => {
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return requests.length === 1
        ? response({ options: registrationOptions })
        : // The verify ROTATES the native session: a replacement token, and the
          // presented one revoked.
          response(
            {
              ...accountAndSession,
              token: "native-token-rotated-canary",
              passkey: { id: PASSKEY_ID, label: "Phone", createdAt: 5 },
            },
            201,
          );
    });
    const register = vi.fn(async () => ({ id: "added-passkey-canary" }) as never);
    const api = createBearerApi(service, credentials, { register });

    const added = await api.addPasskey({ passkeyLabel: "Phone" });

    expect(requests.map((request) => request.input)).toEqual([
      "https://hub.example.test/api/account/passkeys/registration/options",
      "https://hub.example.test/api/account/passkeys/registration/verify",
    ]);
    for (const request of requests) {
      const headers = request.init?.headers as Headers;
      // Session-bound, not a mint: token presented, proof carries `ath`.
      expect(headers.get("Authorization")).toBe("DPoP native-token-canary");
      expect(headers.get("DPoP")).toMatch(/:ath$/);
      expect(headers.get("X-Ryco-CSRF")).toBeNull();
      expect(request.init?.credentials).toBe("omit");
    }
    expect(calls.every((call) => call.token === "native-token-canary")).toBe(true);
    expect(added).toEqual({
      passkey: {
        id: PASSKEY_ID,
        label: "Phone",
        createdAt: 5,
        lastUsedAt: null,
        backupEligible: null,
        backupState: null,
        revokedAt: null,
        revocationReasonCode: null,
      },
      confirmed: true,
    });
    // The REPLACEMENT token is now the enclave-bound one. Keeping the presented
    // token would leave the enclave holding a revoked credential, and the very
    // next call — the controller's own confirming read — would 401 and sign the
    // user out for adding a device.
    expect(credentials.current()).toBe("native-token-rotated-canary");
    expect(api.hasSessionMaterial).toBe(true);
    // Neither token is ever surfaced in the returned view.
    expect(JSON.stringify(added)).not.toContain("native-token-canary");
    expect(JSON.stringify(added)).not.toContain("native-token-rotated-canary");
  });

  it("never adopts an unvalidated native token from an add-passkey verify", async () => {
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return call === 1
        ? response({ options: registrationOptions })
        : // A 2xx body carrying a bare token and no account/session. The route
          // does rotate, so a *validated* replacement would be adopted — but a
          // length bound is not validation, and adopting an unverified value
          // would replace working material with a wrong one.
          response({ token: "native-token-unvalidated-canary" }, 201);
    });
    const api = createBearerApi(service, credentials, {
      register: vi.fn(async () => ({ id: "added" }) as never),
    });

    await expect(api.addPasskey({ passkeyLabel: null })).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(credentials.current()).toBe("native-token-canary");

    // The live session still works: the next authenticated call presents the
    // original token, not the one the verify tried to hand over.
    globalThis.fetch = vi.fn(async () => response({ passkeys: [] }));
    await expect(api.listPasskeys()).resolves.toEqual([]);
  });

  it("does not rotate an existing bearer session from a malformed account scope", async () => {
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    let call = 0;
    globalThis.fetch = vi.fn(async () => {
      call += 1;
      return call === 1
        ? response({ options: registrationOptions })
        : response(
            {
              ...accountAndSession,
              account: { ...accountAndSession.account, id: "" },
              session: { ...accountAndSession.session, accountId: "" },
              token: "native-token-malformed-scope-canary",
              passkey: { id: PASSKEY_ID, label: "Phone" },
            },
            201,
          );
    });
    const api = createBearerApi(service, credentials, {
      register: vi.fn(async () => ({ id: "added" }) as never),
    });

    await expect(api.addPasskey({ passkeyLabel: "Phone" })).rejects.toMatchObject({
      code: "invalid_response",
    });
    expect(credentials.current()).toBe("native-token-canary");
    expect(api.hasSessionMaterial).toBe(true);

    globalThis.fetch = vi.fn(async () => response({ passkeys: [] }));
    await expect(api.listPasskeys()).resolves.toEqual([]);
  });

  it("reads account state and fetches recovery codes over DPoP with no CSRF", async () => {
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      if (requests.length === 1) return response({ passkeys: [{ id: "credential-aaa" }] });
      if (requests.length === 2) {
        return response({
          passwordConfigured: false,
          totpEnrolled: true,
          emailDeliveryConfigured: true,
          email: null,
          externalIdentities: [],
        });
      }
      return response({
        ...accountAndSession,
        token: "native-token-rotated-canary",
        recoveryCodes: ["recovery-sensitive-canary"],
      });
    });
    const api = createBearerApi(service, credentials);

    await expect(api.listPasskeys()).resolves.toEqual([
      {
        id: "credential-aaa",
        label: null,
        createdAt: null,
        lastUsedAt: null,
        backupEligible: null,
        backupState: null,
        revokedAt: null,
        revocationReasonCode: null,
      },
    ]);
    await expect(api.getAccountSecurity()).resolves.toEqual({
      passwordConfigured: false,
      totpEnrolled: true,
      emailDeliveryConfigured: true,
      email: null,
      externalIdentities: [],
    });
    await expect(api.regenerateRecoveryCodes()).resolves.toEqual(["recovery-sensitive-canary"]);

    expect(requests.map((request) => request.input)).toEqual([
      "https://hub.example.test/api/account/passkeys",
      "https://hub.example.test/api/account/security",
      "https://hub.example.test/api/account/recovery-codes",
    ]);
    expect(requests.map((request) => request.init?.method)).toEqual(["GET", "GET", "POST"]);
    for (const request of requests) {
      const headers = request.init?.headers as Headers;
      expect(headers.get("Authorization")).toBe("DPoP native-token-canary");
      expect(headers.get("DPoP")).toMatch(/:ath$/);
      expect(headers.get("X-Ryco-CSRF")).toBeNull();
      expect(request.init?.credentials).toBe("omit");
    }
    // No recovery code and no session token is ever echoed onto the wire.
    expect(JSON.stringify(requests)).not.toContain("recovery-sensitive-canary");
    // The rotation replaced the enclave-bound token.
    expect(credentials.current()).toBe("native-token-rotated-canary");
  });

  it("fails closed on account requests with no persisted native token", async () => {
    const { service } = recordingDpopSigner();
    const api = createBearerApi(service, inMemoryBearerCredentials());
    const fetchSpy = vi.fn(async () => response({ passkeys: [] }));
    globalThis.fetch = fetchSpy;
    await expect(api.listPasskeys()).rejects.toMatchObject({ code: "session_invalid" });
    await expect(api.regenerateRecoveryCodes()).rejects.toMatchObject({
      code: "session_invalid",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("runs every account credential mutation natively over DPoP, never as browser-only", async () => {
    // The correction that motivates this surface: the Hub takes the DPoP branch
    // on the presence of an `Authorization` header and applies no same-origin
    // check there, so `/api/account/*` mutations are fully native. Only the
    // fallback *login* routes under `/api/auth/*` are browser-transport-only,
    // and those are what the fail-closed guard covers. If any of these were
    // added to that list, this case fails with `browser_only_transport`.
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return String(input).endsWith("/totp/enrollment/options")
        ? response({
            secretBase32: "TOTPSECRETSENSITIVECANARY",
            provisioningUri: "otpauth://totp/Ryco:ada?secret=TOTPSECRETSENSITIVECANARY",
          })
        : response({ ok: true });
    });
    const api = createBearerApi(service, credentials);

    await api.setPassword({ password: "password-sensitive-canary", totpCode: "123456" });
    await api.removePassword();
    await expect(api.beginTotpEnrollment()).resolves.toMatchObject({
      secretBase32: "TOTPSECRETSENSITIVECANARY",
    });
    await api.confirmTotpEnrollment({ code: "123456" });
    await api.revokeTotp();
    await api.requestEmailVerification({ email: "ada@example.test" });
    await api.revokePasskey(PASSKEY_ID);

    expect(requests.map((request) => request.input)).toEqual([
      "https://hub.example.test/api/account/password",
      "https://hub.example.test/api/account/password/remove",
      "https://hub.example.test/api/account/totp/enrollment/options",
      "https://hub.example.test/api/account/totp/enrollment/verify",
      "https://hub.example.test/api/account/totp/revoke",
      "https://hub.example.test/api/account/email/verification",
      `https://hub.example.test/api/account/passkeys/${PASSKEY_ID}/revoke`,
    ]);
    for (const request of requests) {
      const headers = request.init?.headers as Headers;
      // Bearer: `Authorization: DPoP` + an `ath`-bound single-use proof, no
      // CSRF header, and never an ambient cookie.
      expect(headers.get("Authorization")).toBe("DPoP native-token-canary");
      expect(headers.get("DPoP")).toMatch(/:ath$/);
      expect(headers.get("X-Ryco-CSRF")).toBeNull();
      expect(request.init).toMatchObject({ method: "POST", credentials: "omit" });
    }
    // Every proof was bound to the presented token, and each to its own URL —
    // the per-request `ath`/`htu` binding the Hub verifies as single-use.
    expect(calls.every((call) => call.token === "native-token-canary")).toBe(true);
    expect(new Set(calls.map((call) => call.url)).size).toBe(requests.length);
    // The enclave-bound token survives the whole sequence and is never echoed.
    expect(credentials.current()).toBe("native-token-canary");
    expect(JSON.stringify(requests)).not.toContain("TOTPSECRETSENSITIVECANARY");
  });

  it("fails closed on a malformed passkey id before minting a proof", async () => {
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const fetchSpy = vi.fn(async () => response({ ok: true }));
    globalThis.fetch = fetchSpy;
    const api = createBearerApi(service, credentials);

    await expect(api.revokePasskey("pkey_not-a-valid-id")).rejects.toMatchObject({
      code: "invalid_credential_id",
    });

    // No request, and no single-use proof burned on a call that could not go.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(credentials.current()).toBe("native-token-canary");
  });

  it("rejects an encoded credential id at the only path it could enter through", async () => {
    // `#request` also refuses any percent-encoded pathname, but that check is
    // now a SECOND layer with no reachable caller: every other path this client
    // issues is a literal, and the one path built from an argument is guarded
    // here first. So the encoding defence is asserted where it actually runs.
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const fetchSpy = vi.fn(async () => response({ ok: true }));
    globalThis.fetch = fetchSpy;
    const api = createBearerApi(service, credentials);

    for (const encoded of [
      "pkey_aaaaaaaaaaaaaaaaaaa%2F",
      `${PASSKEY_ID}%2f..`,
      "pkey_%2e%2e%2f%2e%2e%2fadmin",
      `${PASSKEY_ID}%00`,
    ]) {
      await expect(api.revokePasskey(encoded)).rejects.toMatchObject({
        code: "invalid_credential_id",
      });
    }

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("fails closed when the endpoint seam does not agree with itself", async () => {
    // The origin is read from an injected adapter, so it is not a constant this
    // client controls. A URL that does not resolve back to the same origin is
    // refused before any I/O rather than dispatched somewhere unintended.
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const fetchSpy = vi.fn(async () => response({ passkeys: [] }));
    globalThis.fetch = fetchSpy;
    let call = 0;
    const api = new HostedHubApi({
      endpoint: {
        ...fakeEndpoint,
        origin: () => {
          call += 1;
          return call === 1 ? "https://hub.example.test" : "https://evil.example.test";
        },
      },
      httpClient: fakeHttpClient,
      sessionCredentials: credentials,
      dpopSigner: service,
      passkeyCeremony: { authenticate: vi.fn(), register: vi.fn() },
    });

    await expect(api.listPasskeys()).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("fails closed on account credential mutations with no persisted native token", async () => {
    const { service } = recordingDpopSigner();
    const api = createBearerApi(service, inMemoryBearerCredentials());
    const fetchSpy = vi.fn(async () => response({ ok: true }));
    globalThis.fetch = fetchSpy;

    await expect(api.setPassword({ password: "pw" })).rejects.toMatchObject({
      code: "session_invalid",
    });
    await expect(api.removePassword()).rejects.toMatchObject({ code: "session_invalid" });
    await expect(api.beginTotpEnrollment()).rejects.toMatchObject({ code: "session_invalid" });
    await expect(api.confirmTotpEnrollment({ code: "1" })).rejects.toMatchObject({
      code: "session_invalid",
    });
    await expect(api.revokeTotp()).rejects.toMatchObject({ code: "session_invalid" });
    await expect(api.requestEmailVerification({ email: "a@b.test" })).rejects.toMatchObject({
      code: "session_invalid",
    });
    await expect(api.revokePasskey(PASSKEY_ID)).rejects.toMatchObject({ code: "session_invalid" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("clears the native token as its session material", () => {
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-canary");
    const api = createBearerApi(service, credentials);
    expect(api.hasSessionMaterial).toBe(true);
    api.clearSessionMaterial();
    expect(credentials.current()).toBeNull();
    expect(api.hasSessionMaterial).toBe(false);
  });
});

describe("HostedHubApi native system-browser handoff", () => {
  const state = "A".repeat(43);
  const verifier = encodeBase64Url(new Uint8Array(32).fill(4));
  const challenge = encodeBase64Url(new Uint8Array(32).fill(8));
  const code = "D".repeat(43);
  const handoffId = "E".repeat(43);
  const token = "F".repeat(43);
  const now = 1_752_710_400_000;

  function nativeAuthorization(): NativeAuthorizationService {
    let randomCall = 0;
    return {
      callbackUri: () => "ryco-dev://hosted/complete",
      deviceLabel: () => "Laurin’s iPhone",
      randomBytes: vi.fn(async () => {
        randomCall += 1;
        return new Uint8Array(32).fill(randomCall === 1 ? 0 : 4);
      }),
      sha256: vi.fn(async () => new Uint8Array(32).fill(8)),
      openSystemBrowser: vi.fn(async () => ({
        type: "success",
        url: `ryco-dev://hosted/complete?code=${code}&state=${state}&handoff_id=${handoffId}`,
      })),
    };
  }

  it("uses the browser handoff for bearer sign-in and adopts only the validated native token", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { calls, service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    const authorization = nativeAuthorization();
    const authenticate = vi.fn();
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      if (requests.length === 1) {
        expect(JSON.parse(String(init?.body))).toEqual({
          redirectUri: "ryco-dev://hosted/complete",
          codeChallenge: challenge,
          codeChallengeMethod: "S256",
          state,
          deviceLabel: "Laurin’s iPhone",
        });
        return response({
          handoffId,
          authorizationUrl: `https://hub.example.test/native/authorize/${handoffId}`,
          expiresAt: now + 60_000,
        });
      }
      expect(JSON.parse(String(init?.body))).toEqual({ handoffId, code, codeVerifier: verifier });
      return response({
        account: session.account,
        session: {
          ...session.session,
          familyId: "sfam_aaaaaaaaaaaaaaaaaaaaaa",
          clientLabel: "Laurin’s iPhone",
          kind: "native",
          replacedBySessionId: null,
        },
        token,
      });
    });
    const api = new HostedHubApi({
      endpoint: fakeEndpoint,
      httpClient: fakeHttpClient,
      sessionCredentials: credentials,
      dpopSigner: service,
      nativeAuthorization: authorization,
      passkeyCeremony: { authenticate, register: vi.fn() },
    });

    const result = await api.signIn();

    expect(requests.map((request) => request.input)).toEqual([
      "https://hub.example.test/api/auth/native/handoff/start",
      "https://hub.example.test/api/auth/native/handoff/redeem",
    ]);
    for (const request of requests) {
      const headers = headersOf(request.init);
      expect(headers.get("DPoP")).toBeTruthy();
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("Cookie")).toBeNull();
      expect(request.init?.credentials).toBe("omit");
    }
    expect(calls.every((call) => call.token === undefined)).toBe(true);
    expect(authorization.openSystemBrowser).toHaveBeenCalledWith(
      `https://hub.example.test/native/authorize/${handoffId}`,
      "ryco-dev://hosted/complete",
      expect.any(AbortSignal),
    );
    expect(authenticate).not.toHaveBeenCalled();
    expect(credentials.current()).toBe(token);
    expect(JSON.stringify(result)).not.toContain(token);
    expect(result).toMatchObject({ account: session.account, session: session.session });
  });

  it("uses typed GitHub handoffs and retries native link step-up without reopening GitHub", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    let randomCall = 0;
    const authorization: NativeAuthorizationService = {
      callbackUri: () => "ryco-dev://hosted/complete",
      deviceLabel: () => "Laurin’s iPhone",
      randomBytes: vi.fn(async () => {
        randomCall += 1;
        return new Uint8Array(32).fill(randomCall % 2 === 1 ? 0 : 4);
      }),
      sha256: vi.fn(async () => new Uint8Array(32).fill(8)),
      openSystemBrowser: vi.fn(async () => ({
        type: "success",
        url: `ryco-dev://hosted/complete?code=${code}&state=${state}&handoff_id=${handoffId}`,
      })),
    };
    const externalIdentity = {
      provider: "github",
      login: "octocat",
      displayName: "The Octocat",
      connectedAt: now,
      lastUsedAt: null,
    } as const;
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      if (requests.length === 1 || requests.length === 3) {
        return response({
          handoffId,
          authorizationUrl: `https://hub.example.test/native/authorize/${handoffId}`,
          expiresAt: now + 60_000,
        });
      }
      if (requests.length === 2) {
        return response({
          account: session.account,
          session: {
            ...session.session,
            familyId: "sfam_aaaaaaaaaaaaaaaaaaaaaa",
            clientLabel: "Laurin’s iPhone",
            kind: "native",
            replacedBySessionId: null,
          },
          token,
        });
      }
      if (requests.length === 4) return response({ error: "step_up_required" }, 403);
      return response({
        status: "connected",
        purpose: { kind: "connect_external_identity", provider: "github" },
        externalIdentity,
      });
    });
    const api = new HostedHubApi({
      endpoint: fakeEndpoint,
      httpClient: fakeHttpClient,
      sessionCredentials: credentials,
      dpopSigner: service,
      nativeAuthorization: authorization,
      passkeyCeremony: { authenticate: vi.fn(), register: vi.fn() },
    });

    await expect(api.signInWithExternalProvider("github")).resolves.toMatchObject({
      account: session.account,
    });
    await expect(api.connectExternalIdentity("github")).rejects.toMatchObject({
      code: "step_up_required",
    });
    expect(authorization.openSystemBrowser).toHaveBeenCalledTimes(2);
    await expect(api.connectExternalIdentity("github", { totpCode: "123456" })).resolves.toEqual(
      externalIdentity,
    );
    expect(authorization.openSystemBrowser).toHaveBeenCalledTimes(2);

    expect(requests.map((request) => new URL(request.input).pathname)).toEqual([
      "/api/auth/native/handoff/start",
      "/api/auth/native/handoff/redeem",
      "/api/auth/native/handoff/start",
      "/api/auth/native/handoff/redeem",
      "/api/auth/native/handoff/redeem",
    ]);
    expect(JSON.parse(String(requests[0]?.init?.body)).purpose).toEqual({
      kind: "sign_in",
      providerHint: "github",
    });
    expect(JSON.parse(String(requests[2]?.init?.body)).purpose).toEqual({
      kind: "connect_external_identity",
      provider: "github",
    });
    expect(JSON.parse(String(requests[4]?.init?.body))).toMatchObject({
      purpose: { kind: "connect_external_identity", provider: "github" },
      totpCode: "123456",
    });
    for (const index of [2, 3, 4]) {
      const headers = headersOf(requests[index]?.init);
      expect(headers.get("Authorization")).toBe(`DPoP ${token}`);
      expect(headers.get("DPoP")).toMatch(/:ath$/);
    }
  });

  it("does not replace existing credentials when the full redeem response is malformed", async () => {
    vi.spyOn(Date, "now").mockReturnValue(now);
    const { service } = recordingDpopSigner();
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("existing-native-token");
    let request = 0;
    globalThis.fetch = vi.fn(async () => {
      request += 1;
      return request === 1
        ? response({
            handoffId,
            authorizationUrl: `https://hub.example.test/native/authorize/${handoffId}`,
            expiresAt: now + 60_000,
          })
        : response({ account: session.account, token });
    });
    const api = new HostedHubApi({
      endpoint: fakeEndpoint,
      httpClient: fakeHttpClient,
      sessionCredentials: credentials,
      dpopSigner: service,
      nativeAuthorization: nativeAuthorization(),
      passkeyCeremony: { authenticate: vi.fn(), register: vi.fn() },
    });

    await expect(api.signIn()).rejects.toBeTruthy();
    expect(credentials.current()).toBe("existing-native-token");
  });

  it("keeps presentation and consent on cookie plus CSRF transport and refuses them natively", async () => {
    const credentials = inMemorySessionCredentials();
    credentials.writeCsrfToken("csrf-canary");
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      if (requests.length === 1) {
        return response({ status: "pending", deviceLabel: "Phone", expiresAt: now + 60_000 });
      }
      return response({
        redirectUri:
          requests.length === 2
            ? `ryco-dev://hosted/complete?code=${code}&state=${state}&handoff_id=${handoffId}`
            : `ryco-dev://hosted/complete?error=access_denied&state=${state}&handoff_id=${handoffId}`,
      });
    });
    const api = new HostedHubApi({
      endpoint: fakeEndpoint,
      httpClient: fakeHttpClient,
      sessionCredentials: credentials,
      passkeyCeremony: { authenticate: vi.fn(), register: vi.fn() },
    });

    await expect(api.getNativeHandoffPresentation(handoffId)).resolves.toMatchObject({
      status: "pending",
    });
    await expect(api.approveNativeHandoff(handoffId)).resolves.toBeTruthy();
    await expect(api.cancelNativeHandoff(handoffId)).resolves.toBeTruthy();

    expect(requests.map((request) => request.input)).toEqual([
      `/api/auth/native/handoff/${handoffId}`,
      `/api/auth/native/handoff/${handoffId}/approve`,
      `/api/auth/native/handoff/${handoffId}/cancel`,
    ]);
    expect(requests[0]?.init).toMatchObject({ method: "GET", credentials: "same-origin" });
    for (const request of requests.slice(1)) {
      const headers = headersOf(request.init);
      expect(request.init).toMatchObject({ method: "POST", credentials: "same-origin" });
      expect(headers.get("X-Ryco-CSRF")).toBe("csrf-canary");
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("DPoP")).toBeNull();
    }

    const { service } = recordingDpopSigner();
    const nativeApi = createBearerApi(service, inMemoryBearerCredentials());
    await expect(nativeApi.getNativeHandoffPresentation(handoffId)).rejects.toMatchObject({
      code: "browser_only_transport",
    });
  });
});

describe("HostedHubApi browser fallback authentication", () => {
  it("supports password, recovery code, and email recovery only on cookie transport", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      return requests.length === 3
        ? response({ ok: true }, 202)
        : requests.length === 5
          ? response({ ok: true })
          : response(session);
    });
    const credentials = inMemorySessionCredentials();
    const api = new HostedHubApi({
      endpoint: fakeEndpoint,
      httpClient: fakeHttpClient,
      sessionCredentials: credentials,
      passkeyCeremony: { authenticate: vi.fn(), register: vi.fn() },
    });

    await api.signInWithPassword({
      email: "ada@example.test",
      password: "password-sensitive-canary",
      totpCode: "123456",
    });
    await api.signInWithRecoveryCode("recovery-sensitive-canary");
    await api.requestEmailRecovery("ada@example.test");
    await api.confirmEmailRecovery({
      token: "T".repeat(43),
      totpCode: "654321",
    });
    await api.confirmEmailVerification("V".repeat(43));

    expect(requests.map((request) => request.input)).toEqual([
      "/api/auth/password",
      "/api/auth/recovery",
      "/api/auth/recovery/email/request",
      "/api/auth/recovery/email/confirm",
      "/api/auth/email/verify",
    ]);
    expect(requests.map((request) => JSON.parse(String(request.init?.body)))).toEqual([
      {
        email: "ada@example.test",
        password: "password-sensitive-canary",
        totpCode: "123456",
      },
      { code: "recovery-sensitive-canary" },
      { email: "ada@example.test" },
      { token: "T".repeat(43), totpCode: "654321" },
      { token: "V".repeat(43) },
    ]);
    for (const request of requests) {
      expect(request.init).toMatchObject({ method: "POST", credentials: "same-origin" });
      const headers = headersOf(request.init);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("DPoP")).toBeNull();
      expect(headers.get("X-Ryco-CSRF")).toBeNull();
    }
    expect(credentials.readCsrfToken()).toBe("csrf-canary");

    const { service } = recordingDpopSigner();
    const nativeApi = createBearerApi(service, inMemoryBearerCredentials());
    await expect(
      nativeApi.signInWithPassword({ email: "a@b.test", password: "pw" }),
    ).rejects.toMatchObject({ code: "browser_only_transport" });
    await expect(nativeApi.signInWithRecoveryCode("code")).rejects.toMatchObject({
      code: "browser_only_transport",
    });
    await expect(nativeApi.requestEmailRecovery("a@b.test")).rejects.toMatchObject({
      code: "browser_only_transport",
    });
  });

  it("rejects malformed fallback input before any request", async () => {
    const api = createApi();
    const fetchSpy = vi.fn(async () => response(session));
    globalThis.fetch = fetchSpy;

    await expect(
      api.signInWithPassword({ email: "x".repeat(255), password: "pw" }),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(api.signInWithRecoveryCode("x".repeat(129))).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(api.confirmEmailRecovery({ token: "not-base64url=" })).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(api.confirmEmailVerification("short")).rejects.toMatchObject({
      code: "invalid_request",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("HostedHubApi public hosted identity contracts", () => {
  const opaque = "A".repeat(43);
  const issuedAt = 1_752_710_400_000;
  const expiresAt = issuedAt + 900_000;
  const space = {
    id: "space_aaaaaaaaaaaaaaaaaaaaaa",
    kind: "personal",
    displayName: "Ada's space",
    role: "owner",
  } as const;
  const identity = {
    account: {
      id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
      username: "ada_dev",
      displayName: "Ada",
      createdAt: issuedAt,
      disabledAt: null,
    },
    session: {
      id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
      accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
      activeSpaceId: space.id,
      createdAt: issuedAt,
      expiresAt: issuedAt + 86_400_000,
      lastSeenAt: issuedAt,
      revokedAt: null,
      revocationReasonCode: null,
    },
    activeSpace: space,
    spaces: [space],
    csrfToken: "public-csrf-sensitive-canary",
  } as const;

  it("reads strict public signup configuration without session material", async () => {
    globalThis.fetch = vi.fn(async () =>
      response({
        status: "enabled",
        antiBot: { provider: "turnstile", siteKey: "0x4AAAAAAAAAAABBBBBBBBBB" },
      }),
    );
    const api = createApi();
    await expect(api.getPublicSignupConfiguration()).resolves.toEqual({
      status: "enabled",
      antiBot: { provider: "turnstile", siteKey: "0x4AAAAAAAAAAABBBBBBBBBB" },
    });
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "/api/public-signup/config",
      expect.objectContaining({ credentials: "same-origin", cache: "no-store" }),
    );
    expect(api.hasSessionMaterial).toBe(false);
  });

  it("runs strict browser GitHub policy, signup, link, and disconnect requests", async () => {
    const externalIdentity = {
      provider: "github",
      login: "octocat",
      displayName: "The Octocat",
      connectedAt: issuedAt,
      lastUsedAt: null,
    } as const;
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      switch (requests.length) {
        case 1:
          return response({
            version: 1,
            providers: [{ provider: "github", login: true, signup: true, link: true }],
          });
        case 2:
        case 5:
          return response({
            authorizationUrl:
              "https://github.com/login/oauth/authorize?client_id=client&state=state&code_challenge=challenge&code_challenge_method=S256&prompt=select_account",
            expiresAt,
          });
        case 3:
          return response({
            status: "signup",
            provider: "github",
            suggestedUsername: "octocat",
            displayName: "The Octocat",
            expiresAt,
          });
        case 4:
          return response({
            status: "complete",
            identity,
            recoveryCodes: ["recovery-sensitive-canary"],
          });
        case 6:
          return response({ status: "connected", externalIdentity });
        default:
          return response({ status: "disconnected", signedOut: false });
      }
    });
    const api = createApi();

    await expect(api.getExternalIdentityConfiguration()).resolves.toMatchObject({ version: 1 });
    await api.startExternalIdentityAuthorization({
      provider: "github",
      intent: "authenticate",
      returnTo: "/account",
    });
    await expect(api.getPendingExternalIdentity()).resolves.toMatchObject({ status: "signup" });
    await expect(
      api.finishExternalIdentitySignup({
        provider: "github",
        username: "octocat",
        antiBotAssertion: "anti-bot-sensitive-canary",
        idempotencyKey: opaque,
      } as never),
    ).resolves.toMatchObject({ status: "complete" });
    await api.startExternalIdentityAuthorization({
      provider: "github",
      intent: "link",
      returnTo: "/account",
    });
    await expect(api.finishBrowserExternalIdentityConnection("github")).resolves.toEqual({
      status: "connected",
      externalIdentity,
    });
    await expect(api.disconnectExternalIdentity("github")).resolves.toEqual({
      status: "disconnected",
      signedOut: false,
    });

    expect(requests.map((request) => request.input)).toEqual([
      "/api/auth/external/config",
      "/api/auth/external/start",
      "/api/auth/external/pending",
      "/api/auth/external/signup/finish",
      "/api/auth/external/start",
      "/api/account/external-identities/github/connect",
      "/api/account/external-identities/github/disconnect",
    ]);
    expect(headersOf(requests[1]?.init).get("X-Ryco-CSRF")).toBeNull();
    for (const index of [4, 5, 6]) {
      expect(headersOf(requests[index]?.init).get("X-Ryco-CSRF")).toBe(
        "public-csrf-sensitive-canary",
      );
    }
  });

  it("rejects widened external policy and provider navigation responses", async () => {
    const api = createApi();
    globalThis.fetch = vi.fn(async () =>
      response({
        version: 1,
        providers: [
          { provider: "github", login: true, signup: true, link: true, scopes: ["repo"] },
        ],
      }),
    );
    await expect(api.getExternalIdentityConfiguration()).rejects.toMatchObject({
      code: "invalid_response",
    });

    globalThis.fetch = vi.fn(async () =>
      response({ authorizationUrl: "https://evil.test/oauth", expiresAt }),
    );
    await expect(
      api.startExternalIdentityAuthorization({
        provider: "github",
        intent: "authenticate",
        returnTo: "/account",
      }),
    ).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("strictly decodes signup legs and adopts session material only after completion", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      if (requests.length === 1) {
        return response({
          status: "accepted",
          attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
          attemptSecret: opaque,
          resendAfterMs: 30_000,
          issuedAt,
          expiresAt,
        });
      }
      if (requests.length === 2) {
        return response({
          status: "verified",
          attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
          activationSecret: "B".repeat(43),
          issuedAt,
          expiresAt,
        });
      }
      return response({
        status: "complete",
        identity,
        recoveryCodes: ["recovery-sensitive-canary"],
      });
    });
    const api = createApi();

    await api.startPublicSignup({
      username: "ada_dev",
      email: "ada@example.test",
      antiBotAssertion: "anti-bot-sensitive-canary",
    } as never);
    await api.verifyPublicSignup({
      attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
      attemptSecret: opaque,
      proof: { kind: "email_code", code: "123456" },
    } as never);
    const completed = await api.finishPublicSignupWithPassword({
      attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
      activationSecret: "B".repeat(43),
      password: "password-sensitive-canary",
      idempotencyKey: "C".repeat(43),
    } as never);

    expect(requests.map(({ input }) => input)).toEqual([
      "/api/public-signup/start",
      "/api/public-signup/verify",
      "/api/public-signup/password/finish",
    ]);
    expect(completed.identity.account.username).toBe("ada_dev");
    expect(completed.recoveryCodes).toEqual(["recovery-sensitive-canary"]);
    expect(api.hasSessionMaterial).toBe(true);
    for (const request of requests) {
      expect(request.init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
      });
      expect(String(request.input)).not.toContain("sensitive-canary");
    }
  });

  it("validates passkey options before opening the ceremony and rejects response extras", async () => {
    const register = vi.fn(async () => ({ id: "passkey-response" }) as never);
    const api = createApi({ register });
    globalThis.fetch = vi.fn(async () =>
      response({ options: registrationOptions, internalChallengeId: "must-not-survive" }),
    );

    await expect(
      api.finishPublicSignupWithPasskey({
        attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
        activationSecret: opaque,
        idempotencyKey: "B".repeat(43),
      } as never),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(register).not.toHaveBeenCalled();

    const fetchSpy = vi.fn(async () => response({ options: registrationOptions }));
    globalThis.fetch = fetchSpy;
    await expect(
      api.finishPublicSignupWithPasskey({
        attemptId: "signup_aaaaaaaaaaaaaaaaaaaaaa",
        activationSecret: opaque,
        idempotencyKey: "too-short",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(register).not.toHaveBeenCalled();
  });

  it("decodes password second-factor and reset results without reflecting secrets", async () => {
    const requests: Array<RequestInfo | URL> = [];
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(input);
      if (requests.length === 1) {
        return response({
          status: "factor_required",
          attemptId: "login_aaaaaaaaaaaaaaaaaaaaaa",
          attemptSecret: opaque,
          factor: "email_code",
          issuedAt,
          expiresAt,
        });
      }
      if (requests.length === 2) return response(identity);
      if (requests.length === 3) return response({ status: "accepted" });
      if (requests.length === 4) {
        return response({
          status: "verified",
          attemptId: "reset_aaaaaaaaaaaaaaaaaaaaaa",
          attemptSecret: "B".repeat(43),
          requiresTotp: false,
          issuedAt,
          expiresAt,
        });
      }
      return response({ status: "complete" });
    });
    const api = createApi();

    const login = await api.startPasswordLogin({
      identifier: "ada_dev",
      password: "password-sensitive-canary",
    } as never);
    expect(login.factor).toBe("email_code");
    await api.finishPasswordLogin({
      attemptId: login.attemptId,
      attemptSecret: login.attemptSecret,
      factor: login.factor,
      code: "123456",
    });
    await api.requestPasswordReset({ identifier: "ada@example.test" } as never);
    const reset = await api.verifyPasswordReset({ token: "C".repeat(43) } as never);
    await api.finishPasswordReset({
      attemptId: reset.attemptId,
      attemptSecret: reset.attemptSecret,
      password: "new-password-sensitive-canary",
      factor: { kind: "none" },
    });

    expect(requests).toEqual([
      "/api/auth/password/start",
      "/api/auth/password/finish",
      "/api/auth/password-reset/request",
      "/api/auth/password-reset/verify",
      "/api/auth/password-reset/finish",
    ]);
    expect(api.hasSessionMaterial).toBe(false);

    globalThis.fetch = vi.fn(async () =>
      response({
        status: "factor_required",
        attemptId: "login_aaaaaaaaaaaaaaaaaaaaaa",
        attemptSecret: opaque,
        factor: "email_code",
        issuedAt,
        expiresAt,
        providerMessageId: "resend-sensitive-canary",
      }),
    );
    const error = await api
      .startPasswordLogin({
        identifier: "ada_dev",
        password: "password-sensitive-canary",
      } as never)
      .catch((cause) => cause);
    expect(error).toMatchObject({ code: "invalid_response" });
    expect((error as Error).message).not.toContain("resend-sensitive-canary");
  });

  it("fails closed across the cookie and DPoP transport boundary before I/O", async () => {
    const fetchSpy = vi.fn(async () => response({ status: "accepted" }));
    globalThis.fetch = fetchSpy;
    const { service } = recordingDpopSigner();
    const native = createBearerApi(service, inMemoryBearerCredentials());
    const browser = createApi();

    await expect(
      native.startPublicSignup({
        username: "ada_dev",
        email: "ada@example.test",
        antiBotAssertion: "assertion",
      } as never),
    ).rejects.toMatchObject({ code: "browser_only_transport" });
    await expect(
      browser.startNativeNodeClaim({
        installationId: "install_aaaaaaaaaaaaaaaaaaaaaa",
        node: {},
      } as never),
    ).rejects.toMatchObject({ code: "native_only_transport" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("uses the authenticated DPoP session for exact automatic-node claim requests", async () => {
    const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("native-token-sensitive-canary");
    const { calls, service } = recordingDpopSigner();
    const fingerprint = `SHA256:${"A".repeat(42)}E`;
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ input, ...(init ? { init } : {}) });
      if (requests.length === 1) {
        return response({
          protocolVersion: 1,
          transcriptVersion: 1,
          claimId: "nclaim_aaaaaaaaaaaaaaaaaaaaaa",
          challenge: opaque,
          accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
          spaceId: space.id,
          sessionId: "sess_aaaaaaaaaaaaaaaaaaaaaa",
          dpopKeyThumbprint: "B".repeat(43),
          installationId: "install_aaaaaaaaaaaaaaaaaaaaaa",
          environmentId: "env_aaaaaaaaaaaaaaaaaaaaaa",
          nodeFingerprint: fingerprint,
          issuedAt,
          expiresAt,
        });
      }
      return response({
        status: "claimed",
        disposition: "created",
        node: {
          id: "node_aaaaaaaaaaaaaaaaaaaaaa",
          activeKeyId: "nkey_aaaaaaaaaaaaaaaaaaaaaa",
          environmentId: "env_aaaaaaaaaaaaaaaaaaaaaa",
          label: "Ada's Mac",
          fingerprint,
          effectiveRole: "owner",
        },
      });
    });
    const api = createBearerApi(service, credentials);
    const started = await api.startNativeNodeClaim({
      installationId: "install_aaaaaaaaaaaaaaaaaaaaaa",
      node: {
        environmentId: "env_aaaaaaaaaaaaaaaaaaaaaa",
        label: "Ada's Mac",
        platformOs: "darwin",
        platformArch: "arm64",
        clientVersion: "0.1.8",
        algorithm: "ed25519",
        publicKey: opaque,
        fingerprint,
      },
    } as never);
    const finished = await api.finishNativeNodeClaim({
      claimId: started.claimId,
      challenge: started.challenge,
      signature: `${"A".repeat(85)}Q`,
      idempotencyKey: "C".repeat(43),
    } as never);

    expect(finished.node.id).toBe("node_aaaaaaaaaaaaaaaaaaaaaa");
    expect(requests.map(({ input }) => input)).toEqual([
      "https://hub.example.test/api/native/node-claims/start",
      "https://hub.example.test/api/native/node-claims/finish",
    ]);
    expect(JSON.parse(String(requests[1]?.init?.body))).toEqual({
      claimId: started.claimId,
      challenge: started.challenge,
      signature: `${"A".repeat(85)}Q`,
      idempotencyKey: "C".repeat(43),
    });
    expect(calls).toHaveLength(2);
    expect(calls.every((call) => call.token === "native-token-sensitive-canary")).toBe(true);
    for (const request of requests) {
      const headers = headersOf(request.init);
      expect(headers.get("Authorization")).toBe("DPoP native-token-sensitive-canary");
      expect(headers.get("X-Ryco-CSRF")).toBeNull();
      expect(request.init?.credentials).toBe("omit");
    }
  });

  it("forwards caller cancellation without publishing a synthetic Hub error", async () => {
    globalThis.fetch = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new DOMException("cancelled", "AbortError")),
          );
        }),
    );
    const api = createApi();
    const controller = new AbortController();
    const pending = api.startPublicSignup(
      {
        username: "ada_dev",
        email: "ada@example.test",
        antiBotAssertion: "anti-bot-sensitive-canary",
      } as never,
      controller.signal,
    );
    controller.abort();

    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
  });
});

describe("HostedHubApi native identity v2 transport", () => {
  const opaque = "A".repeat(43);
  const opaqueB = "B".repeat(43);
  const opaqueC = "C".repeat(43);
  const issuedAt = 1_752_710_400_000;
  const expiresAt = issuedAt + 900_000;
  const identity = {
    account: {
      id: "acct_aaaaaaaaaaaaaaaaaaaaaa",
      username: "ada_dev",
      displayName: "Ada",
      createdAt: issuedAt,
      disabledAt: null,
    },
    session: {
      id: "sess_aaaaaaaaaaaaaaaaaaaaaa",
      accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
      activeSpaceId: "space_aaaaaaaaaaaaaaaaaaaaaa",
      createdAt: issuedAt,
      expiresAt: issuedAt + 86_400_000,
      lastSeenAt: issuedAt,
      revokedAt: null,
      revocationReasonCode: null,
    },
    activeSpace: {
      id: "space_aaaaaaaaaaaaaaaaaaaaaa",
      kind: "personal",
      displayName: "Ada's space",
      role: "owner",
    },
    spaces: [
      {
        id: "space_aaaaaaaaaaaaaaaaaaaaaa",
        kind: "personal",
        displayName: "Ada's space",
        role: "owner",
      },
    ],
  } as const;
  const completed = { status: "complete", identity, token: opaqueC } as const;
  const signupCompleted = {
    ...completed,
    recoveryCodes: ["recovery-sensitive-canary"],
  } as const;

  it("uses mint DPoP for every native leg and leaves completion adoption to the platform owner", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const credentials = inMemoryBearerCredentials();
    const { calls, service } = recordingDpopSigner();
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const pathname = new URL(String(input)).pathname;
      requests.push({ input: String(input), ...(init ? { init } : {}) });
      switch (pathname) {
        case "/api/auth/native/identity/email/start":
          return response({
            status: "accepted",
            attemptId: "nident_aaaaaaaaaaaaaaaaaaaaaa",
            attemptSecret: opaque,
            resendAfterMs: 30_000,
            issuedAt,
            expiresAt,
          });
        case "/api/auth/native/identity/email/verify":
          return response({
            status: "new_account",
            attemptId: "nident_aaaaaaaaaaaaaaaaaaaaaa",
            activationSecret: opaqueB,
            issuedAt,
            expiresAt,
          });
        case "/api/auth/native/identity/signup/username":
          return response({ status: "claimed" });
        case "/api/auth/native/identity/signup/password/finish":
          return response(signupCompleted);
        case "/api/auth/native/identity/password/start":
          return response({
            status: "factor_required",
            attemptId: "nlogin_aaaaaaaaaaaaaaaaaaaaaa",
            attemptSecret: opaque,
            factor: "email_code",
            issuedAt,
            expiresAt,
          });
        case "/api/auth/native/identity/password/finish":
          return response(completed);
        case "/api/auth/native/identity/recovery-code":
          return response({ ...completed, recoveryCodes: ["rotated-recovery-canary"] });
        case "/api/auth/native/identity/password-reset/request":
          return response({
            status: "accepted",
            attemptId: "nreset_aaaaaaaaaaaaaaaaaaaaaa",
            attemptSecret: opaque,
            resendAfterMs: 30_000,
            issuedAt,
            expiresAt,
          });
        case "/api/auth/native/identity/password-reset/verify":
          return response({
            status: "verified",
            attemptId: "nreset_aaaaaaaaaaaaaaaaaaaaaa",
            resetSecret: opaqueB,
            requiresTotp: false,
            issuedAt,
            expiresAt,
          });
        case "/api/auth/native/identity/password-reset/finish":
          return response({ status: "complete" });
        case "/api/auth/native/identity/attempt/cancel":
          return response({ status: "cancelled" });
        default:
          throw new Error(`Unexpected native identity path: ${pathname}`);
      }
    });
    const api = createBearerApi(service, credentials);

    const started = await api.startNativeIdentityEmail({
      email: "ada@example.test",
      antiBotAssertion: "anti-bot-sensitive-canary",
    } as never);
    const verified = await api.verifyNativeIdentityEmail({
      attemptId: started.attemptId,
      attemptSecret: started.attemptSecret,
      proof: { kind: "email_code", code: "123456" },
    });
    await api.claimNativeIdentityUsername({
      attemptId: verified.attemptId,
      activationSecret: verified.activationSecret,
      username: "ada_dev",
    } as never);
    const signup = await api.finishNativeIdentitySignupWithPassword({
      attemptId: verified.attemptId,
      activationSecret: verified.activationSecret,
      password: "password-sensitive-canary",
      idempotencyKey: opaqueC,
    });
    const login = await api.startNativeIdentityPasswordLogin({
      kind: "username",
      username: "ada_dev",
      password: "password-sensitive-canary",
    } as never);
    const sessionResult = await api.finishNativeIdentityPasswordLogin({
      attemptId: login.attemptId,
      attemptSecret: login.attemptSecret,
      factor: login.factor,
      code: "123456",
    });
    const recovered = await api.signInNativeIdentityWithRecoveryCode({
      code: "recovery-sensitive-canary",
      idempotencyKey: opaque,
    } as never);
    const reset = await api.requestNativeIdentityPasswordReset({ identifier: "ada_dev" } as never);
    const resetVerified = await api.verifyNativeIdentityPasswordReset({
      attemptId: reset.attemptId,
      attemptSecret: reset.attemptSecret,
      proof: { kind: "email_code", code: "123456" },
    });
    await api.finishNativeIdentityPasswordReset({
      attemptId: resetVerified.attemptId,
      resetSecret: resetVerified.resetSecret,
      password: "new-password-sensitive-canary",
      factor: { kind: "none" },
    });
    await api.cancelNativeIdentityAttempt({
      attemptId: started.attemptId,
      attemptSecret: started.attemptSecret,
    });

    expect(signup).toEqual(signupCompleted);
    expect(sessionResult).toEqual(completed);
    expect(recovered.recoveryCodes).toEqual(["rotated-recovery-canary"]);
    expect(credentials.current()).toBeNull();
    expect(api.hasSessionMaterial).toBe(false);
    expect(requests.map(({ input }) => new URL(input).pathname)).toEqual([
      "/api/auth/native/identity/email/start",
      "/api/auth/native/identity/email/verify",
      "/api/auth/native/identity/signup/username",
      "/api/auth/native/identity/signup/password/finish",
      "/api/auth/native/identity/password/start",
      "/api/auth/native/identity/password/finish",
      "/api/auth/native/identity/recovery-code",
      "/api/auth/native/identity/password-reset/request",
      "/api/auth/native/identity/password-reset/verify",
      "/api/auth/native/identity/password-reset/finish",
      "/api/auth/native/identity/attempt/cancel",
    ]);
    expect(calls).toHaveLength(requests.length);
    expect(calls.every((call) => call.token === undefined)).toBe(true);
    for (const request of requests) {
      const headers = headersOf(request.init);
      expect(headers.get("DPoP")).toMatch(/:no-ath$/);
      expect(headers.get("Authorization")).toBeNull();
      expect(headers.get("X-Ryco-CSRF")).toBeNull();
      expect(request.init?.credentials).toBe("omit");
      expect(request.init?.cache).toBe("no-store");
    }
  });

  it("runs native signup passkey registration without adopting the returned token", async () => {
    const requests: string[] = [];
    const credentials = inMemoryBearerCredentials();
    const { calls, service } = recordingDpopSigner();
    const register = vi.fn(async () => ({ id: "passkey-response" }) as never);
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      requests.push(String(input));
      return requests.length === 1
        ? response({ options: registrationOptions })
        : response(signupCompleted);
    });
    const api = createBearerApi(service, credentials, { register });

    await expect(
      api.finishNativeIdentitySignupWithPasskey({
        attemptId: "nident_aaaaaaaaaaaaaaaaaaaaaa",
        activationSecret: opaqueB,
        idempotencyKey: opaqueC,
      } as never),
    ).resolves.toEqual(signupCompleted);

    expect(requests.map((input) => new URL(input).pathname)).toEqual([
      "/api/auth/native/identity/signup/passkey/options",
      "/api/auth/native/identity/signup/passkey/finish",
    ]);
    expect(register).toHaveBeenCalledOnce();
    expect(calls.every((call) => call.token === undefined)).toBe(true);
    expect(credentials.current()).toBeNull();
  });

  it("rejects cross-transport and malformed completion before changing existing credentials", async () => {
    const browser = createApi();
    const browserFetch = vi.fn(async () => response(completed));
    globalThis.fetch = browserFetch;
    await expect(
      browser.finishNativeIdentityPasswordLogin({
        attemptId: "nlogin_aaaaaaaaaaaaaaaaaaaaaa",
        attemptSecret: opaque,
        factor: "totp",
        code: "123456",
      } as never),
    ).rejects.toMatchObject({ code: "native_only_transport" });
    expect(browserFetch).not.toHaveBeenCalled();

    const credentials = inMemoryBearerCredentials();
    credentials.writeBearerToken?.("existing-token-sensitive-canary");
    const { calls, service } = recordingDpopSigner();
    globalThis.fetch = vi.fn(async () =>
      response({ ...completed, identity: { ...identity, csrfToken: "csrf-must-not-survive" } }),
    );
    const native = createBearerApi(service, credentials);
    await expect(
      native.finishNativeIdentityPasswordLogin({
        attemptId: "nlogin_aaaaaaaaaaaaaaaaaaaaaa",
        attemptSecret: opaque,
        factor: "totp",
        code: "123456",
      } as never),
    ).rejects.toMatchObject({ code: "invalid_response" });
    expect(credentials.current()).toBe("existing-token-sensitive-canary");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.token).toBeUndefined();
  });
});
