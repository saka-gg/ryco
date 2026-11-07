import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import { render } from "vitest-browser-react";
import type { DeviceFrameSourceHandlers } from "@ryco/client-runtime/connection";
import type { DeviceUdid } from "@ryco/contracts";
import { useRef } from "react";

import {
  DEVICE_DECODE_QUEUE_LIMIT,
  DEVICE_FIRST_FRAME_TIMEOUT_MS,
  useDeviceVideoStream,
} from "./useDeviceVideoStream";

const udid = "DEVICE" as DeviceUdid;

/** A decoder that accepts work and paints nothing, with a settable backlog. */
class StuckDecoder {
  static instances: StuckDecoder[] = [];
  state: "unconfigured" | "configured" | "closed" = "unconfigured";
  decodeQueueSize = 0;
  decoded = 0;
  constructor() {
    StuckDecoder.instances.push(this);
  }
  configure() {
    this.state = "configured";
  }
  decode() {
    this.decoded += 1;
    this.decodeQueueSize += 1;
  }
  close() {
    this.state = "closed";
  }
}

class Chunk {
  constructor(readonly init: unknown) {}
}

const sps = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0x00, 0x1f, 0, 0]);
const frame = (sequence: number, flags: { keyframe?: boolean; codecConfig?: boolean } = {}) => ({
  header: {
    deviceId: udid,
    sequence,
    timestampMs: sequence,
    keyframe: flags.keyframe ?? false,
    codecConfig: flags.codecConfig ?? false,
  },
  payload: flags.codecConfig ? sps : new Uint8Array([0, 0, 0, 1, 0x65, 1]),
});

let handlers: DeviceFrameSourceHandlers | null = null;
const requestResync = vi.fn(() => true);
const openFrameSource = (_udid: DeviceUdid, next: DeviceFrameSourceHandlers) => {
  handlers = next;
  return { requestResync, sendText: () => false, close: () => undefined };
};

function Harness() {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const video = useDeviceVideoStream({ canvasRef, udid, openFrameSource });
  return (
    <>
      <canvas ref={canvasRef} />
      <output>{video.status}</output>
    </>
  );
}

beforeEach(() => {
  StuckDecoder.instances = [];
  handlers = null;
  requestResync.mockClear();
  vi.stubGlobal("VideoDecoder", StuckDecoder);
  vi.stubGlobal("EncodedVideoChunk", Chunk);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("useDeviceVideoStream robustness", () => {
  it("drops a backlogged decoder and asks for a fresh keyframe", async () => {
    render(<Harness />);
    await vi.waitFor(() => expect(handlers).not.toBeNull());
    handlers!.onFrame(frame(1, { codecConfig: true }), 1);
    handlers!.onFrame(frame(2, { keyframe: true }), 1);
    const decoder = StuckDecoder.instances[0]!;
    decoder.decodeQueueSize = DEVICE_DECODE_QUEUE_LIMIT + 1;
    handlers!.onFrame(frame(3), 1);

    expect(decoder.state).toBe("closed");
    expect(decoder.decoded).toBe(1);
    expect(requestResync).toHaveBeenCalledTimes(1);

    // A resync the source dropped (cooldown) is asked for again.
    await vi.waitFor(() => expect(requestResync).toHaveBeenCalledTimes(2), {
      timeout: DEVICE_FIRST_FRAME_TIMEOUT_MS + 2_000,
      interval: 100,
    });
  });

  it("asks for a keyframe when an open stream paints nothing", async () => {
    render(<Harness />);
    await vi.waitFor(() => expect(handlers).not.toBeNull());
    handlers!.onFrame(frame(1, { codecConfig: true }), 1);
    handlers!.onFrame(frame(2, { keyframe: true }), 1);
    expect(requestResync).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(requestResync).toHaveBeenCalled(), {
      timeout: DEVICE_FIRST_FRAME_TIMEOUT_MS + 2_000,
      interval: 100,
    });
  });
});
