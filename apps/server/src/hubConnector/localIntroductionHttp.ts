import * as Crypto from "node:crypto";

import {
  LOCAL_INTRODUCTION_COMPLETE_PATH,
  LOCAL_INTRODUCTION_CONTROL_HEADER,
  LOCAL_INTRODUCTION_DESCRIPTOR_PATH,
  LOCAL_INTRODUCTION_MAX_BODY_BYTES,
  LOCAL_INTRODUCTION_PROTOCOL_VERSION,
  LocalIntroductionCompleteRequest,
  type LocalIntroductionErrorResponse,
} from "@ryco/contracts/local-introduction";
import { Data, Effect, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { ServerConfig } from "../config.ts";
import {
  NodeLocalIntroductionError,
  type NodeLocalIntroductionErrorCode,
} from "../hubIdentity/NodeLocalIntroductionError.ts";
import { awaitHubConnector } from "./HubConnectorService.ts";

const CONTROL_TOKEN = /^[A-Za-z0-9_-]{43}$/;
const LOOPBACK_BIND_HOSTS = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);
export const DESKTOP_LOCAL_NO_STORE_HEADERS = {
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
} as const;

export class DesktopLocalControlRefused extends Data.TaggedError("DesktopLocalControlRefused")<{
  readonly reason: "authentication" | "body";
}> {}

class LocalIntroductionOperationFailed extends Data.TaggedError(
  "LocalIntroductionOperationFailed",
)<{
  readonly cause: unknown;
}> {}

export function isLoopbackRemoteAddress(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.startsWith("::ffff:") ? value.slice("::ffff:".length) : value;
  return normalized === "127.0.0.1" || normalized === "::1";
}

function readRemoteAddress(source: unknown): string | undefined {
  if (typeof source !== "object" || source === null) return undefined;
  const candidate = source as {
    readonly remoteAddress?: unknown;
    readonly socket?: { readonly remoteAddress?: unknown };
  };
  const value = candidate.socket?.remoteAddress ?? candidate.remoteAddress;
  return typeof value === "string" ? value : undefined;
}

function exactControlToken(expected: string, presented: string): boolean {
  if (!CONTROL_TOKEN.test(expected) || !CONTROL_TOKEN.test(presented)) return false;
  return Crypto.timingSafeEqual(Buffer.from(expected, "ascii"), Buffer.from(presented, "ascii"));
}

export function desktopLocalControlIsAuthorized(input: {
  readonly mode: string;
  readonly bindHost: string | undefined;
  readonly configuredToken: string | undefined;
  readonly presentedToken: string | undefined;
  readonly origin: string | undefined;
  readonly remoteAddress: string | undefined;
  readonly allowMissingRemoteAddress?: boolean;
}): boolean {
  return (
    input.mode === "desktop" &&
    input.bindHost !== undefined &&
    LOOPBACK_BIND_HOSTS.has(input.bindHost.trim().toLowerCase()) &&
    input.origin === undefined &&
    (isLoopbackRemoteAddress(input.remoteAddress) ||
      (input.allowMissingRemoteAddress === true && input.remoteAddress === undefined)) &&
    input.configuredToken !== undefined &&
    input.presentedToken !== undefined &&
    exactControlToken(input.configuredToken, input.presentedToken)
  );
}

export const requireDesktopLocalControl = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig;
  const remoteAddress = readRemoteAddress(request.source);
  if (
    !desktopLocalControlIsAuthorized({
      mode: config.mode,
      bindHost: config.host,
      configuredToken: config.desktopControlToken,
      presentedToken: request.headers[LOCAL_INTRODUCTION_CONTROL_HEADER],
      origin: request.headers.origin,
      remoteAddress,
      // Effect's Node HTTP adapter exposes the peer address. Under Bun 1.4,
      // the same adapter currently supplies an empty request source. The
      // listener is still bound exclusively to loopback and the request must
      // present the exact 256-bit per-child control credential with no Origin.
      allowMissingRemoteAddress:
        (process.versions as Readonly<Record<string, string | undefined>>).bun !== undefined,
    })
  ) {
    return yield* new DesktopLocalControlRefused({ reason: "authentication" });
  }
});

export const requireBoundedDesktopJsonBody = (maxBodyBytes: number) =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const contentLength = Number(request.headers["content-length"]);
    const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (
      !Number.isSafeInteger(contentLength) ||
      contentLength <= 0 ||
      contentLength > maxBodyBytes ||
      request.headers["transfer-encoding"] !== undefined ||
      contentType !== "application/json"
    ) {
      return yield* new DesktopLocalControlRefused({ reason: "body" });
    }
  });

function errorStatus(code: NodeLocalIntroductionErrorCode): number {
  switch (code) {
    case "local_introduction_rejected":
      return 400;
    case "local_introduction_conflict":
    case "local_introduction_expired":
      return 409;
    case "local_introduction_unavailable":
      return 503;
  }
}

function errorResponse(code: NodeLocalIntroductionErrorCode, status = errorStatus(code)) {
  const body: LocalIntroductionErrorResponse = { error: code };
  return HttpServerResponse.jsonUnsafe(body, {
    status,
    headers: DESKTOP_LOCAL_NO_STORE_HEADERS,
  });
}

const handleLocalControlFailure = (error: unknown) => {
  if (error instanceof DesktopLocalControlRefused) {
    return Effect.succeed(
      errorResponse(
        error.reason === "authentication"
          ? "local_introduction_unavailable"
          : "local_introduction_rejected",
        error.reason === "authentication" ? 404 : 400,
      ),
    );
  }
  const cause = error instanceof LocalIntroductionOperationFailed ? error.cause : error;
  if (cause instanceof NodeLocalIntroductionError) {
    return Effect.succeed(errorResponse(cause.code));
  }
  return Effect.succeed(errorResponse("local_introduction_unavailable"));
};

export const desktopLocalIntroductionDescriptorRouteLayer = HttpRouter.add(
  "POST",
  LOCAL_INTRODUCTION_DESCRIPTOR_PATH,
  Effect.gen(function* () {
    yield* requireDesktopLocalControl;
    const connector = yield* awaitHubConnector;
    const descriptor = yield* Effect.tryPromise({
      try: () => connector.localIntroduction.descriptor(),
      catch: (cause) => new LocalIntroductionOperationFailed({ cause }),
    });
    return HttpServerResponse.jsonUnsafe(
      {
        protocolVersion: LOCAL_INTRODUCTION_PROTOCOL_VERSION,
        hubOrigin: descriptor.hubOrigin,
        environmentId: descriptor.environmentId,
        nodeId: descriptor.nodeId,
        nodeIdentityPublicKey: Buffer.from(descriptor.nodeIdentityPublicKey).toString("base64url"),
        nodeIdentityFingerprint: Buffer.from(descriptor.nodeIdentityFingerprint).toString(
          "base64url",
        ),
        nodeContinuityId: descriptor.nodeContinuityId,
        nodePolicyGeneration: descriptor.nodePolicyGeneration,
      },
      { status: 200, headers: DESKTOP_LOCAL_NO_STORE_HEADERS },
    );
  }).pipe(Effect.catch(handleLocalControlFailure)),
);

export const desktopLocalIntroductionCompleteRouteLayer = HttpRouter.add(
  "POST",
  LOCAL_INTRODUCTION_COMPLETE_PATH,
  Effect.gen(function* () {
    yield* requireDesktopLocalControl;
    yield* requireBoundedDesktopJsonBody(LOCAL_INTRODUCTION_MAX_BODY_BYTES);
    const body = yield* HttpServerRequest.schemaBodyJson(LocalIntroductionCompleteRequest).pipe(
      Effect.mapError(() => new DesktopLocalControlRefused({ reason: "body" })),
    );
    const connector = yield* awaitHubConnector;
    const result = yield* Effect.tryPromise({
      try: () =>
        connector.localIntroduction.complete({
          requestTbs: Uint8Array.from(Buffer.from(body.requestTbs, "base64url")),
          requestSignature: Uint8Array.from(Buffer.from(body.requestSignature, "base64url")),
        }),
      catch: (cause) => new LocalIntroductionOperationFailed({ cause }),
    });
    return HttpServerResponse.jsonUnsafe(
      {
        protocolVersion: LOCAL_INTRODUCTION_PROTOCOL_VERSION,
        disposition: result.disposition,
        approvalTbs: Buffer.from(result.approvalTbs).toString("base64url"),
        approvalSignature: Buffer.from(result.approvalSignature).toString("base64url"),
      },
      { status: 200, headers: DESKTOP_LOCAL_NO_STORE_HEADERS },
    );
  }).pipe(Effect.catch(handleLocalControlFailure)),
);

export const desktopLocalIntroductionRoutesLayer = Layer.mergeAll(
  desktopLocalIntroductionDescriptorRouteLayer,
  desktopLocalIntroductionCompleteRouteLayer,
);
