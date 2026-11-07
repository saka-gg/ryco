/**
 * Authenticated, backpressure-isolated iOS Simulator frame WebSocket.
 *
 * H.264 frames use a dedicated socket so a slow decoder can never queue video
 * ahead of chat, lifecycle, or input RPC traffic. `DeviceFrameTransport` owns
 * the bounded queue and keyframe-aligned dropping policy; this route adapts
 * Effect's socket to that sink and accepts resync requests.
 *
 * It also carries the pane's live input (`@ryco/shared/deviceLiveInput`):
 * touch phases, keys and pasted text, handed to a `DeviceInputSession`. Only
 * owner sessions may send it, the same rule as the device input RPC; the
 * socket says which on open with a `device.input.ready` message, and other
 * sessions' input messages are ignored.
 */
import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
} from "@ryco/shared/deviceFrame";
import { DeviceUdid } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import {
  DEVICE_INPUT_ERROR_MESSAGE,
  DEVICE_INPUT_READY_MESSAGE,
  decodeDeviceLiveInput,
} from "@ryco/shared/deviceLiveInput";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { SessionCredentialService } from "../auth/Services/SessionCredentialService.ts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { directRpcPrincipal } from "../ws/RpcPrincipal.ts";
import { DeviceService } from "./Services/DeviceService.ts";
import { createDeviceInputSession } from "./deviceInputSession.ts";
import type { DeviceFrameSink } from "./deviceFrameTransport.ts";

/** A resync request is a few dozen bytes; anything larger is not one. */
const MAX_CLIENT_MESSAGE_BYTES = 1_024;

export function decodeResyncRequest(message: string | Uint8Array): "resync" | null {
  const text = typeof message === "string" ? message : Buffer.from(message).toString("utf8");
  if (text.length > MAX_CLIENT_MESSAGE_BYTES) return null;
  try {
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { type?: unknown }).type === DEVICE_FRAME_RESYNC_MESSAGE
      ? "resync"
      : null;
  } catch {
    return null;
  }
}

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
        let open = true;
        const sendText = (message: unknown) => {
          if (!open) return;
          void Effect.runPromise(writer.write(JSON.stringify(message))).catch(() => undefined);
        };
        const sink = makeDeviceFrameSink({
          send: (bytes) => Effect.runPromise(writer.write(bytes)).catch(() => undefined),
          isOpen: () => open,
        });
        const unsubscribe = deviceService.manager.subscribeFrames(udid, sink);
        const input = canDrive
          ? createDeviceInputSession({
              udid,
              target: deviceService.manager,
              report: (kind, message) =>
                sendText({ type: DEVICE_INPUT_ERROR_MESSAGE, input: kind, message }),
            })
          : null;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            open = false;
            unsubscribe();
            // Lifts a finger still down and releases held keys.
            void input?.close();
          }),
        );

        // Decoder errors and sequence gaps request fresh codec parameters plus
        // an IDR on this same stream. Live input goes to the input session.
        // Unknown messages are deliberately ignored.
        const { pull } = yield* socket.reader;
        sendText({ type: DEVICE_INPUT_READY_MESSAGE, input: canDrive });
        const readClientMessages = pull.pipe(
          Effect.flatMap((messages) =>
            Effect.sync(() => {
              for (const message of messages) {
                if (decodeResyncRequest(message) !== null) {
                  Effect.runFork(
                    Effect.promise(() =>
                      deviceService.manager.requestKeyframe(udid).catch(() => undefined),
                    ),
                  );
                  continue;
                }
                if (!input) continue;
                const live = decodeDeviceLiveInput(message);
                if (live) input.push(live);
              }
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
