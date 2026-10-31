// Adapted from Synara v0.7.2 (MIT); see THIRD_PARTY_NOTICES.md.
import type { DeviceFrameSource, DeviceFrameSourceHandlers } from "@ryco/client-runtime/connection";
import type { DeviceUdid } from "@ryco/contracts";
import type { DeviceFrame } from "@ryco/shared/deviceFrame";
import { useEffect, useRef, useState, type RefObject } from "react";

import { createDeviceFrameGateState, stepDeviceFrameGate } from "./deviceFrameGate";

export type { DeviceVideoStatus } from "@ryco/client-runtime/state/device/previewSampler";
import type { DeviceVideoStatus } from "@ryco/client-runtime/state/device/previewSampler";

function avcCodecString(payload: Uint8Array): string | null {
  for (let offset = 0; offset + 7 < payload.byteLength; offset += 1) {
    const long =
      payload[offset] === 0 &&
      payload[offset + 1] === 0 &&
      payload[offset + 2] === 0 &&
      payload[offset + 3] === 1;
    const short = payload[offset] === 0 && payload[offset + 1] === 0 && payload[offset + 2] === 1;
    if (!long && !short) continue;
    const nal = offset + (long ? 4 : 3);
    if (((payload[nal] ?? 0) & 0x1f) !== 7) continue;
    return `avc1.${[payload[nal + 1], payload[nal + 2], payload[nal + 3]]
      .map((value) => (value ?? 0).toString(16).padStart(2, "0"))
      .join("")}`;
  }
  return null;
}

export function useDeviceVideoStream(input: {
  readonly canvasRef: RefObject<HTMLCanvasElement | null>;
  readonly udid: DeviceUdid | null;
  readonly openFrameSource?: (
    udid: DeviceUdid,
    handlers: DeviceFrameSourceHandlers,
  ) => DeviceFrameSource;
}): {
  readonly status: DeviceVideoStatus;
  readonly error: string | null;
  readonly dimensions: { readonly width: number; readonly height: number } | null;
} {
  const { canvasRef, udid, openFrameSource } = input;
  const [status, setStatus] = useState<DeviceVideoStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [dimensions, setDimensions] = useState<{ width: number; height: number } | null>(null);
  const generationRef = useRef(0);

  useEffect(() => {
    if (!udid || !openFrameSource) {
      setStatus("idle");
      setError(null);
      return;
    }
    if (
      typeof globalThis.VideoDecoder !== "function" ||
      typeof globalThis.EncodedVideoChunk !== "function"
    ) {
      setStatus("unsupported");
      return;
    }

    const generation = ++generationRef.current;
    let gate = createDeviceFrameGateState();
    let decoder: VideoDecoder | null = null;
    let source: DeviceFrameSource | null = null;
    let parameterSets: Uint8Array | null = null;
    const current = () => generation === generationRef.current;
    setStatus("connecting");
    setError(null);

    const closeDecoder = () => {
      parameterSets = null;
      try {
        if (decoder?.state !== "closed") decoder?.close();
      } catch {
        // An errored decoder can already be closed.
      }
      decoder = null;
    };
    const fail = (message: string) => {
      if (!current()) return;
      closeDecoder();
      gate = createDeviceFrameGateState();
      setError(message);
      setStatus("error");
    };
    const configure = (frame: DeviceFrame) => {
      const codec = avcCodecString(frame.payload);
      if (!codec) {
        fail("The simulator sent video parameters Ryco could not read.");
        source?.requestResync();
        return;
      }
      closeDecoder();
      const next = new VideoDecoder({
        output: (videoFrame) => {
          try {
            if (!current()) return;
            const canvas = canvasRef.current;
            if (!canvas) return;
            if (
              canvas.width !== videoFrame.displayWidth ||
              canvas.height !== videoFrame.displayHeight
            ) {
              canvas.width = videoFrame.displayWidth;
              canvas.height = videoFrame.displayHeight;
              setDimensions({ width: videoFrame.displayWidth, height: videoFrame.displayHeight });
            }
            canvas.getContext("2d")?.drawImage(videoFrame, 0, 0);
            setStatus("streaming");
            setError(null);
          } finally {
            videoFrame.close();
          }
        },
        error: (decoderError) => {
          fail(decoderError.message || "The simulator video decoder failed.");
          source?.requestResync();
        },
      });
      try {
        next.configure({ codec, optimizeForLatency: true });
        decoder = next;
        parameterSets = frame.payload.slice();
      } catch (configureError) {
        fail(
          configureError instanceof Error ? configureError.message : "Video decoder setup failed.",
        );
      }
    };
    const decode = (frame: DeviceFrame, keyframe: boolean) => {
      if (!decoder || decoder.state !== "configured") return;
      let data = frame.payload;
      if (keyframe && parameterSets) {
        const combined = new Uint8Array(parameterSets.byteLength + data.byteLength);
        combined.set(parameterSets);
        combined.set(data, parameterSets.byteLength);
        data = combined;
        parameterSets = null;
      }
      try {
        decoder.decode(
          new EncodedVideoChunk({
            type: keyframe ? "key" : "delta",
            timestamp: Math.round(frame.header.timestampMs * 1_000),
            data,
          }),
        );
      } catch (decodeError) {
        fail(
          decodeError instanceof Error
            ? decodeError.message
            : "A simulator frame could not be decoded.",
        );
        source?.requestResync();
      }
    };
    const onFrame = (frame: DeviceFrame) => {
      if (!current()) return;
      const step = stepDeviceFrameGate(gate, frame.header, udid);
      gate = step.state;
      if (step.requestKeyframe) source?.requestResync();
      if (step.action.kind === "configure") configure(frame);
      if (step.action.kind === "decode") decode(frame, step.action.keyframe);
    };
    source = openFrameSource(udid, {
      onFrame,
      onReset: (reason) => {
        if (!current()) return;
        closeDecoder();
        gate = createDeviceFrameGateState();
        if (reason === "decode-failed") setError("The simulator sent a malformed frame.");
        setStatus("recovering");
      },
    });

    return () => {
      generationRef.current += 1;
      source?.close();
      closeDecoder();
    };
  }, [canvasRef, openFrameSource, udid]);

  return { status, error, dimensions };
}
