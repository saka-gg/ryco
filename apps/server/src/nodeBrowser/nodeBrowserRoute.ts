// @effect-diagnostics nodeBuiltinImport:off - the socket's send buffer is Node's.
/**
 * The node browser's frame socket (`@ryco/shared/nodeBrowserFrame`): live
 * JPEG frames of one tab, authenticated like the RPC socket. Watching a tab
 * shows page content, which is as private as terminal output, so only
 * operator sessions may: the role is checked here, after the upgrade, and a
 * refusal is a close code rather than a refused upgrade, which clients would
 * read as a lost session. Everything past that loads with the runtime.
 *
 * @module nodeBrowserRoute
 */
import type * as Http from "node:http";

import {
  NODE_BROWSER_FRAME_CLOSE,
  NODE_BROWSER_FRAME_WS_PATH,
} from "@ryco/shared/nodeBrowserFrame";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Socket } from "effect/socket";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { directRpcPrincipal } from "../ws/RpcPrincipal.ts";
import { NodeBrowser } from "./NodeBrowser.ts";

export const nodeBrowserFrameRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      NODE_BROWSER_FRAME_WS_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);
        const nodeBrowser = Option.getOrUndefined(yield* Effect.serviceOption(NodeBrowser));
        const params = Option.match(HttpServerRequest.toURL(request), {
          onNone: () => new URLSearchParams(),
          onSome: (url) => url.searchParams,
        });
        const operator = yield* authorizeRpcPrincipal(
          directRpcPrincipal(session),
          "operator",
          NODE_BROWSER_FRAME_WS_PATH,
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

        const socket = yield* request.upgrade;
        // Reading opens the socket; until then a write, a close included, waits.
        const { pull } = yield* socket.reader;
        const writer = yield* socket.writer;
        const close = (code: number, reason: string) =>
          writer
            .write(new Socket.CloseEvent(code, reason))
            .pipe(Effect.ignore, Effect.as(HttpServerResponse.empty()));
        if (!operator) return yield* close(NODE_BROWSER_FRAME_CLOSE.forbidden, "operator only");
        const capability = nodeBrowser
          ? yield* nodeBrowser.capability
          : { available: false, reason: "disabled" as const };
        if (!nodeBrowser || !capability.available) {
          return yield* close(
            NODE_BROWSER_FRAME_CLOSE.unavailable,
            capability.reason ?? "unavailable",
          );
        }
        const runtime = yield* nodeBrowser.runtime;
        // Effect's socket keeps no send buffer of its own: Node's socket holds what is unsent.
        const connection = (request.source as Partial<Http.IncomingMessage> | undefined)?.socket;
        const serve = runtime.serveViewer(
          {
            write: writer.write,
            pull,
            bufferedBytes: () => connection?.writableLength ?? 0,
            cut: Effect.sync(() => connection?.destroy()),
          },
          params,
        );
        // The stream ends with its session, like the RPC sockets.
        return yield* Effect.raceFirst(
          serve.pipe(Effect.as(HttpServerResponse.empty())),
          sessions
            .awaitEnd({ sessionId: session.sessionId, chainId: session.chainId })
            .pipe(Effect.as(HttpServerResponse.empty())),
        );
      }).pipe(
        Effect.catchTag("AuthError", respondToAuthError),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logDebug("node browser frame socket closed", { cause: String(cause) }),
            HttpServerResponse.empty(),
          ),
        ),
      ),
    );
  }),
);
