import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";
import type {
  HubConnectorStatus,
  HubEnrollmentCeremonyDetail,
  HubIdentitySummary,
} from "@ryco/contracts";

import { AuthControlPlane } from "../auth/Services/AuthControlPlane.ts";
import { ServerAuthLive } from "../auth/Layers/ServerAuth.ts";
import { ServerSecretStoreLive } from "../auth/Layers/ServerSecretStore.ts";
import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "../persistence/Layers/Sqlite.ts";
import { HubConnectorService, type HubConnectorE2eeOperator } from "./HubConnectorLive.ts";
import { hubConnectorRoutesLayer } from "./http.ts";
import {
  stubClientListing,
  stubE2eeOperator,
  stubLocalIntroductionService,
  stubNativeNodeClaimService,
} from "./testUtils/e2eeOperatorStub.ts";

const ONLINE_STATUS: HubConnectorStatus = {
  state: "online",
  transitionedAt: "1970-01-01T00:00:00.000Z",
  protocolMajor: 1,
  protocolMinor: 2,
  activeChannels: 2,
  queuedBytes: 0,
};

const REVOKED_STATUS: HubConnectorStatus = {
  state: "revoked",
  transitionedAt: "1970-01-01T00:00:00.000Z",
  failure: "authentication_failed",
  activeChannels: 0,
  queuedBytes: 0,
};

const DEGRADED_OPERATOR_STATUS: HubConnectorStatus = {
  state: "degraded",
  transitionedAt: "1970-01-01T00:00:00.000Z",
  degradedMode: "operator_action_required",
  failure: "connection_replaced",
  activeChannels: 0,
  queuedBytes: 0,
};

const CEREMONY: HubEnrollmentCeremonyDetail = {
  deviceCode: "ABCD-EFGH",
  fingerprint: `SHA256:${"A".repeat(43)}`,
  label: "Test Node",
  platformOs: "darwin",
  platformArch: "arm64",
  clientVersion: "0.0.0",
  algorithm: "ed25519",
  expiresAt: "1970-01-01T00:10:00.000Z",
  pollIntervalMs: 5_000,
};

interface ConnectorStub {
  /** Statuses returned in order; the last one repeats once exhausted. */
  readonly statuses: ReadonlyArray<HubConnectorStatus>;
  readonly resumeThrows?: boolean;
  readonly ceremony?: HubEnrollmentCeremonyDetail | null;
  readonly identity?: HubIdentitySummary;
  readonly e2ee?: Partial<HubConnectorE2eeOperator>;
}

const makeConnectorStub = (stub: ConnectorStub) => {
  let resumeCalls = 0;
  let statusIndex = 0;
  const service = {
    connectorEnabled: true,
    status: () => stub.statuses[Math.min(statusIndex, stub.statuses.length - 1)]!,
    resume: async () => {
      resumeCalls += 1;
      if (stub.resumeThrows) throw new Error("boom: origin https://hub.example.test node_abc123");
      // A real resume that does something advances the observable status; the
      // no-op cases (revoked, stopping, disabled) leave it where it was.
      statusIndex += 1;
    },
    enroll: async () => {
      throw new Error("not used");
    },
    identitySummary: async () => stub.identity ?? { enrolled: "none" as const },
    leave: async () => stub.statuses[0]!,
    readEnrollment: async () => stub.ceremony ?? null,
    cancelEnrollment: async () => stub.statuses[0]!,
    stop: async () => undefined,
    localIntroduction: stubLocalIntroductionService(),
    nativeNodeClaim: stubNativeNodeClaimService(),
    e2ee: stubE2eeOperator(stub.e2ee ?? {}),
  };
  return {
    service,
    resumeCalls: () => resumeCalls,
  };
};

const makeTestServerConfig = (baseDir: string, devUrl?: URL) =>
  Effect.gen(function* () {
    const derivedPaths = yield* deriveServerPaths(baseDir, devUrl);
    return {
      logLevel: "Info",
      traceMinLevel: "Info",
      traceTimingEnabled: true,
      traceBatchWindowMs: 0,
      traceMaxBytes: 1_000_000,
      traceMaxFiles: 2,
      otlpTracesUrl: undefined,
      otlpMetricsUrl: undefined,
      otlpExportIntervalMs: 60_000,
      otlpServiceName: "ryco-test",
      mode: "server",
      port: 0,
      host: "127.0.0.1",
      cwd: baseDir,
      baseDir,
      staticDir: undefined,
      devUrl,
      noBrowser: true,
      startupPresentation: "quiet",
      desktopBootstrapToken: undefined,
      autoBootstrapProjectFromCwd: false,
      logWebSocketEvents: false,
      tailscaleServeEnabled: false,
      tailscaleServePort: 443,
      ...derivedPaths,
    } as unknown as ServerConfigShape;
  });

const withHubRoutes = <A, E, R>(
  stub: ConnectorStub,
  run: (context: {
    readonly origin: string;
    readonly ownerToken: string;
    readonly clientToken: string;
    readonly resumeCalls: () => number;
  }) => Effect.Effect<A, E, R>,
  devUrl?: URL,
) =>
  Effect.gen(function* () {
    const baseDir = mkdtempSync(join(tmpdir(), "ryco-hub-http-test-"));
    const config = yield* makeTestServerConfig(baseDir, devUrl);
    const connector = makeConnectorStub(stub);

    const appLayer = HttpRouter.serve(hubConnectorRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(Layer.succeed(HubConnectorService, connector.service)),
      Layer.provideMerge(
        ServerAuthLive.pipe(
          Layer.provideMerge(SqlitePersistenceLayerLive),
          Layer.provide(ServerSecretStoreLive),
        ),
      ),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
      ),
      Layer.provideMerge(NodeServices.layer),
      Layer.provide(Layer.succeed(ServerConfig, config)),
    );

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) {
          assert.fail(`Expected a TCP address, got ${String(address)}`);
        }
        const authControlPlane = yield* AuthControlPlane;
        const owner = yield* authControlPlane.issueSession({ role: "owner", label: "test owner" });
        const client = yield* authControlPlane.issueSession({
          role: "client",
          label: "test client",
        });
        return yield* run({
          origin: `http://127.0.0.1:${address.port}`,
          ownerToken: owner.token,
          clientToken: client.token,
          resumeCalls: connector.resumeCalls,
        });
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

const post = (origin: string, path: string, token?: string, requestOrigin?: string) =>
  Effect.promise(() =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
        ...(requestOrigin === undefined ? {} : { Origin: requestOrigin }),
      },
    }),
  );

/**
 * Every E2EE operator route, enumerated so the auth envelope is asserted over
 * the whole surface rather than over the members a test happened to name.
 *
 * `/clients/read` is a POST that mutates nothing — the record key it carries
 * does not belong in a URL — so it is a mutation for the purposes of the
 * cross-origin rule and is listed here.
 */
const E2EE_READ_PATHS = [
  "/api/hub/e2ee/clients",
  "/api/hub/e2ee/sessions",
  "/api/hub/e2ee/policy",
  "/api/hub/e2ee/prekey",
  "/api/hub/e2ee/continuity",
  "/api/hub/e2ee/fallback",
] as const;

const E2EE_MUTATION_PATHS = [
  "/api/hub/e2ee/clients/read",
  "/api/hub/e2ee/clients/approval-qr",
  "/api/hub/e2ee/clients/authorization",
  "/api/hub/e2ee/clients/pairing-window",
  "/api/hub/e2ee/clients/refusals/clear",
  "/api/hub/e2ee/policy",
  "/api/hub/e2ee/policy/preview",
  "/api/hub/e2ee/policy/recover",
  "/api/hub/e2ee/prekey/rotate",
  "/api/hub/e2ee/continuity",
  "/api/hub/e2ee/fallback/reset",
] as const;

const get = (origin: string, path: string, token?: string) =>
  Effect.promise(() =>
    fetch(`${origin}${path}`, {
      headers: token === undefined ? {} : { Authorization: `Bearer ${token}` },
    }),
  );

it.layer(NodeServices.layer)("hub connector http routes", (it) => {
  it.effect("resume returns the resulting status to an owner session", () =>
    withHubRoutes(
      { statuses: [DEGRADED_OPERATOR_STATUS, ONLINE_STATUS] },
      ({ origin, ownerToken, resumeCalls }) =>
        Effect.gen(function* () {
          const response = yield* post(origin, "/api/hub/resume", ownerToken);
          assert.equal(response.status, 200);
          const body = (yield* Effect.promise(() => response.json())) as HubConnectorStatus;
          assert.equal(body.state, "online");
          assert.equal(resumeCalls(), 1);
        }),
    ),
  );

  it.effect("resume is idempotent and never throws on a repeated call", () =>
    withHubRoutes(
      { statuses: [DEGRADED_OPERATOR_STATUS, ONLINE_STATUS] },
      ({ origin, ownerToken, resumeCalls }) =>
        Effect.gen(function* () {
          const first = yield* post(origin, "/api/hub/resume", ownerToken);
          const second = yield* post(origin, "/api/hub/resume", ownerToken);
          assert.equal(first.status, 200);
          assert.equal(second.status, 200);
          const body = (yield* Effect.promise(() => second.json())) as HubConnectorStatus;
          assert.equal(body.state, "online");
          assert.equal(resumeCalls(), 2);
        }),
    ),
  );

  // `resume()` deliberately early-returns for a revoked connector. The route must
  // report the unchanged terminal state rather than implying it acted, because the
  // settings panel relies on this to keep saying "will not retry".
  it.effect("resume leaves a revoked connector revoked", () =>
    withHubRoutes({ statuses: [REVOKED_STATUS] }, ({ origin, ownerToken }) =>
      Effect.gen(function* () {
        const response = yield* post(origin, "/api/hub/resume", ownerToken);
        assert.equal(response.status, 200);
        const body = (yield* Effect.promise(() => response.json())) as HubConnectorStatus;
        assert.equal(body.state, "revoked");
      }),
    ),
  );

  it.effect("resume reports a bounded failure and never echoes the underlying error", () =>
    withHubRoutes(
      { statuses: [DEGRADED_OPERATOR_STATUS], resumeThrows: true },
      ({ origin, ownerToken }) =>
        Effect.gen(function* () {
          const response = yield* post(origin, "/api/hub/resume", ownerToken);
          assert.equal(response.status, 400);
          const text = yield* Effect.promise(() => response.text());
          assert.isFalse(text.includes("hub.example.test"), "response leaked an origin");
          assert.isFalse(text.includes("node_abc123"), "response leaked a node identifier");
          assert.isFalse(text.includes("boom"), "response leaked raw error text");
        }),
    ),
  );

  // The case the whole route exists for: status cannot distinguish these two, so
  // a panel gating the origin field on status alone would offer to re-point a
  // node that is already enrolled.
  it.effect("identity reports active while the connector is disabled", () =>
    withHubRoutes(
      {
        statuses: [
          {
            state: "disabled",
            transitionedAt: "1970-01-01T00:00:00.000Z",
            activeChannels: 0,
            queuedBytes: 0,
          },
        ],
        identity: { enrolled: "active" },
      },
      ({ origin, ownerToken }) =>
        Effect.gen(function* () {
          const status = yield* get(origin, "/api/hub/status", ownerToken);
          const identity = yield* get(origin, "/api/hub/identity", ownerToken);
          const statusBody = (yield* Effect.promise(() => status.json())) as HubConnectorStatus;
          const identityBody = (yield* Effect.promise(() => identity.json())) as HubIdentitySummary;

          assert.equal(statusBody.state, "disabled");
          assert.deepEqual(identityBody, { enrolled: "active" });
        }),
    ),
  );

  it.effect("identity reports every phase and nothing else", () =>
    Effect.gen(function* () {
      for (const enrolled of ["none", "pending", "active", "unknown"] as const) {
        yield* withHubRoutes(
          { statuses: [ONLINE_STATUS], identity: { enrolled } },
          ({ origin, ownerToken }) =>
            Effect.gen(function* () {
              const response = yield* get(origin, "/api/hub/identity", ownerToken);
              assert.equal(response.status, 200);
              const body = (yield* Effect.promise(() => response.json())) as Record<
                string,
                unknown
              >;
              assert.deepEqual(body, { enrolled });
              assert.deepEqual(Object.keys(body), ["enrolled"]);
            }),
        );
      }
    }),
  );

  // Regression: a fresh install has the connector disabled, so the full identity
  // runtime is never constructed. If that reported "unknown", the panel would
  // treat the node as possibly-enrolled, lock the Hub address field and offer a
  // Leave button — making the feature impossible to configure at all.
  it.effect("reports a never-enrolled node as none, not unknown", () =>
    withHubRoutes(
      {
        statuses: [
          {
            state: "disabled",
            transitionedAt: "1970-01-01T00:00:00.000Z",
            activeChannels: 0,
            queuedBytes: 0,
          },
        ],
        identity: { enrolled: "none" },
      },
      ({ origin, ownerToken }) =>
        Effect.gen(function* () {
          const response = yield* get(origin, "/api/hub/identity", ownerToken);
          const body = (yield* Effect.promise(() => response.json())) as HubIdentitySummary;
          assert.equal(body.enrolled, "none");
        }),
    ),
  );

  it.effect("a pending ceremony is re-readable after the start response is lost", () =>
    withHubRoutes({ statuses: [ONLINE_STATUS], ceremony: CEREMONY }, ({ origin, ownerToken }) =>
      Effect.gen(function* () {
        const response = yield* get(origin, "/api/hub/enrollment", ownerToken);
        assert.equal(response.status, 200);
        const body = (yield* Effect.promise(() => response.json())) as HubEnrollmentCeremonyDetail;
        assert.deepEqual(body, CEREMONY);
      }),
    ),
  );

  // The node and the approval screen are compared side by side, so the node must
  // publish every field the approver is asked to check — no more, no fewer.
  it.effect("the ceremony carries exactly the comparable fields", () =>
    withHubRoutes({ statuses: [ONLINE_STATUS], ceremony: CEREMONY }, ({ origin, ownerToken }) =>
      Effect.gen(function* () {
        const response = yield* get(origin, "/api/hub/enrollment", ownerToken);
        const body = (yield* Effect.promise(() => response.json())) as Record<string, unknown>;
        assert.deepEqual(Object.keys(body).toSorted(), [
          "algorithm",
          "clientVersion",
          "deviceCode",
          "expiresAt",
          "fingerprint",
          "label",
          "platformArch",
          "platformOs",
          "pollIntervalMs",
        ]);
      }),
    ),
  );

  it.effect("reading with no ceremony pending is a bounded 404", () =>
    withHubRoutes({ statuses: [ONLINE_STATUS], ceremony: null }, ({ origin, ownerToken }) =>
      Effect.gen(function* () {
        const response = yield* get(origin, "/api/hub/enrollment", ownerToken);
        assert.equal(response.status, 404);
        const text = yield* Effect.promise(() => response.text());
        assert.isFalse(text.includes("node_"), "404 leaked a node identifier");
        assert.isFalse(text.includes("http"), "404 leaked an origin");
      }),
    ),
  );

  it.effect("leave returns the resulting status to an owner session", () =>
    withHubRoutes({ statuses: [REVOKED_STATUS] }, ({ origin, ownerToken }) =>
      Effect.gen(function* () {
        const response = yield* post(origin, "/api/hub/leave", ownerToken);
        assert.equal(response.status, 200);
        const body = (yield* Effect.promise(() => response.json())) as HubConnectorStatus;
        assert.equal(body.state, "revoked");
      }),
    ),
  );

  // SameSite=Lax does not separate loopback ports: "site" ignores the port, so a
  // page served from any other port on 127.0.0.1 is same-site with this backend
  // and its POSTs carry the session cookie. A bodyless POST is also a CORS simple
  // request, so it is never preflighted — the attacker cannot read the reply, but
  // the operation still runs. That is enough to erase this node's Hub key.
  it.effect("refuses a state-changing request from another local origin", () =>
    withHubRoutes({ statuses: [ONLINE_STATUS] }, ({ origin, ownerToken, resumeCalls }) =>
      Effect.gen(function* () {
        const attacker = "http://127.0.0.1:59999";
        for (const path of [
          "/api/hub/leave",
          "/api/hub/resume",
          "/api/hub/enrollment",
          "/api/hub/enrollment/cancel",
          ...E2EE_MUTATION_PATHS,
        ]) {
          const response = yield* post(origin, path, ownerToken, attacker);
          assert.equal(response.status, 403, `${path} accepted a cross-origin mutation`);
        }
        assert.equal(resumeCalls(), 0, "a cross-origin request reached the connector");
      }),
    ),
  );

  it.effect("accepts only the exact configured development renderer origin", () => {
    const devUrl = new URL("http://127.0.0.1:5173");
    return withHubRoutes(
      { statuses: [ONLINE_STATUS] },
      ({ origin, ownerToken, resumeCalls }) =>
        Effect.gen(function* () {
          const configuredRenderer = yield* post(
            origin,
            "/api/hub/resume",
            ownerToken,
            devUrl.origin,
          );
          const otherLoopbackOrigin = yield* post(
            origin,
            "/api/hub/resume",
            ownerToken,
            "http://127.0.0.1:5174",
          );

          assert.equal(configuredRenderer.status, 200);
          assert.equal(otherLoopbackOrigin.status, 403);
          assert.equal(resumeCalls(), 1, "an unconfigured origin reached the connector");
        }),
      devUrl,
    );
  });

  it.effect("still accepts a same-origin request, and a CLI request with no Origin", () =>
    withHubRoutes({ statuses: [ONLINE_STATUS] }, ({ origin, ownerToken, resumeCalls }) =>
      Effect.gen(function* () {
        // The packaged desktop renderer is same-origin with the backend and sends
        // Origin on POST; the CLI authenticates with a bearer token and sends none.
        const sameOrigin = yield* post(origin, "/api/hub/resume", ownerToken, origin);
        const noOrigin = yield* post(origin, "/api/hub/resume", ownerToken);
        assert.equal(sameOrigin.status, 200);
        assert.equal(noOrigin.status, 200);
        assert.equal(resumeCalls(), 2);
      }),
    ),
  );

  it.effect("every hub route rejects a non-owner session", () =>
    withHubRoutes({ statuses: [ONLINE_STATUS] }, ({ origin, clientToken, resumeCalls }) =>
      Effect.gen(function* () {
        const status = yield* get(origin, "/api/hub/status", clientToken);
        const read = yield* get(origin, "/api/hub/enrollment", clientToken);
        const identity = yield* get(origin, "/api/hub/identity", clientToken);
        const leave = yield* post(origin, "/api/hub/leave", clientToken);
        const resume = yield* post(origin, "/api/hub/resume", clientToken);
        const enrollment = yield* post(origin, "/api/hub/enrollment", clientToken);
        const cancel = yield* post(origin, "/api/hub/enrollment/cancel", clientToken);

        assert.equal(status.status, 403);
        assert.equal(read.status, 403);
        assert.equal(identity.status, 403);
        assert.equal(leave.status, 403);
        assert.equal(resume.status, 403);
        assert.equal(enrollment.status, 403);
        assert.equal(cancel.status, 403);
        for (const path of E2EE_READ_PATHS) {
          const response = yield* get(origin, path, clientToken);
          assert.equal(response.status, 403, `${path} served a non-owner session`);
        }
        for (const path of E2EE_MUTATION_PATHS) {
          const response = yield* post(origin, path, clientToken);
          assert.equal(response.status, 403, `${path} served a non-owner session`);
        }
        assert.equal(resumeCalls(), 0, "resume ran despite a rejected session");
      }),
    ),
  );

  it.effect("every hub route rejects an unauthenticated request", () =>
    withHubRoutes({ statuses: [ONLINE_STATUS] }, ({ origin, resumeCalls }) =>
      Effect.gen(function* () {
        const status = yield* get(origin, "/api/hub/status");
        const read = yield* get(origin, "/api/hub/enrollment");
        const identity = yield* get(origin, "/api/hub/identity");
        const leave = yield* post(origin, "/api/hub/leave");
        const resume = yield* post(origin, "/api/hub/resume");
        const enrollment = yield* post(origin, "/api/hub/enrollment");
        const cancel = yield* post(origin, "/api/hub/enrollment/cancel");
        const e2eeReads = yield* Effect.forEach(E2EE_READ_PATHS, (path) => get(origin, path));
        const e2eeMutations = yield* Effect.forEach(E2EE_MUTATION_PATHS, (path) =>
          post(origin, path),
        );

        for (const response of [
          status,
          read,
          identity,
          leave,
          resume,
          enrollment,
          cancel,
          ...e2eeReads,
          ...e2eeMutations,
        ]) {
          assert.isTrue(
            response.status === 401 || response.status === 403,
            `expected an auth rejection, got ${response.status}`,
          );
        }
        assert.equal(resumeCalls(), 0, "resume ran without authentication");
      }),
    ),
  );

  it.effect("serves the E2EE operator surface to an owner and never a raw key", () =>
    withHubRoutes(
      {
        statuses: [ONLINE_STATUS],
        e2ee: {
          listClients: async () =>
            stubClientListing({ pendingGlobalSaturated: true, refusedPairingAttempts: 4 }),
        },
      },
      ({ origin, ownerToken }) =>
        Effect.gen(function* () {
          const clients = yield* get(origin, "/api/hub/e2ee/clients", ownerToken);
          assert.equal(clients.status, 200);
          const body = yield* Effect.promise(() => clients.text());
          assert.isTrue(body.includes("SHA256:"), "the listing dropped the fingerprint");
          // §13.6: raw keys are never displayed and never stored, and the
          // listing's instrumentation duties travel with it.
          assert.isFalse(body.includes("publicKey"), "the listing leaked a key");
          assert.isTrue(body.includes("pendingGlobalSaturated"));
          assert.isTrue(body.includes("refusedPairingAttempts"));

          const policy = yield* get(origin, "/api/hub/e2ee/policy", ownerToken);
          const sessions = yield* get(origin, "/api/hub/e2ee/sessions", ownerToken);
          const fallback = yield* get(origin, "/api/hub/e2ee/fallback", ownerToken);
          assert.equal(policy.status, 200);
          assert.equal(sessions.status, 200);
          assert.equal(fallback.status, 200);

          // §12.5: the report carries no account, channel, session, or key
          // identifier, because none is stored.
          const fallbackBody = yield* Effect.promise(() => fallback.text());
          assert.isFalse(fallbackBody.includes("originHash"));
          assert.isFalse(fallbackBody.includes("channel"));
        }),
    ),
  );

  it.effect("bounds every E2EE operator failure to one message that names no record", () =>
    withHubRoutes(
      {
        statuses: [ONLINE_STATUS],
        e2ee: {
          revokeClient: async () => {
            throw new Error(
              "boom: no record for acct_secret SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA at /Users/owner/state",
            );
          },
        },
      },
      ({ origin, ownerToken }) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            fetch(`${origin}/api/hub/e2ee/clients/authorization`, {
              method: "POST",
              headers: {
                Authorization: `Bearer ${ownerToken}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({
                action: "revoke",
                hubOrigin: "https://hub.example.test",
                accountId: "acct_secret",
                fingerprint: `SHA256:${"A".repeat(43)}`,
              }),
            }),
          );
          const text = yield* Effect.promise(() => response.text());
          assert.equal(response.status, 400);
          assert.isFalse(text.includes("acct_secret"), "the failure echoed an account id");
          assert.isFalse(text.includes("SHA256:"), "the failure echoed a fingerprint");
          assert.isFalse(text.includes("/Users/"), "the failure echoed a path");
          assert.isFalse(text.includes("boom"), "the failure echoed the underlying error");
        }),
    ),
  );

  it.effect("a rejection body names no origin, identifier, or route detail", () =>
    withHubRoutes({ statuses: [ONLINE_STATUS] }, ({ origin, clientToken }) =>
      Effect.gen(function* () {
        const response = yield* post(origin, "/api/hub/resume", clientToken);
        const text = yield* Effect.promise(() => response.text());
        assert.isFalse(text.includes("127.0.0.1"), "rejection leaked a host");
        assert.isFalse(text.includes("node_"), "rejection leaked a node identifier");
        assert.isFalse(text.includes("env_"), "rejection leaked an environment identifier");
      }),
    ),
  );
});
