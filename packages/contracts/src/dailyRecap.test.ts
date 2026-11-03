import { Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { DailyRecapSnapshot } from "./dailyRecap.ts";

const emptySection = { totalThreads: 0, threads: [], truncated: false };
const snapshot = {
  date: "2026-10-02",
  timeZone: "Europe/Berlin",
  generatedAt: "2026-10-02T18:00:00.000Z",
  from: "2026-10-01T22:00:00.000Z",
  to: "2026-10-02T22:00:00.000Z",
  counts: { completedTurns: 3, failedTurns: 1, interruptedTurns: 0 },
  completed: {
    totalThreads: 1,
    threads: [
      {
        threadId: "thread-1",
        threadTitle: "Fix the build",
        projectId: "project-1",
        projectTitle: "ryco",
        lastActivityAt: "2026-10-02T17:00:00.000Z",
      },
    ],
    truncated: false,
  },
  failed: emptySection,
  needsAttention: emptySection,
};
const activity = {
  agentMs: 5_400_000,
  projects: [{ projectId: "project-1", projectTitle: "ryco", turns: 4, agentMs: 5_400_000 }],
};

describe("Daily recap contracts", () => {
  const decode = Schema.decodeUnknownSync(DailyRecapSnapshot);

  it("decodes a recap from a node that predates activity", () => {
    expect(decode(snapshot).activity).toBeUndefined();
  });

  it("round-trips a recap with activity", () => {
    const decoded = decode({ ...snapshot, activity });
    expect(decoded.activity).toEqual(activity);
    expect(Schema.encodeSync(DailyRecapSnapshot)(decoded)).toEqual({ ...snapshot, activity });
  });

  it("ignores fields a newer node adds", () => {
    const decoded = decode({
      ...snapshot,
      activity: { ...activity, slots: [] },
      highlights: ["Shipped the release"],
    });
    expect(decoded).toEqual({ ...snapshot, activity });
  });

  it("rejects fractional or negative agent time", () => {
    expect(() => decode({ ...snapshot, activity: { ...activity, agentMs: 1.5 } })).toThrow();
    expect(() => decode({ ...snapshot, activity: { ...activity, agentMs: -1 } })).toThrow();
  });
});
