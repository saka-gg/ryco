import { describe, expect, it } from "vite-plus/test";

import { makeCdpFrameReader, type CdpFrame } from "./cdpFrameReader.ts";

const limits = { maxReplyChars: 1_000, maxEventChars: 100 };

/** Feeds `chunks` in order and returns every frame they complete. */
const read = (chunks: ReadonlyArray<string>, readerLimits = limits) => {
  const reader = makeCdpFrameReader(readerLimits);
  return chunks.flatMap((chunk): ReadonlyArray<CdpFrame> => reader.push(chunk));
};

const message = (text: string): CdpFrame => ({ _tag: "Message", text });

describe("makeCdpFrameReader", () => {
  it("joins messages split anywhere and splits chunks holding several", () => {
    expect(read(['{"id":1}\0{"id"', ':2,"result":{}}', '\0{"method":"A"}\0{"me'])).toEqual([
      message('{"id":1}'),
      message('{"id":2,"result":{}}'),
      message('{"method":"A"}'),
    ]);
  });

  it("drops an event past its limit, keeping only what names it, and reads on", () => {
    const big = "x".repeat(10_000);
    const frames = read([
      '{"method":"Runtime.consoleAPICalled","params":{"type":"log","args":[{"type":"string","value":"',
      ...Array.from({ length: 50 }, () => big),
      '"}]},"sessionId":"S1"}\0{"id":3}\0',
    ]);
    expect(frames).toHaveLength(2);
    const [dropped, next] = frames;
    expect(dropped).toMatchObject({ _tag: "Oversized" });
    if (dropped?._tag !== "Oversized") return;
    expect(dropped.head).toMatch(/^\{"method":"Runtime\.consoleAPICalled","params":\{"type":"log"/);
    expect(dropped.head.length).toBeLessThanOrEqual(256);
    expect(dropped.tail).toMatch(/"sessionId":"S1"\}$/);
    expect(dropped.tail.length).toBeLessThanOrEqual(256);
    expect(next).toEqual(message('{"id":3}'));
  });

  it("allows replies more room than events", () => {
    const reply = `{"id":4,"result":{"data":"${"y".repeat(500)}"}}`;
    const event = `{"method":"B","params":{"data":"${"y".repeat(500)}"}}`;
    expect(read([reply, "\0", event, "\0"])).toEqual([
      message(reply),
      { _tag: "Oversized", head: event.slice(0, 256), tail: event.slice(-256) },
    ]);
    const huge = `{"id":5,"result":{"data":"${"z".repeat(2_000)}"}}`;
    expect(read([huge.slice(0, 900), huge.slice(900), "\0"])).toEqual([
      { _tag: "Oversized", head: huge.slice(0, 256), tail: huge.slice(-256) },
    ]);
  });

  it("holds no more of an oversized message than its limit", () => {
    const reader = makeCdpFrameReader({ maxReplyChars: 1_000, maxEventChars: 1_000 });
    const chunk = "w".repeat(64 * 1024);
    reader.push('{"method":"C","params":{"v":"');
    // Far past the limit; were it buffered, this would hold 640 MB.
    for (let index = 0; index < 10_000; index += 1) {
      expect(reader.push(chunk)).toEqual([]);
    }
    expect(reader.push('"},"sessionId":"S2"}\0')).toEqual([
      expect.objectContaining({ _tag: "Oversized", tail: expect.stringMatching(/"S2"\}$/) }),
    ]);
  });
});
