import { DeviceUdid } from "@ryco/contracts";
import type { DeviceFrame } from "@ryco/shared/deviceFrame";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  avcCodecString,
  createDeviceVideoDecoder,
  DEVICE_DECODE_QUEUE_LIMIT,
  DEVICE_FIRST_FRAME_TIMEOUT_MS,
  DEVICE_KEYFRAME_PAINT_TIMEOUT_MS,
  resetDeviceDecoderPreferenceForTests,
  type DeviceWebCodecs,
} from "./decoder.ts";

const udid = DeviceUdid.make("SIM-1");
const SPS_PPS = Uint8Array.of(0, 0, 0, 1, 0x67, 0x42, 0xc0, 0x1f, 0, 0, 0, 1, 0x68, 0xce);

function frame(sequence: number, kind: "config" | "key" | "delta"): DeviceFrame {
  return {
    header: {
      deviceId: udid,
      sequence,
      timestampMs: sequence,
      keyframe: kind === "key",
      codecConfig: kind === "config",
    },
    payload: kind === "config" ? SPS_PPS : Uint8Array.of(0, 0, 0, 1, kind === "key" ? 0x65 : 0x41),
  };
}

function fakeCodecs() {
  const decoders: {
    state: string;
    decodeQueueSize: number;
    configured: string | null;
    acceleration: string | undefined;
    chunks: { type: string; data: Uint8Array }[];
    output: (frame: { displayWidth: number; displayHeight: number; close(): void }) => void;
  }[] = [];
  const codecs: DeviceWebCodecs = {
    VideoDecoder: class {
      state = "unconfigured";
      decodeQueueSize = 0;
      record: (typeof decoders)[number];
      constructor(init: { output: (typeof decoders)[number]["output"] }) {
        this.record = {
          state: this.state,
          decodeQueueSize: 0,
          configured: null,
          acceleration: undefined,
          chunks: [],
          output: init.output,
        };
        decoders.push(this.record);
      }
      configure(config: { codec: string; hardwareAcceleration?: string }) {
        this.state = "configured";
        this.record.configured = config.codec;
        this.record.acceleration = config.hardwareAcceleration;
      }
      decode(chunk: { type: string; data: Uint8Array }) {
        this.record.chunks.push(chunk);
        this.decodeQueueSize = this.record.decodeQueueSize;
      }
      close() {
        this.state = "closed";
      }
    } as unknown as DeviceWebCodecs["VideoDecoder"],
    EncodedVideoChunk: class {
      constructor(init: object) {
        Object.assign(this, init);
      }
    } as unknown as DeviceWebCodecs["EncodedVideoChunk"],
  };
  return { codecs, decoders };
}

function harness() {
  const { codecs, decoders } = fakeCodecs();
  let time = 0;
  let tick: () => void = () => undefined;
  const statuses: string[] = [];
  const requestResync = vi.fn();
  const paint = vi.fn();
  const decoder = createDeviceVideoDecoder({
    udid,
    codecs,
    paint,
    requestResync,
    onStatus: (status) => statuses.push(status),
    now: () => time,
    setInterval: (callback) => {
      tick = callback;
      return 1;
    },
    clearInterval: () => undefined,
  });
  return {
    decoder,
    decoders,
    statuses,
    requestResync,
    paint,
    advance: (ms: number) => {
      time += ms;
      tick();
    },
  };
}

describe("createDeviceVideoDecoder", () => {
  afterEach(() => resetDeviceDecoderPreferenceForTests());

  it("reads the codec string from the SPS", () => {
    expect(avcCodecString(SPS_PPS)).toBe("avc1.42c01f");
  });

  it("configures, prepends the parameter sets to the keyframe, and reports streaming once painted", () => {
    const { decoder, decoders, statuses, paint } = harness();
    decoder.push(frame(1, "delta"));
    expect(decoders).toHaveLength(0);
    decoder.push(frame(2, "config"));
    decoder.push(frame(3, "key"));
    decoder.push(frame(4, "delta"));
    expect(decoders[0]?.configured).toBe("avc1.42c01f");
    expect(decoders[0]?.chunks.map((chunk) => chunk.type)).toEqual(["key", "delta"]);
    expect(decoders[0]?.chunks[0]?.data.byteLength).toBe(SPS_PPS.byteLength + 5);
    decoders[0]?.output({ displayWidth: 10, displayHeight: 20, close: vi.fn() });
    expect(paint).toHaveBeenCalledOnce();
    expect(statuses).toEqual(["connecting", "streaming"]);
  });

  it("asks for a keyframe when an open stream never paints, backing off", () => {
    const { advance, requestResync } = harness();
    advance(DEVICE_FIRST_FRAME_TIMEOUT_MS);
    expect(requestResync).toHaveBeenCalledTimes(1);
    advance(DEVICE_FIRST_FRAME_TIMEOUT_MS);
    expect(requestResync).toHaveBeenCalledTimes(1);
    advance(DEVICE_FIRST_FRAME_TIMEOUT_MS);
    expect(requestResync).toHaveBeenCalledTimes(2);
  });

  it("restarts on a decode backlog", () => {
    const { decoder, decoders, requestResync } = harness();
    decoder.push(frame(1, "config"));
    decoder.push(frame(2, "key"));
    decoders[0]!.decodeQueueSize = DEVICE_DECODE_QUEUE_LIMIT + 1;
    decoder.push(frame(3, "delta"));
    decoder.push(frame(4, "delta"));
    expect(requestResync).toHaveBeenCalled();
  });

  it("reports a stream the connection cannot carry as unsupported", () => {
    const { decoder, statuses } = harness();
    decoder.reset("unavailable");
    expect(statuses.at(-1)).toBe("unsupported");
    decoder.reset("closed");
    expect(statuses.at(-1)).toBe("recovering");
  });

  it("rebuilds a decoder that holds a keyframe back to prefer software", () => {
    const { decoder, decoders, advance, requestResync } = harness();
    decoder.push(frame(1, "config"));
    decoder.push(frame(2, "key"));
    expect(decoders[0]?.acceleration).toBe("no-preference");
    advance(DEVICE_KEYFRAME_PAINT_TIMEOUT_MS);
    expect(requestResync).toHaveBeenCalled();
    decoder.push(frame(3, "config"));
    expect(decoders[1]?.acceleration).toBe("prefer-software");

    // The page remembers: the next viewer starts in software.
    const next = harness();
    next.decoder.push(frame(1, "config"));
    expect(next.decoders[0]?.acceleration).toBe("prefer-software");
  });
});
