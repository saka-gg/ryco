/**
 * Authenticated, backpressure-isolated iOS Simulator frame WebSocket.
 *
 * H.264 frames use a dedicated socket so a slow decoder can never queue video
 * ahead of chat, lifecycle, or input RPC traffic. `DeviceFrameTransport` owns
 * the bounded queue and keyframe-aligned dropping policy; this route only
 * adapts Effect's socket to that sink and accepts resync requests.
 */
import {
  DEVICE_FRAME_RESYNC_MESSAGE,
  DEVICE_FRAME_WS_PATH,
  DEVICE_FRAME_WS_UDID_PARAM,
} from "@ryco/shared/deviceFrame";
import { DeviceUdid } from "@ryco/contracts";
import { Effect, Layer, Option } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { respondToAuthError } from "../auth/http.ts";
import { ServerAuth } from "../auth/Services/ServerAuth.ts";
import { DeviceService } from "./Services/DeviceService.ts";
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
        yield* serverAuth.authenticateWebSocketUpgrade(request);

        const deviceService = yield* DeviceService;
        if (!deviceService.supported) {
          return HttpServerResponse.text("Device streaming is unavailable", { status: 404 });
        }
        const udid = parseDeviceUdid(request);
        if (!udid) {
          return HttpServerResponse.text("Missing or invalid udid", { status: 400 });
        }

        const socket = yield* request.upgrade;
        const writer = yield* socket.writer;
        let open = true;
        const sink = makeDeviceFrameSink({
          send: (bytes) => Effect.runPromise(writer.write(bytes)).catch(() => undefined),
          isOpen: () => open,
        });
        const unsubscribe = deviceService.manager.subscribeFrames(udid, sink);
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            open = false;
            unsubscribe();
          }),
        );

        // Decoder errors and sequence gaps request fresh codec parameters plus
        // an IDR on this same stream. Unknown messages are deliberately ignored.
        const { pull } = yield* socket.reader;
        return yield* pull.pipe(
          Effect.flatMap((messages) =>
            Effect.sync(() => {
              for (const message of messages) {
                if (decodeResyncRequest(message) === null) continue;
                Effect.runFork(
                  Effect.promise(() =>
                    deviceService.manager.requestKeyframe(udid).catch(() => undefined),
                  ),
                );
              }
            }),
          ),
          Effect.forever,
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
