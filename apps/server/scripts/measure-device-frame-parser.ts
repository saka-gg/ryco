/**
 * From the repository root (pinned Bun):
 *   bun apps/server/scripts/measure-device-frame-parser.ts
 * Optional read size in bytes (default 1024):
 *   bun apps/server/scripts/measure-device-frame-parser.ts 65536
 *
 * Measures actual Uint8Array.set copy work separately from uninstrumented time.
 * The legacy column models the removed Buffer.from + growing Buffer.concat +
 * final slice exactly for one record. It avoids executing gigabytes of copies.
 * Only deterministic copy counts are asserted; timings are informational.
 */
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";

import { DeviceFramePrefixParser, encodeFrameRecord } from "../src/device/helperClient.ts";

const readBytes = Number(process.argv[2] ?? 1024);
assert(Number.isSafeInteger(readBytes) && readBytes > 0, "read size must be a positive integer");

function parse(wire: Uint8Array): Uint8Array {
  const parser = new DeviceFramePrefixParser();
  let result: Uint8Array | undefined;
  for (let offset = 0; offset < wire.length; offset += readBytes) {
    for (const frame of parser.push(wire.subarray(offset, offset + readBytes))) {
      assert.equal(result, undefined, "expected exactly one frame");
      result = frame;
    }
  }
  assert(result);
  return result;
}

const rows = [];
for (const mib of [1, 2, 4, 8]) {
  const payload = new Uint8Array(mib * 1024 * 1024).fill(0xa5);
  const wire = encodeFrameRecord(payload);
  let copiedBytes = 0;
  const originalSet = Uint8Array.prototype.set;
  let result: Uint8Array;
  try {
    // Temporary, synchronous instrumentation; restored before timing or reporting.
    // eslint-disable-next-line no-extend-native
    Uint8Array.prototype.set = function (source, offset) {
      copiedBytes += source.length;
      originalSet.call(this, source, offset);
    };
    result = parse(wire);
  } finally {
    // eslint-disable-next-line no-extend-native
    Uint8Array.prototype.set = originalSet;
  }
  assert.equal(copiedBytes, wire.length, "each wire byte must be copied exactly once");
  assert.equal(Buffer.compare(result, payload), 0);

  let legacyCopiedBytes = wire.length + payload.length;
  for (let offset = readBytes; offset < wire.length; offset += readBytes) {
    legacyCopiedBytes += Math.min(offset + readBytes, wire.length);
  }

  // Warm up before reporting a median of five independent parses. Setup,
  // instrumentation and content validation are outside the timing interval.
  parse(wire);
  const times = [];
  for (let iteration = 0; iteration < 5; iteration++) {
    const start = performance.now();
    const frame = parse(wire);
    times.push(performance.now() - start);
    assert.equal(Buffer.compare(frame, payload), 0);
  }
  times.sort((a, b) => a - b);
  rows.push({
    payloadMiB: mib,
    reads: Math.ceil(wire.length / readBytes),
    copiedBytes,
    legacyCopiedBytes,
    copyReduction: `${(legacyCopiedBytes / copiedBytes).toFixed(1)}x`,
    medianMs: times[2]!.toFixed(3),
  });
}
console.log(`DeviceFramePrefixParser: ${readBytes}-byte reads; time is informational.`);
console.table(rows);
