import { describe, expect, it } from "vitest";

import {
  chunkUtf8,
  encodeKeycode,
  encodeSetClipboard,
  encodeText,
  encodeTouch,
  SCRCPY_CODEC_H264,
  ScrcpyDeviceMessageParser,
  ScrcpyProtocolError,
  ScrcpyTouchAction,
  ScrcpyVideoParser,
} from "./scrcpyProtocol.ts";
import { mediaPacket, sessionPacket } from "./scrcpyTestServer.ts";

describe("scrcpy control messages", () => {
  it("lays out a touch as scrcpy 5 reads it", () => {
    const bytes = Buffer.from(
      encodeTouch(ScrcpyTouchAction.move, 540.4, 1200.6, { width: 1080, height: 2280 }),
    );
    expect(bytes.byteLength).toBe(32);
    expect(bytes[0]).toBe(2);
    expect(bytes[1]).toBe(2);
    expect(bytes.readBigInt64BE(2)).toBe(-2n);
    expect([bytes.readInt32BE(10), bytes.readInt32BE(14)]).toEqual([540, 1201]);
    expect([bytes.readUInt16BE(18), bytes.readUInt16BE(20)]).toEqual([1080, 2280]);
    expect(bytes.readUInt16BE(22)).toBe(0xffff);
    const up = Buffer.from(encodeTouch(ScrcpyTouchAction.up, 1, 1, { width: 10, height: 10 }));
    expect(up.readUInt16BE(22)).toBe(0);
  });

  it("encodes keys, bounded text and clipboard with a sequence", () => {
    const key = Buffer.from(encodeKeycode(1, 66, 0x1000));
    expect([key[0], key[1], key.readInt32BE(2), key.readInt32BE(6), key.readInt32BE(10)]).toEqual([
      0, 1, 66, 0, 0x1000,
    ]);
    const text = Buffer.from(encodeText("héllo"));
    expect(text[0]).toBe(1);
    expect(text.readUInt32BE(1)).toBe(6);
    expect(text.subarray(5).toString("utf8")).toBe("héllo");
    expect(() => encodeText("x".repeat(301))).toThrow(RangeError);
    const clipboard = Buffer.from(encodeSetClipboard("😀", true, 7n));
    expect([
      clipboard[0],
      clipboard.readBigInt64BE(1),
      clipboard[9],
      clipboard.readUInt32BE(10),
    ]).toEqual([9, 7n, 1, 4]);
  });

  it("splits text without cutting characters", () => {
    expect(chunkUtf8("ab😀cd", 5)).toEqual(["ab", "😀c", "d"]);
    expect(chunkUtf8("", 5)).toEqual([]);
    expect(chunkUtf8("é".repeat(4), 3).every((chunk) => Buffer.byteLength(chunk) <= 3)).toBe(true);
  });
});

describe("scrcpy video stream", () => {
  it("reads the dummy byte, codec, session and media packets across split chunks", () => {
    const codec = Buffer.alloc(4);
    codec.writeUInt32BE(SCRCPY_CODEC_H264);
    const stream = Buffer.concat([
      Buffer.from([0]),
      codec,
      sessionPacket(758, 1600),
      mediaPacket({ config: true, pts: 0n, data: [0, 0, 0, 1, 0x67] }),
      mediaPacket({ key: true, pts: 16_666n, data: [0, 0, 0, 1, 0x65, 1, 2] }),
      mediaPacket({ pts: 33_333n, data: [0, 0, 0, 1, 0x41] }),
    ]);
    const parser = new ScrcpyVideoParser({ dummyByte: true });
    const events = [];
    for (let offset = 0; offset < stream.byteLength; offset += 5)
      events.push(...parser.push(stream.subarray(offset, offset + 5)));
    expect(events.map((event) => event.kind)).toEqual([
      "codec",
      "session",
      "packet",
      "packet",
      "packet",
    ]);
    expect(events[0]).toEqual({ kind: "codec", codecId: SCRCPY_CODEC_H264 });
    expect(events[1]).toEqual({ kind: "session", width: 758, height: 1600 });
    expect(events[2]).toMatchObject({ config: true, keyframe: false, ptsUs: 0n });
    expect(events[3]).toMatchObject({ config: false, keyframe: true, ptsUs: 16_666n });
    expect(Array.from((events[4] as { data: Uint8Array }).data)).toEqual([0, 0, 0, 1, 0x41]);
  });

  it("refuses a desynchronized stream instead of buffering it", () => {
    const parser = new ScrcpyVideoParser({ dummyByte: false });
    parser.push(Buffer.from([0x68, 0x32, 0x36, 0x34]));
    const header = Buffer.alloc(12);
    header.writeUInt32BE(64 * 1024 * 1024, 8);
    expect(() => parser.push(header)).toThrow(ScrcpyProtocolError);
    expect(() =>
      new ScrcpyVideoParser({ dummyByte: false }).push(
        Buffer.concat([Buffer.alloc(4), sessionPacket(0, 10)]),
      ),
    ).toThrow("Invalid scrcpy video size");
  });
});

describe("scrcpy device messages", () => {
  it("reads clipboard acks and skips other messages", () => {
    const parser = new ScrcpyDeviceMessageParser();
    const ack = Buffer.alloc(9);
    ack[0] = 1;
    ack.writeBigUInt64BE(42n, 1);
    const clipboard = Buffer.concat([Buffer.from([0, 0, 0, 0, 2]), Buffer.from("hi")]);
    const uhid = Buffer.from([2, 0, 1, 0, 1, 9]);
    const all = Buffer.concat([clipboard, uhid, ack]);
    expect(parser.push(all.subarray(0, 4))).toEqual([]);
    expect(parser.push(all.subarray(4))).toEqual([
      { kind: "clipboard", text: "hi" },
      { kind: "uhid-output" },
      { kind: "ack-clipboard", sequence: 42n },
    ]);
    expect(() => parser.push(Buffer.from([9]))).toThrow("Unknown scrcpy device message");
  });
});
