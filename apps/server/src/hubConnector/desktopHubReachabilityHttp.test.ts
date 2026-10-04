import * as NodeHttp from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { HubConnectorStatus, HubIdentitySummary } from "@ryco/contracts";
import { DESKTOP_HUB_REACHABILITY_PATH } from "@ryco/contracts/desktop-native-node-claim";
import { LOCAL_INTRODUCTION_CONTROL_HEADER } from "@ryco/contracts/local-introduction";
import { Effect, Layer } from "effect";
import * as HttpRouter from "effect/unstable/http/HttpRouter";
import * as HttpServer from "effect/unstable/http/HttpServer";

import { deriveServerPaths, ServerConfig, type ServerConfigShape } from "../config.ts";
import {
  desktopHubReachabilityRouteLayer,
  hubConnectorIsReachable,
} from "./desktopHubReachabilityHttp.ts";
import { HubConnectorService, type HubConnectorServiceShape } from "./HubConnectorLive.ts";
import {
  stubE2eeOperator,
  stubLocalIntroductionService,
  stubNativeNodeClaimService,
} from "./testUtils/e2eeOperatorStub.ts";

const TOKEN = "A".repeat(43);
const at = "1970-01-01T00:00:00.000Z";
const status = (
  value: Omit<HubConnectorStatus, "transitionedAt" | "activeChannels" | "queuedBytes">,
) => ({ transitionedAt: at, activeChannels: 0, queuedBytes: 0, ...value }) as HubConnectorStatus;

it("counts only an enrolled connector that is connected or reconnecting", () => {
  // A device-code enrollment that is never approved used to keep the machine
  // awake indefinitely with nothing reachable.
  for (const state of ["online", "connecting", "authenticating"] as const) {
    assert.isTrue(hubConnectorIsReachable(status({ state }), "active"));
  }
  assert.isTrue(
    hubConnectorIsReachable(
      status({ state: "degraded", degradedMode: "backing_off", failure: "network_unavailable" }),
      "active",
    ),
  );
  assert.isFalse(
    hubConnectorIsReachable(
      status({
        state: "degraded",
        degradedMode: "operator_action_required",
        failure: "identity_store_unavailable",
      }),
      "active",
    ),
  );
  for (const state of ["disabled", "enrolling", "awaiting_approval", "revoked"] as const) {
    assert.isFalse(hubConnectorIsReachable(status({ state }), "active"));
  }
  // Enrollment polling backs off too, before any identity exists.
  for (const enrolled of ["none", "pending", "unknown"] as const) {
    assert.isFalse(
      hubConnectorIsReachable(
        status({ state: "degraded", degradedMode: "backing_off", failure: "network_unavailable" }),
        enrolled,
      ),
    );
  }
});

const summaryRequests: Array<{ readonly fingerprint?: boolean } | undefined> = [];

function connector(
  current: HubConnectorStatus,
  enrolled: HubIdentitySummary["enrolled"],
): HubConnectorServiceShape {
  return {
    status: () => current,
    resume: async () => undefined,
    enroll: async () => {
      throw new Error("unused");
    },
    readEnrollment: async () => null,
    identitySummary: async (options) => {
      summaryRequests.push(options);
      return { enrolled };
    },
    leave: async () => current,
    cancelEnrollment: async () => current,
    stop: async () => undefined,
    localIntroduction: stubLocalIntroductionService(),
    nativeNodeClaim: stubNativeNodeClaimService({}),
    e2ee: stubE2eeOperator(),
  };
}

const withRoute = <A, E, R>(
  service: HubConnectorServiceShape,
  run: (origin: string) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const baseDir = mkdtempSync(join(tmpdir(), "ryco-hub-reachability-http-"));
    const derivedPaths = yield* deriveServerPaths(baseDir, undefined);
    const config = {
      mode: "desktop",
      host: "127.0.0.1",
      desktopControlToken: TOKEN,
      ...derivedPaths,
    } as unknown as ServerConfigShape;
    const appLayer = HttpRouter.serve(desktopHubReachabilityRouteLayer, {
      disableListenLog: true,
      disableLogger: true,
    }).pipe(
      Layer.provide(Layer.succeed(HubConnectorService, service)),
      Layer.provide(Layer.succeed(ServerConfig, config)),
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

const post = (origin: string, token = TOKEN) =>
  Effect.promise(() =>
    fetch(`${origin}${DESKTOP_HUB_REACHABILITY_PATH}`, {
      method: "POST",
      headers: { [LOCAL_INTRODUCTION_CONTROL_HEADER]: token },
    }),
  );

it.layer(NodeServices.layer)("Desktop Hub reachability local control", (it) => {
  it.effect("answers only Desktop's private control token, with nothing but the answer", () =>
    withRoute(connector(status({ state: "online" }), "active"), (origin) =>
      Effect.gen(function* () {
        const response = yield* post(origin);
        assert.equal(response.status, 200);
        assert.equal(response.headers.get("cache-control"), "no-store");
        assert.deepEqual(yield* Effect.promise(() => response.json()), {
          protocolVersion: 1,
          reachable: true,
        });
        assert.equal((yield* post(origin, "B".repeat(43))).status, 404);
        // The probe never asks for the fingerprint, which opens key custody.
        assert.deepEqual(summaryRequests, [{ fingerprint: false }]);
      }),
    ),
  );

  it.effect("reports an enrollment awaiting approval as unreachable", () =>
    withRoute(connector(status({ state: "awaiting_approval" }), "pending"), (origin) =>
      Effect.gen(function* () {
        const response = yield* post(origin);
        assert.deepEqual(yield* Effect.promise(() => response.json()), {
          protocolVersion: 1,
          reachable: false,
        });
      }),
    ),
  );
});
