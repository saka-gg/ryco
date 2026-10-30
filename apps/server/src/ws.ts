import { Effect, Layer } from "effect";
import { WsDeviceRpcGroup, WsHostedRpcGroup } from "@ryco/contracts";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { RpcSerialization, RpcServer } from "effect/rpc";

import * as ProviderMaintenanceRunner from "./provider/providerMaintenanceRunner.ts";
import { ChatAttachmentUploadsLive } from "./attachmentUpload.ts";
import { ServerAuth, type AuthenticatedSession } from "./auth/Services/ServerAuth.ts";
import { ServerSecretStoreLive } from "./auth/Layers/ServerSecretStore.ts";
import { AtlassianConnectionRepositoryLive } from "./persistence/Layers/AtlassianConnections.ts";
import { layerConfig as SqlitePersistenceLayerLive } from "./persistence/Layers/Sqlite.ts";
import * as SourceControlDiscoveryLayer from "./sourceControl/SourceControlDiscovery.ts";
import * as ForgejoApi from "./sourceControl/ForgejoApi.ts";
import * as SourceControlProviderRegistry from "./sourceControl/SourceControlProviderRegistry.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "./vcs/VcsDriverRegistry.ts";
import * as VcsProjectConfig from "./vcs/VcsProjectConfig.ts";
import * as VcsProcess from "./vcs/VcsProcess.ts";
import { respondToAuthError } from "./auth/http.ts";
import {
  SessionCredentialService,
  type SessionCredentialServiceShape,
} from "./auth/Services/SessionCredentialService.ts";
import { makeDeviceWsRpcLayer, makeWsRpcLayer } from "./ws/index.ts";
import { directPeerOf, directRpcPrincipal, type RpcPrincipal } from "./ws/RpcPrincipal.ts";
import { ContextHandoffInspectionLive } from "./orchestration/Layers/ContextHandoffInspection.ts";
import { ContextHandoffRepositoryLive } from "./persistence/Layers/ContextHandoffs.ts";

/**
 * Per-connection RPC layer. `SourceControlDiscovery`, `ProviderMaintenanceRunner`
 * and `ContextHandoffInspection` are also built once in the server runtime
 * graph. Connections (direct and relay) build this layer from the runtime's
 * context, whose memo map they fork, so they reuse those process-wide
 * instances and their caches instead of constructing new ones. The provisions
 * below only take effect where no runtime graph exists (route tests).
 */
export const makeServerWsRpcLayer = (principal: RpcPrincipal) =>
  makeWsRpcLayer(principal).pipe(
    Layer.provide(
      ContextHandoffInspectionLive.pipe(
        Layer.provide(ContextHandoffRepositoryLive),
        Layer.provide(SqlitePersistenceLayerLive),
      ),
    ),
    Layer.provideMerge(ChatAttachmentUploadsLive),
    Layer.provideMerge(RpcSerialization.layerJson),
    Layer.provide(ProviderMaintenanceRunner.layer),
    Layer.provide(
      SourceControlDiscoveryLayer.layer.pipe(
        Layer.provide(
          SourceControlProviderRegistry.layer.pipe(
            Layer.provide(ForgejoApi.layer),
            Layer.provideMerge(AtlassianConnectionRepositoryLive),
            Layer.provideMerge(SqlitePersistenceLayerLive),
            Layer.provide(ServerSecretStoreLive),
            Layer.provideMerge(GitVcsDriver.layer),
            Layer.provide(VcsDriverRegistry.layer.pipe(Layer.provide(VcsProjectConfig.layer))),
          ),
        ),
        Layer.provide(VcsProcess.layer),
      ),
    ),
  );

/**
 * Serves a direct socket until it closes or its session ends: the pairing was
 * revoked, or a Hub-linked session reached its end. A revoked client or link
 * then loses its live connection at once, not at its next connect.
 */
const serveUntilSessionEnds = <E, R>(
  sessions: SessionCredentialServiceShape,
  session: AuthenticatedSession,
  serve: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  Effect.acquireUseRelease(
    sessions.markConnected(session.sessionId),
    () =>
      Effect.raceFirst(
        serve,
        sessions
          .awaitEnd({
            sessionId: session.sessionId,
            chainId: session.chainId,
            ...(session.link !== undefined && session.expiresAt !== undefined
              ? { linkedExpiresAt: session.expiresAt }
              : {}),
          })
          .pipe(Effect.as(HttpServerResponse.empty())),
      ),
    () => sessions.markDisconnected(session.sessionId),
  );

/**
 * The main socket serves the application group and the simulator control group
 * together, as the hosted relay channel already does, so a direct client needs
 * no second socket or ws-token for device control. Older clients send only
 * application RPCs and are unaffected; `/ws/device` stays for them.
 */
export const websocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const principal = { ...directRpcPrincipal(session), ...directPeerOf(request) };
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsHostedRpcGroup, {
          spanPrefix: "ws.rpc",
          spanAttributes: {
            "rpc.transport": "websocket",
            "rpc.system": "effect-rpc",
          },
        }).pipe(
          Effect.provide(
            Layer.merge(makeServerWsRpcLayer(principal), makeDeviceWsRpcLayer(principal)),
          ),
        );
        return yield* serveUntilSessionEnds(sessions, session, rpcWebSocketHttpEffect);
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);

/**
 * The dedicated simulator control socket, kept for clients that predate device
 * control on the main socket. Current clients use it only when the main socket
 * answers a device RPC with "Unknown request tag" (an older server).
 */
export const deviceWebsocketRpcRouteLayer = Layer.unwrap(
  Effect.succeed(
    HttpRouter.add(
      "GET",
      "/ws/device",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const rpcWebSocketHttpEffect = yield* RpcServer.toHttpEffectWebsocket(WsDeviceRpcGroup, {
          spanPrefix: "device.ws.rpc",
          spanAttributes: {
            "rpc.transport": "websocket",
            "rpc.system": "effect-rpc",
            "rpc.channel": "device",
          },
        }).pipe(Effect.provide(makeDeviceWsRpcLayer(directRpcPrincipal(session))));
        return yield* serveUntilSessionEnds(sessions, session, rpcWebSocketHttpEffect);
      }).pipe(Effect.catchTag("AuthError", respondToAuthError)),
    ),
  ),
);
