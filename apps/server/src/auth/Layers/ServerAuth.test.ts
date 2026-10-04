import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BootstrapCredentialError } from "../Services/BootstrapCredentialService.ts";
import { ServerAuth, type ServerAuthShape } from "../Services/ServerAuth.ts";
import { ServerAuthLive, toBootstrapExchangeAuthError } from "./ServerAuth.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";

const makeServerConfigLayer = (overrides?: Partial<ServerConfigShape>) =>
  Layer.effect(
    ServerConfig,
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      return {
        ...config,
        ...overrides,
      } satisfies ServerConfigShape;
    }),
  ).pipe(
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-auth-server-test-" })),
  );

const makeServerAuthLayer = (overrides?: Partial<ServerConfigShape>) =>
  ServerAuthLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

const makeCookieRequest = (
  sessionToken: string,
): Parameters<ServerAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {
      ryco_session: sessionToken,
    },
    headers: {},
  }) as unknown as Parameters<ServerAuthShape["authenticateHttpRequest"]>[0];

const makeBearerRequest = (
  token: string,
): Parameters<ServerAuthShape["authenticateHttpRequest"]>[0] =>
  ({
    cookies: {},
    headers: { authorization: `Bearer ${token}` },
  }) as unknown as Parameters<ServerAuthShape["authenticateHttpRequest"]>[0];

const requestMetadata = {
  deviceType: "desktop" as const,
  os: "macOS",
  browser: "Chrome",
  ipAddress: "192.168.1.23",
};

it.layer(NodeServices.layer)("ServerAuthLive", (it) => {
  it.effect("never accepts an external MCP credential as HTTP or WebSocket auth", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const request = makeBearerRequest(`rycoext_${"A".repeat(43)}`);
      const http = yield* Effect.flip(serverAuth.authenticateHttpRequest(request));
      expect(http.status).toBe(401);
      const websocket = yield* Effect.flip(serverAuth.authenticateWebSocketUpgrade(request));
      expect(websocket.status).toBe(401);
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("maps invalid bootstrap credential failures to 401", () =>
    Effect.sync(() => {
      const error = toBootstrapExchangeAuthError(
        new BootstrapCredentialError({
          message: "Unknown bootstrap credential.",
          status: 401,
        }),
      );

      expect(error.status).toBe(401);
      expect(error.message).toBe("Invalid bootstrap credential.");
    }),
  );

  it.effect("maps unexpected bootstrap failures to 500", () =>
    Effect.sync(() => {
      const error = toBootstrapExchangeAuthError(
        new BootstrapCredentialError({
          message: "Failed to consume bootstrap credential.",
          status: 500,
          cause: new Error("sqlite is unavailable"),
        }),
      );

      expect(error.status).toBe(500);
      expect(error.message).toBe("Failed to validate bootstrap credential.");
    }),
  );

  it.effect("issues client pairing credentials by default", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingCredential = yield* serverAuth.issuePairingCredential();
      const exchanged = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        requestMetadata,
      );
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.sessionId.length).toBeGreaterThan(0);
      expect(verified.role).toBe("client");
      expect(verified.subject).toBe("one-time-token");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("issues startup pairing URLs that bootstrap owner sessions", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const pairingUrl = yield* serverAuth.issueStartupPairingUrl("http://127.0.0.1:3773");
      const token = new URLSearchParams(new URL(pairingUrl).hash.slice(1)).get("token");
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      expect(token).toBeTruthy();
      expect(
        listedPairingLinks.some((pairingLink) => pairingLink.subject === "owner-bootstrap"),
      ).toBe(false);

      const exchanged = yield* serverAuth.exchangeBootstrapCredential(token ?? "", requestMetadata);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(exchanged.sessionToken),
      );

      expect(verified.role).toBe("owner");
      expect(verified.subject).toBe("owner-bootstrap");
    }).pipe(Effect.provide(makeServerAuthLayer())),
  );

  it.effect("lists pairing links and revokes other client sessions while keeping the owner", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;

      const ownerExchange = yield* serverAuth.exchangeBootstrapCredential(
        "desktop-bootstrap-token",
        requestMetadata,
      );
      const ownerSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(ownerExchange.sessionToken),
      );
      const pairingCredential = yield* serverAuth.issuePairingCredential({
        label: "Julius iPhone",
      });
      const listedPairingLinks = yield* serverAuth.listPairingLinks();
      const clientExchange = yield* serverAuth.exchangeBootstrapCredential(
        pairingCredential.credential,
        {
          ...requestMetadata,
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      );
      const clientSession = yield* serverAuth.authenticateHttpRequest(
        makeCookieRequest(clientExchange.sessionToken),
      );
      const clientsBeforeRevoke = yield* serverAuth.listClientSessions(ownerSession.sessionId);
      const revokedCount = yield* serverAuth.revokeOtherClientSessions(ownerSession.sessionId);
      const clientsAfterRevoke = yield* serverAuth.listClientSessions(ownerSession.sessionId);

      expect(listedPairingLinks.map((entry) => entry.id)).toContain(pairingCredential.id);
      expect(listedPairingLinks.find((entry) => entry.id === pairingCredential.id)?.label).toBe(
        "Julius iPhone",
      );
      expect(clientsBeforeRevoke).toHaveLength(2);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === ownerSession.sessionId)?.current,
      ).toBe(true);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.current,
      ).toBe(false);
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
          .label,
      ).toBe("Julius iPhone");
      expect(
        clientsBeforeRevoke.find((entry) => entry.sessionId === clientSession.sessionId)?.client
          .deviceType,
      ).toBe("mobile");
      expect(revokedCount).toBe(1);
      expect(clientsAfterRevoke).toHaveLength(1);
      expect(clientsAfterRevoke[0]?.sessionId).toBe(ownerSession.sessionId);
    }).pipe(
      Effect.provide(
        makeServerAuthLayer({
          desktopBootstrapToken: "desktop-bootstrap-token",
        }),
      ),
    ),
  );

  it.effect("renews a direct bearer pairing over its own bearer only", () =>
    Effect.gen(function* () {
      const serverAuth = yield* ServerAuth;
      const pairing = yield* serverAuth.issuePairingCredential({ label: "Julius iPhone" });
      const paired = yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
        pairing.credential,
        { ...requestMetadata, deviceType: "mobile" },
      );

      // Renewed right after pairing: nothing to renew yet.
      const tooSoon = yield* Effect.flip(
        serverAuth.rotateBearerSession(makeBearerRequest(paired.sessionToken)),
      );
      expect(tooSoon.status).toBe(409);

      yield* TestClock.adjust(Duration.days(2));
      const renewed = yield* serverAuth.rotateBearerSession(makeBearerRequest(paired.sessionToken));
      expect(renewed).toMatchObject({
        authenticated: true,
        role: "client",
        sessionMethod: "bearer-session-token",
      });
      expect(renewed.sessionToken).not.toBe(paired.sessionToken);
      const verified = yield* serverAuth.authenticateHttpRequest(
        makeBearerRequest(renewed.sessionToken),
      );
      expect(verified.subject).toBe("one-time-token");

      // A browser session cookie never renews into anything, as a cookie or
      // presented as a bearer.
      const ownerPairing = yield* serverAuth.issuePairingCredential({ role: "owner" });
      const browser = yield* serverAuth.exchangeBootstrapCredential(
        ownerPairing.credential,
        requestMetadata,
      );
      const cookieOnly = yield* Effect.flip(
        serverAuth.rotateBearerSession(makeCookieRequest(browser.sessionToken)),
      );
      expect(cookieOnly.status).toBe(401);
      const cookieAsBearer = yield* Effect.flip(
        serverAuth.rotateBearerSession(makeBearerRequest(browser.sessionToken)),
      );
      expect(cookieAsBearer.status).toBe(403);
    }).pipe(Effect.provide(Layer.merge(makeServerAuthLayer(), TestClock.layer()))),
  );
});
