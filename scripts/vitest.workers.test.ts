import { describe, expect, it } from "vite-plus/test";

import { vitestMaxWorkers } from "../vitest.workers.ts";

const defaults = { ci: 4, localMax: 4 };

describe("vitestMaxWorkers", () => {
  it("uses CI's count, but never more workers than cores", () => {
    expect(vitestMaxWorkers(defaults, { CI: "true" }, 4)).toBe(4);
    expect(vitestMaxWorkers(defaults, { CI: "true" }, 16)).toBe(4);
    expect(vitestMaxWorkers(defaults, { CI: "true" }, 2)).toBe(2);
  });

  it("takes at most half the cores locally, and at least one worker", () => {
    expect(vitestMaxWorkers(defaults, {}, 18)).toBe(4);
    expect(vitestMaxWorkers(defaults, {}, 6)).toBe(3);
    expect(vitestMaxWorkers(defaults, {}, 1)).toBe(1);
  });

  it("lets RYCO_TEST_MAX_WORKERS override every default, CI included", () => {
    expect(vitestMaxWorkers(defaults, { RYCO_TEST_MAX_WORKERS: "2" }, 18)).toBe(2);
    expect(vitestMaxWorkers(defaults, { RYCO_TEST_MAX_WORKERS: " 8 " }, 4)).toBe(8);
    expect(vitestMaxWorkers(defaults, { CI: "true", RYCO_TEST_MAX_WORKERS: "1" }, 4)).toBe(1);
    // Empty means unset, as when a shell exports the variable without a value.
    expect(vitestMaxWorkers(defaults, { RYCO_TEST_MAX_WORKERS: "" }, 18)).toBe(4);
  });

  it("rejects an override that is not a positive integer instead of guessing", () => {
    for (const value of ["0", "-1", "1.5", "50%", "four"]) {
      expect(() => vitestMaxWorkers(defaults, { RYCO_TEST_MAX_WORKERS: value }, 4)).toThrow(
        /RYCO_TEST_MAX_WORKERS must be a positive integer/,
      );
    }
  });
});
