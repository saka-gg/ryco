import { describe, expect, it } from "vite-plus/test";
import { browserTestDurations, type BrowserTestReport } from "./browser-durations.ts";

const web = "/home/runner/work/ryco/ryco/apps/web";

function file(name: string, startTime: number, endTime: number, statuses = ["passed"]) {
  return {
    name: `${web}/${name}`,
    startTime,
    endTime,
    assertionResults: statuses.map((status) => ({ status })),
  };
}

describe("browser test durations", () => {
  it("charges each file its test time plus the lead-in since the previous file", () => {
    const report: BrowserTestReport = {
      testResults: [
        // Out of order on purpose: the reporter lists files by completion.
        file("src/components/B.browser.tsx", 5_000, 6_000),
        file("src/components/A.browser.tsx", 1_000, 3_000),
        file("src/components/C.browser.tsx", 10_000, 10_500, ["passed", "failed"]),
      ],
    };
    expect(browserTestDurations([report])).toEqual({
      // The first file has no predecessor, so it gets the mean gap (2 s, 4 s).
      "src/components/A.browser.tsx": 5,
      "src/components/B.browser.tsx": 3,
      "src/components/C.browser.tsx": 4.5,
    });
  });

  it("skips files without executed tests and anything outside the browser suite", () => {
    const report: BrowserTestReport = {
      testResults: [
        // Import failures report the run's start as their start time.
        file("src/components/Broken.browser.tsx", 0, 0, []),
        file("src/components/Skipped.browser.tsx", 0, 0, ["skipped"]),
        file("src/components/A.browser.tsx", 1_000, 2_000),
        file("src/lib/unit.test.ts", 2_000, 2_500),
        file("src/components/B.browser.tsx", 3_000, 4_000),
      ],
    };
    expect(browserTestDurations([report])).toEqual({
      "src/components/A.browser.tsx": 2,
      "src/components/B.browser.tsx": 2,
    });
  });

  it("averages runs and orders files by code unit", () => {
    const run = (seconds: number): BrowserTestReport => ({
      testResults: [
        file("src/components/a.browser.tsx", 0, 1_000),
        file("src/components/Z.browser.tsx", 1_000, 1_000 + seconds * 1_000),
      ],
    });
    const durations = browserTestDurations([run(1), run(2), run(4)]);
    expect(durations["src/components/Z.browser.tsx"]).toBe(2.33);
    expect(Object.keys(durations)).toEqual([
      "src/components/Z.browser.tsx",
      "src/components/a.browser.tsx",
    ]);
  });
});
