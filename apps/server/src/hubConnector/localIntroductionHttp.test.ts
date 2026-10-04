import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  LOCAL_INTRODUCTION_COMPLETE_PATH,
  LOCAL_INTRODUCTION_CONTROL_HEADER,
  LOCAL_INTRODUCTION_DESCRIPTOR_PATH,
} from "@ryco/contracts/local-introduction";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import { NodeLocalIntroductionError } from "../hubIdentity/NodeLocalIntroductionService.ts";
import { HubConnectorService, type HubConnectorServiceShape } from "./HubConnectorLive.ts";
import {
  desktopLocalControlIsAuthorized,
  desktopLocalIntroductionRoutesLayer,
} from "./localIntroductionHttp.ts";
import {
  stubE2eeOperator,
  stubLocalIntroductionService,
  stubNativeNodeClaimService,
} from "./testUtils/e2eeOperatorStub.ts";

const TOKEN = "A".repeat(43);
const OTHER_TOKEN = "B".repeat(43);
const NODE_PUBLIC = Uint8Array.from({ length: 32 }, (_, index) => index);
const NODE_FINGERPRINT = Uint8Array.from({ length: 32 }, (_, index) => 0xff - index);

function service(
  localIntroduction: HubConnectorServiceShape["localIntroduction"],
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
    resume: async () => undefined,
    enroll: async () => {
      throw new Error("unused");
    },
    readEnrollment: async () => null,
    identitySummary: async () => ({ enrolled: "active" }),
    leave: async () => status,
    cancelEnrollment: async () => status,
    stop: async () => undefined,
    localIntroduction,
    nativeNodeClaim: stubNativeNodeClaimService(),
    e2ee: stubE2eeOperator(),
  };
}

const withRoutes = <A, E, R>(
  input: {
    readonly localIntroduction?: HubConnectorServiceShape["localIntroduction"];
    readonly mode?: ServerConfigShape["mode"];
    readonly host?: string;
    readonly token?: string | undefined;
  },
  run: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const baseDir = mkdtempSync(join(tmpdir(), "ryco-local-introduction-http-"));
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    const config = {
      mode: input.mode ?? "desktop",
      host: input.host ?? "127.0.0.1",
      desktopControlToken: input.token === undefined ? TOKEN : input.token,
      ...derivedPaths,
    } as unknown as ServerConfigShape;
    const localIntroduction =
      input.localIntroduction ??
      stubLocalIntroductionService({
        descriptor: async () => ({
          hubOrigin: "https://hub.example.test",
          environmentId: `env_${"C".repeat(22)}`,
          nodeId: `node_${"D".repeat(22)}`,
          nodeIdentityPublicKey: NODE_PUBLIC,
          nodeIdentityFingerprint: NODE_FINGERPRINT,
          nodeContinuityId: `nct_${"E".repeat(22)}`,
          nodePolicyGeneration: 7,
        }),
      });
    const appLayer = HttpRouter.serve(desktopLocalIntroductionRoutesLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(Layer.succeed(HubConnectorService, service(localIntroduction))),
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
        if (typeof address === "string" || !("port" in address)) {
          assert.fail("expected TCP listener");
        }
        return yield* run(`http://127.0.0.1:${address.port}`);
      }).pipe(Effect.provide(Layer.mergeAll(appLayer, NodeServices.layer))),
    );
  });

function post(
  origin: string,
  path: string,
  options: {
    readonly token?: string;
    readonly originHeader?: string;
    readonly body?: string;
    readonly contentType?: string;
  } = {},
) {
  return Effect.promise(() =>
    fetch(`${origin}${path}`, {
      method: "POST",
      headers: {
        ...(options.token === undefined
          ? {}
          : { [LOCAL_INTRODUCTION_CONTROL_HEADER]: options.token }),
        ...(options.originHeader === undefined ? {} : { Origin: options.originHeader }),
        ...(options.contentType === undefined ? {} : { "Content-Type": options.contentType }),
      },
      ...(options.body === undefined ? {} : { body: options.body }),
    }),
  );
}

it.layer(NodeServices.layer)("Desktop Local Trusted Introduction HTTP control", (it) => {
  it.effect("serves the descriptor only to the exact per-child control credential", () =>
    withRoutes({}, (origin) =>
      Effect.gen(function* () {
        const response = yield* post(origin, LOCAL_INTRODUCTION_DESCRIPTOR_PATH, { token: TOKEN });
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        const body = yield* Effect.promise(() => response.json());
        assert.deepEqual(body, {
          protocolVersion: 1,
          hubOrigin: "https://hub.example.test",
          environmentId: `env_${"C".repeat(22)}`,
          nodeId: `node_${"D".repeat(22)}`,
          nodeIdentityPublicKey: Buffer.from(NODE_PUBLIC).toString("base64url"),
          nodeIdentityFingerprint: Buffer.from(NODE_FINGERPRINT).toString("base64url"),
          nodeContinuityId: `nct_${"E".repeat(22)}`,
          nodePolicyGeneration: 7,
        });

        for (const options of [
          {},
          { token: OTHER_TOKEN },
          { token: TOKEN, originHeader: origin },
        ]) {
          const refused = yield* post(origin, LOCAL_INTRODUCTION_DESCRIPTOR_PATH, options);
          assert.equal(refused.status, 404);
        }
      }),
    ),
  );

  it.effect("decodes a bounded completion and returns only the public approval", () => {
    let observed: { requestTbs: Uint8Array; requestSignature: Uint8Array } | undefined;
    const requestTbs = Uint8Array.from([1, 2, 3, 4]);
    const requestSignature = Uint8Array.from({ length: 64 }, (_, index) => index);
    return withRoutes(
      {
        localIntroduction: stubLocalIntroductionService({
          complete: async (input) => {
            observed = input;
            return {
              disposition: "promoted",
              approvalTbs: Uint8Array.from([5, 6, 7]),
              approvalSignature: Uint8Array.from({ length: 64 }, () => 8),
            };
          },
        }),
      },
      (origin) =>
        Effect.gen(function* () {
          const response = yield* post(origin, LOCAL_INTRODUCTION_COMPLETE_PATH, {
            token: TOKEN,
            contentType: "application/json",
            body: JSON.stringify({
              requestTbs: Buffer.from(requestTbs).toString("base64url"),
              requestSignature: Buffer.from(requestSignature).toString("base64url"),
            }),
          });
          assert.equal(response.status, 200);
          assert.deepEqual(observed, { requestTbs, requestSignature });
          const body = yield* Effect.promise(() => response.json());
          assert.deepEqual(body, {
            protocolVersion: 1,
            disposition: "promoted",
            approvalTbs: "BQYH",
            approvalSignature: Buffer.alloc(64, 8).toString("base64url"),
          });
        }),
    );
  });

  it.effect("refuses non-JSON bodies before the introduction service", () => {
    let calls = 0;
    return withRoutes(
      {
        localIntroduction: stubLocalIntroductionService({
          complete: async () => {
            calls += 1;
            throw new Error("must not run");
          },
        }),
      },
      (origin) =>
        Effect.gen(function* () {
          const response = yield* post(origin, LOCAL_INTRODUCTION_COMPLETE_PATH, {
            token: TOKEN,
            contentType: "text/plain",
            body: "{}",
          });
          assert.equal(response.status, 400);
          assert.equal(calls, 0);
        }),
    );
  });

  it.effect("maps protocol failures to stable codes without echoing raw errors", () =>
    withRoutes(
      {
        localIntroduction: stubLocalIntroductionService({
          descriptor: async () => {
            throw new NodeLocalIntroductionError("local_introduction_conflict");
          },
        }),
      },
      (origin) =>
        Effect.gen(function* () {
          const response = yield* post(origin, LOCAL_INTRODUCTION_DESCRIPTOR_PATH, {
            token: TOKEN,
          });
          assert.equal(response.status, 409);
          const body = yield* Effect.promise(() => response.json());
          assert.deepEqual(body, { error: "local_introduction_conflict" });
        }),
    ),
  );
});

it("requires Desktop mode, a loopback listener/source, no browser Origin, and the exact token", () => {
  const baseline = {
    mode: "desktop",
    bindHost: "127.0.0.1",
    configuredToken: TOKEN,
    presentedToken: TOKEN,
    origin: undefined,
    remoteAddress: "::ffff:127.0.0.1",
  } as const;
  assert.isTrue(desktopLocalControlIsAuthorized(baseline));
  assert.isFalse(desktopLocalControlIsAuthorized({ ...baseline, mode: "web" }));
  assert.isFalse(desktopLocalControlIsAuthorized({ ...baseline, bindHost: "0.0.0.0" }));
  assert.isFalse(
    desktopLocalControlIsAuthorized({
      ...baseline,
      remoteAddress: "192.0.2.2",
    }),
  );
  assert.isFalse(
    desktopLocalControlIsAuthorized({
      ...baseline,
      origin: "http://127.0.0.1",
    }),
  );
  assert.isFalse(
    desktopLocalControlIsAuthorized({
      ...baseline,
      presentedToken: OTHER_TOKEN,
    }),
  );
  assert.isFalse(desktopLocalControlIsAuthorized({ ...baseline, remoteAddress: undefined }));
  assert.isTrue(
    desktopLocalControlIsAuthorized({
      ...baseline,
      remoteAddress: undefined,
      allowMissingRemoteAddress: true,
    }),
  );
  assert.isFalse(
    desktopLocalControlIsAuthorized({
      ...baseline,
      bindHost: "0.0.0.0",
      remoteAddress: undefined,
      allowMissingRemoteAddress: true,
    }),
  );
});
