import { describe, expect, it } from "vitest";

import { busyRetryDelayMs, isRetryableSqliteBusy } from "./sqliteBusy.ts";

describe("sqliteBusy", () => {
  it("retries SQLITE_BUSY and its waitable extended codes only", () => {
    expect(isRetryableSqliteBusy({ errcode: 5 })).toBe(true);
    expect(isRetryableSqliteBusy({ errcode: 261 })).toBe(true); // BUSY_RECOVERY
    expect(isRetryableSqliteBusy({ errcode: 773 })).toBe(true); // BUSY_TIMEOUT
    expect(isRetryableSqliteBusy({ errcode: 517 })).toBe(false); // BUSY_SNAPSHOT
    expect(isRetryableSqliteBusy({ errcode: 6 })).toBe(false); // LOCKED
    expect(isRetryableSqliteBusy({ errcode: 1 })).toBe(false);
    expect(isRetryableSqliteBusy(new Error("database is locked"))).toBe(false);
    expect(isRetryableSqliteBusy(null)).toBe(false);
  });

  it("backs off exponentially up to 100 ms", () => {
    expect([0, 1, 2, 3, 4, 5, 6, 20].map(busyRetryDelayMs)).toEqual([
      5, 10, 20, 40, 80, 100, 100, 100,
    ]);
  });
});
