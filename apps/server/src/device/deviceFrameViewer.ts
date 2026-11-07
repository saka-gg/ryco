/**
 * One viewer of a device's frame stream, whatever carries it.
 *
 * The direct frame socket (`deviceFrameRoute`) and a stream tunnelled through
 * a relay channel (`hubConnector/relayFrameTunnelHost`) speak the same
 * protocol: binary frame envelopes out, the live input protocol as text both
 * ways. This owns that protocol so the two carriers cannot drift: it
 * subscribes the sink to the device's frames, opens a live input session when
 * the viewer may drive, announces which with `device.input.ready`, answers
 * resync requests with a keyframe, and hands live input to the input session.
 *
 * @module device/deviceFrameViewer
 */
import { DEVICE_FRAME_RESYNC_MESSAGE } from "@ryco/shared/deviceFrame";
import {
  DEVICE_INPUT_ERROR_MESSAGE,
  DEVICE_INPUT_READY_MESSAGE,
  decodeDeviceLiveInput,
} from "@ryco/shared/deviceLiveInput";

import type { DeviceFrameSink } from "./deviceFrameTransport.ts";
import { createDeviceInputSession, type DeviceInputTarget } from "./deviceInputSession.ts";

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

/** What a viewer needs of the device manager. */
export interface DeviceFrameViewerTarget extends DeviceInputTarget {
  subscribeFrames(udid: string, sink: DeviceFrameSink): () => void;
  requestKeyframe(udid: string): Promise<void>;
}

export interface DeviceFrameViewer {
  /** One message from the client: a resync request or live input. */
  readonly receive: (message: string | Uint8Array) => void;
  /** Stop the frames and lift a finger still down and keys still held. Idempotent. */
  readonly close: () => void;
}

export function openDeviceFrameViewer(options: {
  readonly udid: string;
  /** Owner sessions only, decided once by the carrier like the device input RPC. */
  readonly canDrive: boolean;
  readonly sink: DeviceFrameSink;
  /** Send one text message to the client. */
  readonly sendText: (text: string) => void;
  readonly target: DeviceFrameViewerTarget;
}): DeviceFrameViewer {
  const { udid, canDrive, sink, target } = options;
  let open = true;
  const sendText = (message: unknown) => {
    if (open) options.sendText(JSON.stringify(message));
  };
  const unsubscribe = target.subscribeFrames(udid, sink);
  const input = canDrive
    ? createDeviceInputSession({
        udid,
        target,
        report: (kind, message) =>
          sendText({ type: DEVICE_INPUT_ERROR_MESSAGE, input: kind, message }),
      })
    : null;
  sendText({ type: DEVICE_INPUT_READY_MESSAGE, input: canDrive });

  return {
    // Decoder errors and sequence gaps request fresh codec parameters plus an
    // IDR on this same stream. Live input goes to the input session. Unknown
    // messages are deliberately ignored.
    receive: (message) => {
      if (!open) return;
      if (decodeResyncRequest(message) !== null) {
        void target.requestKeyframe(udid).catch(() => undefined);
        return;
      }
      if (!input) return;
      const live = decodeDeviceLiveInput(message);
      if (live) input.push(live);
    },
    close: () => {
      if (!open) return;
      open = false;
      unsubscribe();
      // Lifts a finger still down and releases held keys.
      void input?.close().catch(() => undefined);
    },
  };
}
