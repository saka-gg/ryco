import {
  DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH,
  DESKTOP_NATIVE_NODE_CLAIM_MAX_BODY_BYTES,
  DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION,
  DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH,
  DesktopNativeNodeClaimCommitRequest,
  type DesktopNativeNodeClaimErrorResponse,
  DesktopNativeNodeClaimSignRequest,
} from "@ryco/contracts/desktop-native-node-claim";
import { Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig, type ServerConfigShape } from "../config.ts";
import { ServerEnvironment } from "../environment/Services/ServerEnvironment.ts";
import {
  NodeNativeClaimError,
  type NodeNativeClaimErrorCode,
} from "../hubIdentity/NodeNativeClaimService.ts";
import {
  DESKTOP_LOCAL_NO_STORE_HEADERS,
  DesktopLocalControlRefused,
  requireBoundedDesktopJsonBody,
  requireDesktopLocalControl,
} from "./localIntroductionHttp.ts";
import { resolveHubEnrollmentLabel } from "./HubEnrollmentLabel.ts";
import { awaitHubConnector } from "./HubConnectorService.ts";

class NativeClaimOperationFailed extends Data.TaggedError("NativeClaimOperationFailed")<{
  readonly cause: unknown;
}> {}

function activeHubConfig(config: ServerConfigShape): {
  readonly origin: string;
  readonly nodeName: string | undefined;
} {
  const hub = config.hubConnector;
  if (hub?.enabled !== true || hub.origin === undefined || hub.configurationIssue !== undefined) {
    throw new NodeNativeClaimError("native_node_claim_unavailable");
  }
  return { origin: hub.origin, nodeName: hub.nodeName };
}

function errorStatus(code: NodeNativeClaimErrorCode): number {
  switch (code) {
    case "native_node_claim_rejected":
      return 400;
    case "native_node_claim_conflict":
    case "native_node_claim_expired":
      return 409;
    case "native_node_claim_unavailable":
      return 503;
  }
}

function errorResponse(code: NodeNativeClaimErrorCode, status = errorStatus(code)) {
  const body: DesktopNativeNodeClaimErrorResponse = { error: code };
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: DESKTOP_LOCAL_NO_STORE_HEADERS,
  });
}

const handleFailure = (error: unknown) => {
  if (error instanceof DesktopLocalControlRefused) {
    return Effect.succeed(
      errorResponse(
        error.reason === "authentication"
          ? "native_node_claim_unavailable"
          : "native_node_claim_rejected",
        error.reason === "authentication" ? 404 : 400,
      ),
    );
  }
  const cause = error instanceof NativeClaimOperationFailed ? error.cause : error;
  if (cause instanceof NodeNativeClaimError) return Effect.succeed(errorResponse(cause.code));
  return Effect.succeed(errorResponse("native_node_claim_unavailable"));
};

export const desktopNativeNodeClaimDescriptorRouteLayer = HttpRouter.add(
  "POST",
  DESKTOP_NATIVE_NODE_CLAIM_DESCRIPTOR_PATH,
  Effect.gen(function* () {
    yield* requireDesktopLocalControl;
    const config = yield* ServerConfig;
    const hub = activeHubConfig(config);
    const environment = yield* ServerEnvironment;
    const environmentDescriptor = yield* environment.getDescriptor;
    const connector = yield* awaitHubConnector;
    const descriptor = yield* Effect.tryPromise({
      try: () => connector.nativeNodeClaim.prepare(hub.origin),
      catch: (cause) => new NativeClaimOperationFailed({ cause }),
    });
    const label = resolveHubEnrollmentLabel({
      configuredNodeName: hub.nodeName,
      machineLabel: environmentDescriptor.label,
      environmentId: descriptor.environmentId,
    });
    return HttpServerResponse.jsonUnsafe(
      {
        protocolVersion: DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION,
        state: descriptor.state,
        hubOrigin: descriptor.hubOrigin,
        environmentId: descriptor.environmentId,
        label,
        platformOs: environmentDescriptor.platform.os,
        platformArch: environmentDescriptor.platform.arch,
        clientVersion: environmentDescriptor.serverVersion,
        algorithm: descriptor.algorithm,
        publicKey: Buffer.from(descriptor.publicKey).toString("base64url"),
        fingerprint: `SHA256:${Buffer.from(descriptor.fingerprint).toString("base64url")}`,
      },
      { status: 200, headers: DESKTOP_LOCAL_NO_STORE_HEADERS },
    );
  }).pipe(Effect.catch(handleFailure)),
);

export const desktopNativeNodeClaimSignRouteLayer = HttpRouter.add(
  "POST",
  DESKTOP_NATIVE_NODE_CLAIM_SIGN_PATH,
  Effect.gen(function* () {
    yield* requireDesktopLocalControl;
    yield* requireBoundedDesktopJsonBody(DESKTOP_NATIVE_NODE_CLAIM_MAX_BODY_BYTES);
    const body = yield* HttpServerRequest.schemaBodyJson(DesktopNativeNodeClaimSignRequest).pipe(
      Effect.mapError(() => new DesktopLocalControlRefused({ reason: "body" })),
    );
    const hub = activeHubConfig(yield* ServerConfig);
    const connector = yield* awaitHubConnector;
    const signature = yield* Effect.tryPromise({
      try: () =>
        connector.nativeNodeClaim.sign({
          hubOrigin: hub.origin,
          claim: body.claim,
        }),
      catch: (cause) => new NativeClaimOperationFailed({ cause }),
    });
    return HttpServerResponse.jsonUnsafe(
      {
        protocolVersion: DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION,
        signature: Buffer.from(signature).toString("base64url"),
      },
      { status: 200, headers: DESKTOP_LOCAL_NO_STORE_HEADERS },
    );
  }).pipe(Effect.catch(handleFailure)),
);

export const desktopNativeNodeClaimCommitRouteLayer = HttpRouter.add(
  "POST",
  DESKTOP_NATIVE_NODE_CLAIM_COMMIT_PATH,
  Effect.gen(function* () {
    yield* requireDesktopLocalControl;
    yield* requireBoundedDesktopJsonBody(DESKTOP_NATIVE_NODE_CLAIM_MAX_BODY_BYTES);
    const body = yield* HttpServerRequest.schemaBodyJson(DesktopNativeNodeClaimCommitRequest).pipe(
      Effect.mapError(() => new DesktopLocalControlRefused({ reason: "body" })),
    );
    const config = yield* ServerConfig;
    const hub = activeHubConfig(config);
    const environment = yield* ServerEnvironment;
    const environmentDescriptor = yield* environment.getDescriptor;
    const expectedLabel = resolveHubEnrollmentLabel({
      configuredNodeName: hub.nodeName,
      machineLabel: environmentDescriptor.label,
      environmentId: body.claim.environmentId,
    });
    const connector = yield* awaitHubConnector;
    yield* Effect.tryPromise({
      try: () =>
        connector.nativeNodeClaim.commit({
          hubOrigin: hub.origin,
          expectedLabel,
          claim: body.claim,
          result: body.result,
        }),
      catch: (cause) => new NativeClaimOperationFailed({ cause }),
    });
    // The connector may already be parked in `enrolling` from startup. The
    // native claim committed an active identity out-of-band, so wake that same
    // state machine instead of waiting for an app restart or a user retry.
    //
    // The durable commit above is the transaction this endpoint acknowledges.
    // A concurrent relay teardown or reconnect can make this opportunistic wake
    // fail even though the identity is active. Do not turn that committed state
    // into a 503: the Desktop would retry the already-finished claim forever and
    // never continue to its local trusted introduction. The connector owns its
    // own bounded reconnect lifecycle, so a failed wake is safe to leave there.
    yield* Effect.promise(() => connector.resume().catch(() => undefined));
    return HttpServerResponse.jsonUnsafe(
      {
        protocolVersion: DESKTOP_NATIVE_NODE_CLAIM_PROTOCOL_VERSION,
        status: "active",
        result: body.result,
      },
      { status: 200, headers: DESKTOP_LOCAL_NO_STORE_HEADERS },
    );
  }).pipe(Effect.catch(handleFailure)),
);

export const desktopNativeNodeClaimRoutesLayer = Layer.mergeAll(
  desktopNativeNodeClaimDescriptorRouteLayer,
  desktopNativeNodeClaimSignRouteLayer,
  desktopNativeNodeClaimCommitRouteLayer,
);
