import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH,
} from "@ryco/contracts/desktop-native-node-claim";
import type {
  NativeNodeClaimFinishResponse,
  NativeNodeClaimStartResponse,
} from "@ryco/contracts/hosted-identity";
import { LOCAL_INTRODUCTION_CONTROL_HEADER } from "@ryco/contracts/local-introduction";
import { Effect, Layer } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import {
  ServerEnvironment,
  type ServerEnvironmentShape,
} from "../environment/Services/ServerEnvironment.ts";
import type { NodeNativeClaimService } from "../hubIdentity/NodeNativeClaimService.ts";
import { desktopNativeNodeClaimRoutesLayer } from "./desktopNativeNodeClaimHttp.ts";
import { HubConnectorService, type HubConnectorServiceShape } from "./HubConnectorLive.ts";
import {
  stubE2eeOperator,
  stubLocalIntroductionService,
  stubNativeNodeClaimService,
} from "./testUtils/e2eeOperatorStub.ts";

const TOKEN = "A".repeat(43);
const HUB_ORIGIN = "https://hub.example.test";
const ENVIRONMENT_ID = "env_aaaaaaaaaaaaaaaaaaaaaa";
const NODE_PUBLIC = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
const NODE_FINGERPRINT = Uint8Array.from({ length: 32 }, (_, index) => 0xff - index);

const claim = {
  protocolVersion: 1,
  transcriptVersion: 1,
  claimId: "nclaim_aaaaaaaaaaaaaaaaaaaaaa",
  challenge: Buffer.alloc(32, 3).toString("base64url"),
  accountId: "acct_aaaaaaaaaaaaaaaaaaaaaa",
  spaceId: "space_aaaaaaaaaaaaaaaaaaaaaa",
  sessionId: "sess_aaaaaaaaaaaaaaaaaaaaaa",
  dpopKeyThumbprint: Buffer.alloc(32, 4).toString("base64url"),
  installationId: "install_aaaaaaaaaaaaaaaaaaaaaa",
  environmentId: ENVIRONMENT_ID,
  nodeFingerprint: `SHA256:${Buffer.from(NODE_FINGERPRINT).toString("base64url")}`,
  issuedAt: 1_752_710_400_000,
  expiresAt: 1_752_710_700_000,
} as unknown as NativeNodeClaimStartResponse;

const result = {
  status: "claimed",
  disposition: "created",
  node: {
    id: "node_aaaaaaaaaaaaaaaaaaaaaa",
    activeKeyId: "nkey_aaaaaaaaaaaaaaaaaaaaaa",
    environmentId: ENVIRONMENT_ID,
    label: "Studio Mac",
    fingerprint: claim.nodeFingerprint,
    effectiveRole: "owner",
  },
} as unknown as NativeNodeClaimFinishResponse;

function connector(
  nativeNodeClaim: NodeNativeClaimService,
  onResume: () => void = () => undefined,
): HubConnectorServiceShape {
  const status = {
    state: "online" as const,
    transitionedAt: "1970-01-01T00:00:00.000Z",
    activeChannels: 0,
    queuedBytes: 0,
  };
  return {
    connectorEnabled: true,
    status: () => status,
    resume: async () => onResume(),
    enroll: async () => {
      throw new Error("unused");
    },
    readEnrollment: async () => null,
    identitySummary: async () => ({ enrolled: "active" }),
    leave: async () => status,
    cancelEnrollment: async () => status,
    stop: async () => undefined,
    localIntroduction: stubLocalIntroductionService(),
    nativeNodeClaim,
    e2ee: stubE2eeOperator(),
  };
}

const environment = {
  getEnvironmentId: Effect.succeed(ENVIRONMENT_ID as never),
  getDescriptor: Effect.succeed({
    environmentId: ENVIRONMENT_ID,
    label: "Studio Mac",
    platform: { os: "darwin", arch: "arm64" },
    serverVersion: "0.1.8",
    capabilities: {},
  } as never),
} satisfies ServerEnvironmentShape;

const withRoutes = <A, E, R>(
  nativeNodeClaim: NodeNativeClaimService,
  run: (origin: string) => Effect.Effect<A, E, R>,
  onResume?: () => void,
) =>
  Effect.gen(function* () {
    const baseDir = mkdtempSync(join(tmpdir(), "ryco-native-node-claim-http-"));
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    const config = {
      mode: "desktop",
      host: "127.0.0.1",
      desktopControlToken: TOKEN,
      hubConnector: {
        enabled: true,
        origin: HUB_ORIGIN,
        nodeName: "Studio Mac",
        reconnectBaseMs: 1_000,
        reconnectMaxMs: 60_000,
        reconnectStableMs: 60_000,
        reconnectJitterRatio: 0.2,
        allowFileSecretStore: false,
        configurationIssue: undefined,
      },
      ...derivedPaths,
    } as unknown as ServerConfigShape;
    const appLayer = HttpRouter.serve(desktopNativeNodeClaimRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(Layer.succeed(HubConnectorService, connector(nativeNodeClaim, onResume))),
      Layer.provide(Layer.succeed(ServerEnvironment, environment)),
      Layer.provide(Layer.succeed(ServerConfig, config)),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, {
          host: "127.0.0.1",
          port: 0,
        }),
      ),
      Layer.provideMerge(NodeServices.layer),
    );
    return yield* Effect.scoped(
      Effect.gen(function* () {
        const server = yield* HttpServer.HttpServer;
        const address = server.address;
        if (typeof address === "string" || !("port" in address)) assert.fail("expected listener");
        return yield* run(`http://127.0.0.1:${address.port}`);
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

function post(origin: string, path: string, body?: unknown, token = TOKEN) {
  return Effect.promise(() =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        [LOCAL_INTRODUCTION_CONTROL_HEADER]: token,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
}

it.layer(NodeServices.layer)("Desktop automatic native node-claim HTTP control", (it) => {
  it.effect("returns exact child metadata only to Desktop's private control token", () =>
    withRoutes(
      stubNativeNodeClaimService({
        prepare: async () => ({
          state: "prepared",
          hubOrigin: HUB_ORIGIN,
          environmentId: ENVIRONMENT_ID,
          algorithm: "ed25519",
          publicKey: NODE_PUBLIC,
          fingerprint: NODE_FINGERPRINT,
        }),
      }),
      (origin) =>
        Effect.gen(function* () {
          const response = yield* post(origin, DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH);
          assert.equal(response.status, 200);
          assert.equal(response.headers.get("cache-control"), "no-store");
          assert.deepEqual(yield* Effect.promise(() => response.json()), {
            protocolVersion: 1,
            state: "prepared",
            hubOrigin: HUB_ORIGIN,
            environmentId: ENVIRONMENT_ID,
            label: "Studio Mac",
            platformOs: "darwin",
            platformArch: "arm64",
            clientVersion: "0.1.8",
            algorithm: "ed25519",
            publicKey: Buffer.from(NODE_PUBLIC).toString("base64url"),
            fingerprint: claim.nodeFingerprint,
          });
          assert.equal(
            (yield* post(
              origin,
              DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH,
              undefined,
              "B".repeat(43),
            )).status,
            404,
          );
        }),
    ),
  );

  it.effect("signs and commits only the strict public claim envelopes", () => {
    let committed = false;
    let resumed = false;
    return withRoutes(
      stubNativeNodeClaimService({
        sign: async (input) => {
          assert.deepEqual(input, { hubOrigin: HUB_ORIGIN, claim });
          return Uint8Array.from({ length: 64 }, () => 7);
        },
        commit: async (input) => {
          assert.deepEqual(input, {
            hubOrigin: HUB_ORIGIN,
            expectedLabel: "Studio Mac",
            claim,
            result,
          });
          committed = true;
          return {
            hubOrigin: HUB_ORIGIN,
            nodeId: result.node.id,
            activeKeyId: result.node.activeKeyId,
            activeKeySecretName: "node-key.fixture",
            cleanupPollingSecretName: null,
            enrolledAt: claim.issuedAt,
          };
        },
      }),
      (origin) =>
        Effect.gen(function* () {
          const signed = yield* post(origin, DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH, { claim });
          assert.equal(signed.status, 200);
          assert.deepEqual(yield* Effect.promise(() => signed.json()), {
            protocolVersion: 1,
            signature: Buffer.alloc(64, 7).toString("base64url"),
          });
          const committedResponse = yield* post(origin, DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH, {
            claim,
            result,
          });
          assert.equal(committedResponse.status, 200);
          assert.isTrue(committed);
          assert.isTrue(resumed);
          assert.deepEqual(yield* Effect.promise(() => committedResponse.json()), {
            protocolVersion: 1,
            status: "active",
            result,
          });
        }),
      () => {
        resumed = true;
      },
    );
  });

  it.effect("acknowledges a durable claim when the opportunistic connector wake fails", () => {
    let committed = false;
    return withRoutes(
      stubNativeNodeClaimService({
        commit: async () => {
          committed = true;
          return {
            hubOrigin: HUB_ORIGIN,
            nodeId: result.node.id,
            activeKeyId: result.node.activeKeyId,
            activeKeySecretName: "node-key.fixture",
            cleanupPollingSecretName: null,
            enrolledAt: claim.issuedAt,
          };
        },
      }),
      (origin) =>
        Effect.gen(function* () {
          const response = yield* post(origin, DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH, {
            claim,
            result,
          });
          assert.isTrue(committed);
          assert.equal(response.status, 200);
          assert.deepEqual(yield* Effect.promise(() => response.json()), {
            protocolVersion: 1,
            status: "active",
            result,
          });
        }),
      () => {
        throw new Error("concurrent relay reconnect");
      },
    );
  });
});
