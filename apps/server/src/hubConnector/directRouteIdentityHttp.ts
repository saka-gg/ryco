import {
  DIRECT_ROUTE_IDENTITY_MAX_BODY_BYTES,
  DIRECT_ROUTE_IDENTITY_PATH,
} from "@ryco/contracts/direct-route-identity";
import { Effect } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import { awaitHubConnector } from "./HubConnectorService.ts";
import {
  DESKTOP_LOCAL_NO_STORE_HEADERS,
  DesktopLocalControlRefused,
  requireBoundedDesktopJsonBody,
} from "./localIntroductionHttp.ts";

const PROOF_RETRY_AFTER_SECONDS = "3";

/**
 * `POST /.well-known/ryco/environment/identity`: a Hub machine's direct address
 * proves it is the machine before a client sends it any credential
 * (`@ryco/shared/directRouteIdentity`, `docs/environment-routes.md`).
 * Unauthenticated by design, since it runs before the credential, and paced
 * (`directRouteIdentityProof.ts`, loaded on the first request). It answers
 * nothing about a node without an enrolled identity.
 */
export const makeDirectRouteIdentityRouteLayer = (pace?: () => boolean) =>
  HttpRouter.add(
    "POST",
    DIRECT_ROUTE_IDENTITY_PATH,
    Effect.gen(function* () {
      yield* requireBoundedDesktopJsonBody(DIRECT_ROUTE_IDENTITY_MAX_BODY_BYTES);
      const body = yield* (yield* HttpServerRequest.HttpServerRequest).json.pipe(
        Effect.mapError(() => new DesktopLocalControlRefused({ reason: "body" })),
      );
      const environment = yield* (yield* ServerEnvironment).getDescriptor;
      const connector = yield* awaitHubConnector;
      const { answerDirectRouteIdentityProof } = yield* Effect.promise(
        () => import("./directRouteIdentityProof.ts"),
      );
      const answer = yield* Effect.promise(() =>
        answerDirectRouteIdentityProof({
          body,
          environmentId: environment.environmentId,
          prove: connector.proveDirectRouteIdentity,
          ...(pace === undefined ? {} : { pace }),
        }),
      );
      return HttpServerResponse.jsonUnsafe(answer.body, {
        status: answer.status,
        headers:
          answer.status === 429
            ? { ...DESKTOP_LOCAL_NO_STORE_HEADERS, "Retry-After": PROOF_RETRY_AFTER_SECONDS }
            : DESKTOP_LOCAL_NO_STORE_HEADERS,
      });
    }).pipe(
      // A body that is not bounded JSON (400), or a connector that never got
      // ready (404, like a node without an identity).
      Effect.catch((error) =>
        Effect.succeed(
          HttpServerResponse.jsonUnsafe(
            {},
            {
              status: error instanceof DesktopLocalControlRefused ? 400 : 404,
              headers: DESKTOP_LOCAL_NO_STORE_HEADERS,
            },
          ),
        ),
      ),
    ),
  );

export const directRouteIdentityRouteLayer = makeDirectRouteIdentityRouteLayer();
