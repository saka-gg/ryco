import { generateKeyPairSync, sign } from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DIRECT_ROUTE_IDENTITY_PATH } from "@ryco/contracts/direct-route-identity";
import {
  encodeDirectRouteIdentityTranscript,
  verifyDirectRouteIdentityProof,
} from "@ryco/shared/directRouteIdentity";
import { Effect, Layer } from "effect";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { AdvertisedEndpointRegistry } from "../remote/Services/AdvertisedEndpointRegistry.ts";
import { makeDirectRouteIdentityRouteLayer } from "./directRouteIdentityHttp.ts";
import { makeProofPacer } from "./directRouteIdentityProof.ts";
import { hubConnectorReadyLayer, type HubConnectorServiceShape } from "./HubConnectorService.ts";

const nodeKey = generateKeyPairSync("ed25519");
const nodeIdentityPublicKey = Uint8Array.from(
  nodeKey.publicKey.export({ format: "der", type: "spki" }).subarray(-32),
);
const DIRECT_ID = "env-direct";
const challenge = Uint8Array.from({ length: 32 }, (_, index) => index);
const ORIGIN = "https://studio.tail1.ts.net";

interface ProofCall {
  readonly environmentId: string;
  readonly origin: string;
  readonly challenge: Uint8Array;
}

function connector(
  calls: ProofCall[],
  prove: (input: ProofCall) => Promise<Uint8Array | undefined> = async (input) =>
    Uint8Array.from(sign(null, encodeDirectRouteIdentityTranscript(input), nodeKey.privateKey)),
): HubConnectorServiceShape {
  return {
    proveDirectRouteIdentity: async (input) => {
      calls.push(input);
      return prove(input);
    },
  } as HubConnectorServiceShape;
}

const withRoute = <A, E, R>(
  service: HubConnectorServiceShape,
  run: (origin: string) => Effect.Effect<A, E, R>,
  pace: (remoteAddress: string) => boolean = () => true,
) =>
  Effect.gen(function* () {
    const appLayer = HttpRouter.serve(makeDirectRouteIdentityRouteLayer(pace), {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(hubConnectorReadyLayer(service)),
      Layer.provide(
        Layer.succeed(ServerEnvironment, {
          getDescriptor: Effect.succeed({ environmentId: DIRECT_ID }),
        } as never),
      ),
      Layer.provide(
        Layer.succeed(AdvertisedEndpointRegistry, {
          list: Effect.succeed([
            { httpBaseUrl: `${ORIGIN}/` },
            { httpBaseUrl: "http://100.64.0.2:3773" },
          ] as never),
        }),
      ),
      Layer.provideMerge(
        NodeHttpServer.layer(NodeHttp.createServer, { host: "127.0.0.1", port: 0 }),
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

const post = (origin: string, body: unknown, contentType = "application/json") =>
  Effect.promise(async () => {
    const response = await fetch(`${origin}${DIRECT_ROUTE_IDENTITY_PATH}`, {
      method: "POST",
      headers: { "content-type": contentType },
      body: typeof body === "string" ? body : JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  });

it.layer(NodeServices.layer)("direct route identity proof", (it) => {
  it.effect("signs the client's challenge for the node's own direct id", () => {
    const calls: ProofCall[] = [];
    return withRoute(connector(calls), (origin) =>
      Effect.gen(function* () {
        const answer = yield* post(origin, {
          challenge: Buffer.from(challenge).toString("base64url"),
          origin: ORIGIN,
        });
        assert.strictEqual(answer.status, 200);
        assert.deepStrictEqual(Object.keys(answer.body), ["signature"]);
        assert.isTrue(
          verifyDirectRouteIdentityProof({
            nodeIdentityPublicKey,
            environmentId: DIRECT_ID,
            origin: ORIGIN,
            challenge,
            signature: Uint8Array.from(Buffer.from(String(answer.body.signature), "base64url")),
          }),
        );
        assert.strictEqual(calls[0]?.environmentId, DIRECT_ID);
        assert.strictEqual(calls[0]?.origin, ORIGIN);
        assert.deepStrictEqual([...(calls[0]?.challenge ?? [])], [...challenge]);
      }),
    );
  });

  it.effect("signs for no origin it does not advertise: a passed-on challenge gets nothing", () => {
    const calls: ProofCall[] = [];
    return withRoute(connector(calls), (origin) =>
      Effect.gen(function* () {
        // A device that now holds an address the machine used to have.
        const answer = yield* post(origin, {
          challenge: Buffer.from(challenge).toString("base64url"),
          origin: "https://old-name.example.com",
        });
        assert.strictEqual(answer.status, 404);
        assert.deepStrictEqual(answer.body, {});
        assert.strictEqual(calls.length, 0);
      }),
    );
  });

  it.effect("answers nothing about a node without an identity, or one that refuses", () =>
    withRoute(
      connector([], async () => undefined),
      (origin) =>
        Effect.gen(function* () {
          const answer = yield* post(origin, {
            challenge: Buffer.from(challenge).toString("base64url"),
            origin: ORIGIN,
          });
          assert.strictEqual(answer.status, 404);
          assert.deepStrictEqual(answer.body, {});
        }),
    ).pipe(
      Effect.andThen(
        withRoute(
          connector([], async () => {
            throw new Error("Direct route identity input is invalid.");
          }),
          (origin) =>
            Effect.gen(function* () {
              const answer = yield* post(origin, { challenge: "AAAA", origin: ORIGIN });
              assert.strictEqual(answer.status, 404);
              assert.deepStrictEqual(answer.body, {});
            }),
        ),
      ),
    ),
  );

  it.effect("refuses a malformed or oversized body before any signing", () => {
    const calls: ProofCall[] = [];
    return withRoute(connector(calls), (origin) =>
      Effect.gen(function* () {
        assert.strictEqual((yield* post(origin, { challenge: "not base64url!" })).status, 400);
        assert.strictEqual((yield* post(origin, { nonce: "AAAA" })).status, 400);
        assert.strictEqual((yield* post(origin, { challenge: "A".repeat(1_100) })).status, 400);
        assert.strictEqual((yield* post(origin, { challenge: "AAAA" })).status, 400);
        assert.strictEqual(
          (yield* post(origin, JSON.stringify({ challenge: "AAAA" }), "text/plain")).status,
          400,
        );
        assert.strictEqual(calls.length, 0);
      }),
    );
  });

  it.effect("paces proofs, answering 429 without touching the key", () => {
    const calls: ProofCall[] = [];
    let allowed = 2;
    return withRoute(
      connector(calls),
      (origin) =>
        Effect.gen(function* () {
          const body = { challenge: Buffer.from(challenge).toString("base64url"), origin: ORIGIN };
          assert.strictEqual((yield* post(origin, body)).status, 200);
          assert.strictEqual((yield* post(origin, body)).status, 200);
          assert.strictEqual((yield* post(origin, body)).status, 429);
          assert.strictEqual(calls.length, 2);
        }),
      () => allowed-- > 0,
    );
  });
});

it("paces each remote address apart, under one ceiling for all", () => {
  let now = 0;
  const pace = makeProofPacer({
    perAddressBurst: 2,
    perAddressRefillMs: 1_000,
    globalBurst: 3,
    globalRefillMs: 10_000,
    maxAddresses: 2,
    now: () => now,
  });
  assert.isTrue(pace("10.0.0.1"));
  assert.isTrue(pace("10.0.0.1"));
  // One peer exhausts only its own bucket.
  assert.isFalse(pace("10.0.0.1"));
  assert.isTrue(pace("10.0.0.2"));
  // The ceiling holds for every address together.
  assert.isFalse(pace("10.0.0.3"));
  now = 10_000;
  assert.isTrue(pace("10.0.0.1"));
});
