import { describe, expect, it } from "vite-plus/test";

import { createHomeSummaryStabilizer } from "./homeDataModel";

const row = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  environmentId: "env-a",
  id,
  updatedAt,
  title: `Thread ${id}`,
  ...extra,
});

describe("home summary stabilizer", () => {
  it("keeps a summary while only its updatedAt moved within the tolerance", () => {
    const stabilize = createHomeSummaryStabilizer(30_000);
    const first = row("t1", "2026-11-10T10:00:00.000Z");
    expect(stabilize([first])[0]).toBe(first);
    const tick = row("t1", "2026-11-10T10:00:12.000Z");
    expect(stabilize([tick])[0]).toBe(first);
    // Past the tolerance from the summary Home shows: the new one is taken.
    const later = row("t1", "2026-11-10T10:00:31.000Z");
    expect(stabilize([later])[0]).toBe(later);
  });

  it("takes any other change at once", () => {
    const stabilize = createHomeSummaryStabilizer(30_000);
    const first = row("t1", "2026-11-10T10:00:00.000Z");
    stabilize([first]);
    const renamed = row("t1", "2026-11-10T10:00:01.000Z", { title: "Renamed" });
    expect(stabilize([renamed])[0]).toBe(renamed);
  });

  it("keys rows by machine and thread, and forgets rows that left", () => {
    const stabilize = createHomeSummaryStabilizer(30_000);
    const a = row("t1", "2026-11-10T10:00:00.000Z");
    const b = { ...row("t1", "2026-11-10T10:00:00.000Z"), environmentId: "env-b" };
    expect(stabilize([a, b])).toEqual([a, b]);
    stabilize([b]);
    const again = row("t1", "2026-11-10T10:00:05.000Z");
    expect(stabilize([again, b])[0]).toBe(again);
  });
});
