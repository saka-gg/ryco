import { describe, expect, it, vi } from "vitest";

import { decodeDeviceFrame, encodeDeviceFrame } from "@ryco/shared/deviceFrame";

import {
  DeviceFramePrefixParser,
  DeviceHelperError,
  HelperClient,
  encodeFrameRecord,
} from "./helperClient.ts";

const DEVICE = "FAKE-0001";

/**
 * What the helper actually puts on the socket: the contract envelope, wrapped
 * in its own u32 length prefix.
 */
function record(
  options: {
    readonly sequence?: number;
    readonly keyframe?: boolean;
    readonly codecConfig?: boolean;
    readonly payload?: Uint8Array;
  } = {},
) {
  return encodeFrameRecord(
    encodeDeviceFrame({
      header: {
        deviceId: DEVICE,
        sequence: options.sequence ?? 1,
        timestampMs: 100,
        keyframe: options.keyframe ?? false,
        codecConfig: options.codecConfig ?? false,
      },
      payload: options.payload ?? new Uint8Array([1, 2, 3]),
    }),
  );
}

describe("helper frame prefix parser", () => {
  it("unwraps one whole record", () => {
    const parser = new DeviceFramePrefixParser();

    const payloads = parser.push(record({ sequence: 7, keyframe: true }));

    expect(payloads).toHaveLength(1);
    // The payload is passed through untouched: it is already the envelope the
    // transport and the browser decode.
    expect(payloads[0]!.byteLength).toBeGreaterThan(17);
  });

  it("reassembles a record split across chunks", () => {
    const parser = new DeviceFramePrefixParser();
    const bytes = record({ payload: new Uint8Array([4, 5, 6, 7]) });

    const first = parser.push(bytes.subarray(0, 3));
    const second = parser.push(bytes.subarray(3, 12));
    const third = parser.push(bytes.subarray(12));

    expect(first).toHaveLength(0);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(1);
    expect(third[0]!.byteLength).toBe(bytes.byteLength - 4);
  });

  it("returns every record in a chunk carrying several", () => {
    const parser = new DeviceFramePrefixParser();

    const payloads = parser.push(
      Buffer.concat([
        record({ sequence: 1 }),
        record({ sequence: 2, keyframe: true }),
        record({ sequence: 3 }),
      ]),
    );

    expect(payloads).toHaveLength(3);
  });

  it("copies payloads so a later chunk cannot mutate an emitted frame", () => {
    const parser = new DeviceFramePrefixParser();
    const bytes = record({ payload: new Uint8Array([7, 7]) });

    const payloads = parser.push(bytes);
    const before = Array.from(payloads[0]!);
    bytes.fill(0);

    expect(Array.from(payloads[0]!)).toEqual(before);
  });

  it("rejects an implausible length prefix instead of allocating", () => {
    const parser = new DeviceFramePrefixParser();
    const desynced = Buffer.alloc(8);
    desynced.writeUInt32LE(0xff_ff_ff_ff, 0);

    expect(() => parser.push(desynced)).toThrow(DeviceHelperError);
  });

  it("preserves ordered records at every pair of fragment boundaries", () => {
    const expected = [Uint8Array.of(9, 8, 7), new Uint8Array(), Uint8Array.of(6, 5)];
    const stream = Buffer.concat(expected.map(encodeFrameRecord));
    for (let first = 0; first <= stream.length; first++) {
      for (let second = first; second <= stream.length; second++) {
        const parser = new DeviceFramePrefixParser();
        const actual = [
          ...parser.push(stream.subarray(0, first)),
          ...parser.push(stream.subarray(first, second)),
          ...parser.push(stream.subarray(second)),
          ...parser.push(new Uint8Array()),
        ];
        expect(actual).toEqual(expected);
      }
    }
  });

  it("owns partial input and emitted buffers across scratch-buffer reuse", () => {
    const parser = new DeviceFramePrefixParser();
    const stream = Buffer.concat([
      encodeFrameRecord(Uint8Array.of(7, 8, 9)),
      encodeFrameRecord(Uint8Array.of(10, 11)),
    ]);
    const scratch = new Uint8Array(3);
    const actual: Uint8Array[] = [];
    for (let offset = 0; offset < stream.length; offset += scratch.length) {
      const count = Math.min(scratch.length, stream.length - offset);
      scratch.set(stream.subarray(offset, offset + count));
      actual.push(...parser.push(scratch.subarray(0, count)));
      scratch.fill(0);
    }
    expect(actual).toEqual([Uint8Array.of(7, 8, 9), Uint8Array.of(10, 11)]);
    actual[0]!.fill(0);
    expect(actual[1]).toEqual(Uint8Array.of(10, 11));
    expect(actual[0]!.buffer).not.toBe(actual[1]!.buffer);
    expect(parser.push(encodeFrameRecord(Uint8Array.of(12)))).toEqual([Uint8Array.of(12)]);
    expect(actual[1]).toEqual(Uint8Array.of(10, 11));
  });

  it.each([8 * 1024 * 1024 + 1, 0x8000_0000, 0xffff_ffff])(
    "rejects length %i as soon as a fragmented prefix completes and stays failed",
    (length) => {
      const parser = new DeviceFramePrefixParser();
      const prefix = Buffer.alloc(4);
      prefix.writeUInt32LE(length);
      for (let offset = 0; offset < 3; offset++) {
        expect(parser.push(prefix.subarray(offset, offset + 1))).toEqual([]);
      }
      const tail = new Uint8Array(1025);
      tail[0] = prefix[3]!;
      const set = vi.spyOn(Uint8Array.prototype, "set");
      const concat = vi.spyOn(Buffer, "concat");
      const from = vi.spyOn(Buffer, "from");
      try {
        expect(() => parser.push(tail)).toThrow(
          expect.objectContaining({
            code: "frame_stream_desync",
            message: `Helper frame record claims ${length} bytes`,
          }),
        );
        expect(set.mock.calls.map(([source]) => source.length)).toEqual([1]);
        set.mockClear();
        expect(() => parser.push(new Uint8Array(1024))).toThrow(DeviceHelperError);
        expect(() => parser.push(new Uint8Array())).toThrow(DeviceHelperError);
        expect(set).not.toHaveBeenCalled();
        expect(concat.mock.calls.length).toBe(0);
        expect(from.mock.calls.length).toBe(0);
      } finally {
        set.mockRestore();
        concat.mockRestore();
        from.mockRestore();
      }
    },
  );

  it.each([1, 2, 4, 8])(
    "copies each byte once for a %i MiB payload in 1 KiB reads, including the maximum",
    (mib) => {
      const payload = new Uint8Array(mib * 1024 * 1024).fill(0xa5);
      const wire = encodeFrameRecord(payload);
      const parser = new DeviceFramePrefixParser();
      const set = vi.spyOn(Uint8Array.prototype, "set");
      const concat = vi.spyOn(Buffer, "concat");
      const from = vi.spyOn(Buffer, "from");
      const slice = vi.spyOn(Uint8Array.prototype, "slice");
      const actual: Uint8Array[] = [];
      let copiedBytes: number;
      try {
        for (let offset = 0; offset < wire.length; offset += 1024) {
          actual.push(...parser.push(wire.subarray(offset, offset + 1024)));
        }
        copiedBytes = set.mock.calls.reduce((sum, [source]) => sum + source.length, 0);
        expect(concat.mock.calls.length).toBe(0);
        expect(from.mock.calls.length).toBe(0);
        expect(slice.mock.calls.length).toBe(0);
      } finally {
        set.mockRestore();
        concat.mockRestore();
        from.mockRestore();
        slice.mockRestore();
      }
      // A deterministic copy-work bound, not a wall-clock performance assertion.
      expect(copiedBytes).toBe(wire.length);
      expect(actual).toHaveLength(1);
      expect(actual[0]!.byteLength).toBe(payload.length);
      expect(Buffer.compare(actual[0]!, payload)).toBe(0);
    },
  );

  it("emits nothing for a length prefix with no payload yet", () => {
    const parser = new DeviceFramePrefixParser();
    const prefixOnly = Buffer.alloc(4);
    prefixOnly.writeUInt32LE(64, 0);

    expect(parser.push(prefixOnly)).toHaveLength(0);
  });
});

/**
 * The helper writes a full contract envelope and `DeviceFrameTransport`
 * re-encodes one with the routing device id it already has. Forwarding the
 * helper's record whole therefore leaves two headers in front of the access
 * unit, and every frame fails to decode in the browser with a bare "Decoding
 * error" — which is what shipped before this was caught end to end.
 */
describe("helper frame envelope handling", () => {
  it("yields an access unit the transport can re-envelope exactly once", () => {
    const accessUnit = new Uint8Array([0, 0, 0, 1, 0x67, 0x42, 0, 0x33]);
    const parser = new DeviceFramePrefixParser();

    const [helperRecord] = parser.push(record({ payload: accessUnit, keyframe: true }));
    if (!helperRecord) throw new Error("expected one record");

    // What the socket handler does before handing the frame to the transport.
    const decoded = decodeDeviceFrame(helperRecord);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(Array.from(decoded.frame.payload)).toEqual(Array.from(accessUnit));

    // What the transport then puts on the wire, and what the browser decodes.
    const republished = decodeDeviceFrame(
      encodeDeviceFrame({ header: decoded.frame.header, payload: decoded.frame.payload }),
    );
    expect(republished.ok).toBe(true);
    if (!republished.ok) return;
    expect(Array.from(republished.frame.payload)).toEqual(Array.from(accessUnit));
    expect(republished.frame.header.keyframe).toBe(true);
  });
});

describe("device point bounds", () => {
  const attachment = {
    udid: DEVICE,
    pointWidth: 402,
    pointHeight: 874,
    pixelWidth: 1206,
    pixelHeight: 2622,
    scale: 3,
    inputAvailable: true,
    accessibilityAvailable: true,
  };

  /** A client with a fixed attachment, so normalize() can be exercised alone. */
  const attachedClient = () => {
    const client = new HelperClient({ binaryPath: "/nonexistent" });
    (client as unknown as { attachment: typeof attachment }).attachment = attachment;
    return client;
  };

  it("maps in-bounds device points onto the 0..1 range the helper wants", () => {
    expect(attachedClient().normalize(201, 437)).toEqual({ x: 0.5, y: 0.5 });
    expect(attachedClient().normalize(0, 0)).toEqual({ x: 0, y: 0 });
    expect(attachedClient().normalize(402, 874)).toEqual({ x: 1, y: 1 });
  });

  it("rejects a coordinate past the right edge instead of clamping it", () => {
    // 1019 is a frame pixel on a 1206px canvas. Clamping pinned this to the
    // screen edge and reported success, which hid the whole pixel-vs-point bug.
    expect(() => attachedClient().normalize(1019, 400)).toThrow(/outside the screen bounds/u);
  });

  it("rejects a coordinate past the bottom edge", () => {
    expect(() => attachedClient().normalize(200, 2000)).toThrow(/outside the screen bounds/u);
  });

  it("rejects negative and non-finite coordinates", () => {
    expect(() => attachedClient().normalize(-1, 100)).toThrow(/outside the screen bounds/u);
    expect(() => attachedClient().normalize(100, Number.NaN)).toThrow(/outside the screen bounds/u);
  });

  it("names the valid bounds and the scale so the caller can see the mistake", () => {
    // "1019 is outside 0..402 (402x874 at 3x)" makes the scale factor obvious.
    expect(() => attachedClient().normalize(1019, 400)).toThrow(/0\.\.402/u);
    expect(() => attachedClient().normalize(1019, 400)).toThrow(/402x874 points at 3x/u);
    expect(() => attachedClient().normalize(1019, 400)).toThrow(/not frame pixels/u);
  });
});
