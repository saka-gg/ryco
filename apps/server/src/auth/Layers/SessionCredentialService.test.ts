import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { TestClock } from "effect/testing";

import type { ServerConfigShape } from "../../config.ts";
import { ServerConfig } from "../../config.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { AuthSessionRepositoryLive } from "../../persistence/Layers/AuthSessions.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { AuthSessionRepository } from "../../persistence/Services/AuthSessions.ts";
import {
  SessionCredentialService,
  SessionRotationError,
} from "../Services/SessionCredentialService.ts";
import { ServerSecretStoreLive } from "./ServerSecretStore.ts";
import {
  makeSessionCredentialService,
  SessionCredentialServiceLive,
} from "./SessionCredentialService.ts";

const makeServerConfigLayer = (
  overrides?: Partial<Pick<ServerConfigShape, "desktopBootstrapToken">>,
) =>
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
    Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-auth-session-test-" })),
  );

const makeSessionCredentialLayer = (
  overrides?: Partial<Pick<ServerConfigShape, "desktopBootstrapToken">>,
) =>
  SessionCredentialServiceLive.pipe(
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer(overrides)),
  );

/** A session store whose reads fail while `failing` is set: a busy or broken database. */
const makeFaultySessionCredentialLayer = (store: { failing: boolean }) =>
  Layer.effect(SessionCredentialService, makeSessionCredentialService).pipe(
    Layer.provide(
      Layer.effect(
        AuthSessionRepository,
        Effect.gen(function* () {
          const repository = yield* AuthSessionRepository;
          return {
            ...repository,
            getById: (input) =>
              store.failing
                ? Effect.fail(
                    new PersistenceSqlError({
                      operation: "AuthSessionRepository.getById:query",
                      detail: "database is locked",
                    }),
                  )
                : repository.getById(input),
          };
        }),
      ).pipe(Layer.provide(AuthSessionRepositoryLive)),
    ),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provide(ServerSecretStoreLive),
    Layer.provide(makeServerConfigLayer()),
  );

it.layer(NodeServices.layer)("SessionCredentialServiceLive", (it) => {
  it.effect("tells a session store that did not answer apart from a rejected credential", () => {
    const store = { failing: false };
    return Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({ method: "bearer-session-token", subject: "phone" });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      store.failing = true;
      const sessionFault = yield* Effect.flip(sessions.verify(issued.token));
      expect(sessionFault._tag).toBe("SessionCredentialUnavailableError");
      const websocketFault = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(websocketFault._tag).toBe("SessionCredentialUnavailableError");
      // What the credential itself says is still a rejection.
      const malformed = yield* Effect.flip(sessions.verify("not-a-session-token"));
      expect(malformed._tag).toBe("SessionCredentialError");

      // The credential was fine all along.
      store.failing = false;
      expect((yield* sessions.verify(issued.token)).sessionId).toBe(issued.sessionId);
    }).pipe(Effect.provide(makeFaultySessionCredentialLayer(store)));
  });

  it.effect("issues and verifies signed browser session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: "desktop-bootstrap",
        role: "owner",
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
          ipAddress: "127.0.0.1",
        },
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("browser-session-cookie");
      expect(verified.subject).toBe("desktop-bootstrap");
      expect(verified.role).toBe("owner");
      expect(verified.client.label).toBe("Desktop app");
      expect(verified.client.browser).toBe("Electron");
      expect(verified.expiresAt?.toString()).toBe(issued.expiresAt.toString());
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );
  it.effect("rejects malformed session tokens", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const error = yield* Effect.flip(sessions.verify("not-a-session-token"));

      expect(error._tag).toBe("SessionCredentialError");
      expect(error.message).toContain("Malformed session token");
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );
  it.effect("verifies session tokens against the Effect clock", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        method: "bearer-session-token",
        subject: "test-clock",
      });
      const verified = yield* sessions.verify(issued.token);

      expect(verified.method).toBe("bearer-session-token");
      expect(verified.subject).toBe("test-clock");
      expect(verified.role).toBe("client");
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("rejects websocket tokens once the parent session has expired", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        method: "bearer-session-token",
        subject: "short-lived",
        ttl: Duration.seconds(1),
      });
      const websocket = yield* sessions.issueWebSocketToken(issued.sessionId);

      yield* TestClock.adjust(Duration.seconds(2));

      const error = yield* Effect.flip(sessions.verifyWebSocketToken(websocket.token));
      expect(error.message).toContain("expired");
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  it.effect("lists active sessions, tracks connectivity, and revokes other sessions", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const owner = yield* sessions.issue({
        subject: "desktop-bootstrap",
        role: "owner",
        client: {
          label: "Desktop app",
          deviceType: "desktop",
          os: "macOS",
          browser: "Electron",
        },
      });
      const client = yield* sessions.issue({
        subject: "one-time-token",
        role: "client",
        client: {
          label: "Julius iPhone",
          deviceType: "mobile",
          os: "iOS",
          browser: "Safari",
          ipAddress: "192.168.1.88",
        },
      });

      yield* sessions.markConnected(client.sessionId);
      const beforeRevoke = yield* sessions.listActive();
      const revokedCount = yield* sessions.revokeAllExcept(owner.sessionId);
      const afterRevoke = yield* sessions.listActive();
      const revokedClient = yield* Effect.flip(sessions.verify(client.token));

      expect(beforeRevoke).toHaveLength(2);
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.connected).toBe(
        true,
      );
      expect(beforeRevoke.find((entry) => entry.sessionId === client.sessionId)?.client.label).toBe(
        "Julius iPhone",
      );
      expect(
        beforeRevoke.find((entry) => entry.sessionId === owner.sessionId)?.client.deviceType,
      ).toBe("desktop");
      expect(revokedCount).toBe(1);
      expect(afterRevoke).toHaveLength(1);
      expect(afterRevoke[0]?.sessionId).toBe(owner.sessionId);
      expect(revokedClient.message).toContain("revoked");
    }).pipe(Effect.provide(makeSessionCredentialLayer())),
  );

  it.effect("persists lastConnectedAt on first connect and updates it after reconnect", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const issued = yield* sessions.issue({
        subject: "reconnect-test",
        method: "bearer-session-token",
      });

      const beforeConnect = yield* sessions.listActive();
      expect(beforeConnect[0]?.lastConnectedAt).toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const firstConnect = yield* sessions.listActive();
      const firstConnectedAt = firstConnect[0]?.lastConnectedAt;

      expect(firstConnect[0]?.connected).toBe(true);
      expect(firstConnectedAt).not.toBeNull();

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const stillConnected = yield* sessions.listActive();

      expect(stillConnected[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* sessions.markDisconnected(issued.sessionId);
      yield* sessions.markDisconnected(issued.sessionId);
      const afterDisconnect = yield* sessions.listActive();

      expect(afterDisconnect[0]?.connected).toBe(false);
      expect(afterDisconnect[0]?.lastConnectedAt?.toString()).toBe(firstConnectedAt?.toString());

      yield* TestClock.adjust(Duration.seconds(1));
      yield* sessions.markConnected(issued.sessionId);
      const afterReconnect = yield* sessions.listActive();

      expect(afterReconnect[0]?.connected).toBe(true);
      expect(afterReconnect[0]?.lastConnectedAt).not.toBeNull();
      expect(afterReconnect[0]?.lastConnectedAt?.toString()).not.toBe(firstConnectedAt?.toString());
    }).pipe(Effect.provide(Layer.merge(makeSessionCredentialLayer(), TestClock.layer()))),
  );

  const withClock = () => Layer.merge(makeSessionCredentialLayer(), TestClock.layer());

  it.effect("renews a bearer pairing by rotation and supersedes it on first use", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const paired = yield* sessions.issue({
        method: "bearer-session-token",
        subject: "one-time-token",
        role: "client",
        client: { label: "Julius iPhone", deviceType: "mobile" },
      });
      yield* TestClock.adjust(Duration.days(2));

      const rotated = yield* sessions.rotate(paired.sessionId);
      expect(rotated.sessionId).not.toBe(paired.sessionId);
      expect(rotated.role).toBe("client");
      expect(rotated.client.label).toBe("Julius iPhone");
      // A lost response: asking again before the successor is used returns it.
      const again = yield* sessions.rotate(paired.sessionId);
      expect(again.token).toBe(rotated.token);
      // The predecessor stays valid until its successor is first used, and the
      // pairing is listed once.
      yield* sessions.verify(paired.token);
      expect((yield* sessions.listActive()).map((entry) => entry.sessionId)).toEqual([
        paired.sessionId,
      ]);

      const verified = yield* sessions.verify(rotated.token);
      expect(verified.subject).toBe("one-time-token");
      expect((yield* sessions.listActive()).map((entry) => entry.sessionId)).toEqual([
        rotated.sessionId,
      ]);
      // Requests already in flight with the old bearer still land.
      yield* sessions.verify(paired.token);
      const refused = yield* Effect.flip(sessions.rotate(paired.sessionId));
      expect(refused).toBeInstanceOf(SessionRotationError);
      expect((refused as SessionRotationError).reason).toBe("superseded");
    }).pipe(Effect.provide(withClock())),
  );

  it.effect("revokes the whole pairing when a superseded bearer is reused", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const paired = yield* sessions.issue({ method: "bearer-session-token", subject: "copy" });
      yield* TestClock.adjust(Duration.days(2));
      const rotated = yield* sessions.rotate(paired.sessionId);
      yield* sessions.verify(rotated.token);

      // Long after the successor took over, someone presents the old bearer.
      yield* TestClock.adjust(Duration.minutes(5));
      const reused = yield* Effect.flip(sessions.verify(paired.token));
      expect(reused.message).toContain("reused");
      const successor = yield* Effect.flip(sessions.verify(rotated.token));
      expect(successor.message).toContain("revoked");
      expect(yield* sessions.listActive()).toHaveLength(0);
    }).pipe(Effect.provide(withClock())),
  );

  it.effect("never renews a pairing past one year from when it was made", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const paired = yield* sessions.issue({ method: "bearer-session-token", subject: "yearly" });
      const pairedAtMs = paired.expiresAt.epochMilliseconds - Duration.toMillis(Duration.days(30));
      let current = paired;
      let refusal: SessionRotationError | null = null;
      // Used every twenty days, the pairing renews until its year is up.
      for (let renewal = 0; renewal < 25 && refusal === null; renewal += 1) {
        yield* TestClock.adjust(Duration.days(20));
        const outcome = yield* sessions.rotate(current.sessionId).pipe(
          Effect.map((rotated) => ({ rotated, refusal: null })),
          Effect.catchTag("SessionRotationError", (error) =>
            Effect.succeed({ rotated: null, refusal: error }),
          ),
        );
        if (outcome.rotated === null) {
          refusal = outcome.refusal;
          break;
        }
        yield* sessions.verify(outcome.rotated.token);
        current = outcome.rotated;
      }

      expect(refusal?.reason).toBe("renewal-limit");
      expect(current.expiresAt.epochMilliseconds).toBe(
        pairedAtMs + Duration.toMillis(Duration.days(365)),
      );
    }).pipe(Effect.provide(withClock())),
  );

  it.effect("refuses to rotate a browser cookie session or one renewed within the hour", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const cookie = yield* sessions.issue({ subject: "browser" });
      const bearer = yield* sessions.issue({ method: "bearer-session-token", subject: "fresh" });

      const notBearer = yield* Effect.flip(sessions.rotate(cookie.sessionId));
      expect((notBearer as SessionRotationError).reason).toBe("not-bearer");
      const tooSoon = yield* Effect.flip(sessions.rotate(bearer.sessionId));
      expect((tooSoon as SessionRotationError).reason).toBe("renewed-recently");
    }).pipe(Effect.provide(withClock())),
  );

  it.effect("revokes every rotation of a pairing, and keeps the current one on revoke-others", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const owner = yield* sessions.issue({
        method: "bearer-session-token",
        subject: "owner-bootstrap",
        role: "owner",
      });
      const phone = yield* sessions.issue({ method: "bearer-session-token", subject: "phone" });
      yield* TestClock.adjust(Duration.days(2));
      const ownerRotated = yield* sessions.rotate(owner.sessionId);
      yield* sessions.verify(ownerRotated.token);
      const phoneRotated = yield* sessions.rotate(phone.sessionId);
      yield* sessions.verify(phoneRotated.token);

      expect(yield* sessions.revokeAllExcept(ownerRotated.sessionId)).toBe(2);
      yield* sessions.verify(ownerRotated.token);
      const phoneError = yield* Effect.flip(sessions.verify(phoneRotated.token));
      expect(phoneError.message).toContain("revoked");

      // Revoking the pairing by its first session ends its rotations too.
      expect(yield* sessions.revoke(owner.sessionId)).toBe(true);
      const ownerError = yield* Effect.flip(sessions.verify(ownerRotated.token));
      expect(ownerError.message).toContain("revoked");
    }).pipe(Effect.provide(withClock())),
  );

  it.effect("shows a rotated pairing as connected while an earlier session holds its socket", () =>
    Effect.gen(function* () {
      const sessions = yield* SessionCredentialService;
      const paired = yield* sessions.issue({ method: "bearer-session-token", subject: "desk" });
      yield* sessions.markConnected(paired.sessionId);
      yield* TestClock.adjust(Duration.days(2));
      const rotated = yield* sessions.rotate(paired.sessionId);
      yield* sessions.verify(rotated.token);

      const listed = yield* sessions.listActive();
      expect(listed.map((entry) => [entry.sessionId, entry.connected])).toEqual([
        [rotated.sessionId, true],
      ]);
      expect(listed[0]?.lastConnectedAt).not.toBeNull();

      yield* sessions.markDisconnected(paired.sessionId);
      expect((yield* sessions.listActive())[0]?.connected).toBe(false);
    }).pipe(Effect.provide(withClock())),
  );
});
