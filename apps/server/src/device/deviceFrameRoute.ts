/**
 * Authenticated, backpressure-isolated iOS Simulator frame WebSocket.
 *
 * H.264 frames use a dedicated socket so a slow decoder can never queue video
 * ahead of chat, lifecycle, or input RPC traffic. `DeviceFrameTransport` owns
 * the bounded queue and keyframe-aligned dropping policy; `deviceFrameViewer`
 * owns the socket's protocol, which a stream tunnelled through a relay channel
 * shares; this route authenticates the upgrade and adapts Effect's socket.
 *
 * It also carries the pane's live input (`@ryco/shared/deviceLiveInput`):
 * touch phases, keys and pasted text, handed to a `DeviceInputSession`. Only
 * owner sessions may send it, the same rule as the device input RPC; the
 * socket says which on open with a `device.input.ready` message, and other
 * sessions' input messages are ignored.
 */
import { DEVICE_FRAME_WS_PATH, DEVICE_FRAME_WS_UDID_PARAM } from "@ryco/shared/deviceFrame";
import { DeviceUdid } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { directRpcPrincipal } from "../ws/RpcPrincipal.ts";
import { DeviceService } from "./Services/DeviceService.ts";
import type { DeviceFrameSink } from "./deviceFrameTransport.ts";
import { openDeviceFrameViewer } from "./deviceFrameViewer.ts";

export { decodeResyncRequest } from "./deviceFrameViewer.ts";

/**
 * Wrap a socket writer and account for bytes handed off but not yet settled.
 * Effect's Socket does not expose `bufferedAmount`, so this is the signal the
 * bounded fan-out uses to drop a lagging client's frames.
 */
export function makeDeviceFrameSink(options: {
  readonly send: (bytes: Uint8Array) => Promise<void> | void;
  readonly isOpen: () => boolean;
}): DeviceFrameSink {
  let inFlightBytes = 0;
  return {
    send: (bytes) => {
      inFlightBytes += bytes.byteLength;
      const settle = () => {
        inFlightBytes = Math.max(0, inFlightBytes - bytes.byteLength);
      };
      const result = options.send(bytes);
      if (result instanceof Promise) result.then(settle, settle);
      else settle();
    },
    bufferedAmount: () => inFlightBytes,
    isOpen: options.isOpen,
  };
}

function parseDeviceUdid(request: HttpServerRequest.HttpServerRequest): string | null {
  const url = Option.getOrNull(HttpServerRequest.toURL(request));
  const raw = url?.searchParams.get(DEVICE_FRAME_WS_UDID_PARAM)?.trim();
  if (!raw) return null;
  try {
    return DeviceUdid.make(raw);
  } catch {
    return null;
  }
}

export const deviceFrameRouteLayer = Layer.effectDiscard(
  Effect.gen(function* () {
    const router = yield* HttpRouter.HttpRouter;
    yield* router.add(
      "GET",
      DEVICE_FRAME_WS_PATH,
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const serverAuth = yield* ServerAuth;
        const sessions = yield* SessionCredentialService;
        const session = yield* serverAuth.authenticateWebSocketUpgrade(request);

        const deviceService = yield* DeviceService;
        if (!deviceService.supported) {
          return HttpServerResponse.text("Device streaming is unavailable", { status: 404 });
        }
        const udid = parseDeviceUdid(request);
        if (!udid) {
          return HttpServerResponse.text("Missing or invalid udid", { status: 400 });
        }

        // Decided once, at upgrade, like the RPC sockets' principal: a session
        // ending closes this socket (below), so it cannot outlive its role.
        const canDrive = yield* authorizeRpcPrincipal(
          directRpcPrincipal(session),
          "owner",
          "device live input",
        ).pipe(
          Effect.as(true),
          Effect.orElseSucceed(() => false),
        );

        const socket = yield* request.upgrade;
        const writer = yield* socket.writer;
        const { pull } = yield* socket.reader;
        let open = true;
        const viewer = openDeviceFrameViewer({
          udid,
          canDrive,
          sink: makeDeviceFrameSink({
            send: (bytes) => Effect.runPromise(writer.write(bytes)).catch(() => undefined),
            isOpen: () => open,
          }),
          sendText: (text) => {
            void Effect.runPromise(writer.write(text)).catch(() => undefined);
          },
          target: deviceService.manager,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            open = false;
            viewer.close();
          }),
        );

        const readClientMessages = pull.pipe(
          Effect.flatMap((messages) =>
            Effect.sync(() => {
              for (const message of messages) viewer.receive(message);
            }),
          ),
          Effect.forever,
        );
        // The stream ends with its session, like the RPC sockets.
        return yield* Effect.raceFirst(
          readClientMessages,
          sessions
            .awaitEnd({ sessionId: session.sessionId, chainId: session.chainId })
            .pipe(Effect.as(HttpServerResponse.empty())),
        );
      }).pipe(
        Effect.catchTag("AuthError", respondToAuthError),
        Effect.catchCause((cause) =>
          Effect.as(
            Effect.logDebug("device frame socket closed", { cause: String(cause) }),
            HttpServerResponse.empty(),
          ),
        ),
      ),
    );
  }),
);
