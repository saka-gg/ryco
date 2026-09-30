import { describe, expect, it } from "vite-plus/test";
import { summarizeTests, type TestReport } from "./summarize-tests.ts";

describe("CI timing summary", () => {
  it("combines package counts, orders slow files, and keeps paths readable", () => {
    const reports: TestReport[] = [
      {
        numPassedTests: 2,
        numFailedTests: 1,
        numPendingTests: 0,
        testResults: [{ name: "/repo/apps/web/fast.test.ts", startTime: 10, endTime: 110 }],
      },
      {
        numPassedTests: 3,
        numFailedTests: 0,
        numPendingTests: 2,
        testResults: [
          { name: "/repo/apps/server/slow|name.test.ts", startTime: 10, endTime: 2010 },
        ],
      },
    ];
    const summary = summarizeTests(reports, "/repo");
    expect(summary).toContain("5 passed · 1 failed · 2 skipped");
    expect(summary).toContain("apps/server/slow name.test.ts | 2.00");
    expect(summary.indexOf("slow name")).toBeLessThan(summary.indexOf("fast.test"));
    expect(summary).not.toContain("/repo/");
    expect(summarizeTests([], "/repo")).toBe("No test reports were produced.\n");
  });
});
