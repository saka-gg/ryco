/**
 * Micro-benchmark for the client runtime's retained-size estimate; run with Node.
 *
 *   node scripts/perf/micro/client-retained-size.ts
 *
 * Compares `JSON.stringify(value).length`, which the thread-detail eviction budget used per live
 * activity event and per window snapshot, with the walk that replaced it.
 */
import { approximateJsonSize } from "../../../packages/client-runtime/src/connection/approximateJsonSize.ts";

const activity = {
  id: "activity-1",
  tone: "tool",
  kind: "tool.completed",
  summary: "Ran the test suite",
  payload: {
    detail: "y".repeat(20_000),
    items: Array.from({ length: 50 }, (_, index) => ({ index, path: `src/file-${index}.ts` })),
  },
  turnId: null,
  createdAt: "2026-10-12T00:00:00.000Z",
};

const bench = (run: () => number) => {
  for (let index = 0; index < 2_000; index += 1) run();
  const startedAt = performance.now();
  let sink = 0;
  for (let index = 0; index < 20_000; index += 1) sink += run();
  return {
    microseconds: Math.round(((performance.now() - startedAt) * 1000 * 100) / 20_000) / 100,
    sink,
  };
};

const exact = bench(() => JSON.stringify(activity).length);
const approximate = bench(() => approximateJsonSize(activity));
console.log(
  JSON.stringify(
    {
      jsonStringifyMicroseconds: exact.microseconds,
      approximateMicroseconds: approximate.microseconds,
      exactBytes: JSON.stringify(activity).length,
      approximateBytes: approximateJsonSize(activity),
    },
    null,
    2,
  ),
);
