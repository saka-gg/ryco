import { mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  escapePredicateString,
  parseCrashReport,
  readCrashReports,
  simulatorLogResult,
  tailLines,
  unifiedLogArguments,
} from "./deviceLogs.ts";

const UDID = "375CE30B-AC7C-4334-9059-59B6704D430E";

function crashReport(input: { readonly procPath: string; readonly signal?: string }): string {
  const header = JSON.stringify({ app_name: "Shop", bug_type: "309" });
  const body = JSON.stringify({
    procPath: input.procPath,
    exception: { type: "EXC_CRASH", signal: input.signal ?? "SIGABRT" },
    asi: { "libswiftCore.dylib": ["Fatal error: Unexpectedly found nil"] },
    termination: { indicator: "Abort trap: 6" },
  });
  return `${header}\n${body}`;
}

let directory: string | null = null;
afterEach(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
  directory = null;
});

describe("unifiedLogArguments", () => {
  const query = { bundleId: "com.example.shop", sinceSeconds: 120, limit: 50 } as const;

  it("scopes to the process and keeps Apple subsystems only at error level", () => {
    const args = unifiedLogArguments("Shop", { ...query, level: "default" });

    expect(args.slice(0, 5)).toEqual(["show", "--last", "120s", "--style", "compact"]);
    expect(args.at(-2)).toBe("--predicate");
    expect(args.at(-1)).toBe(
      'process == "Shop" AND eventType == logEvent AND (NOT subsystem BEGINSWITH "com.apple." OR messageType == error OR messageType == fault)',
    );
  });

  it("adds info and debug flags for the lower levels and narrows error to errors and faults", () => {
    expect(unifiedLogArguments("Shop", { ...query, level: "debug" })).toEqual(
      expect.arrayContaining(["--info", "--debug"]),
    );
    expect(unifiedLogArguments("Shop", { ...query, level: "info" })).toContain("--info");
    expect(unifiedLogArguments("Shop", { ...query, level: "info" })).not.toContain("--debug");
    const error = unifiedLogArguments("Shop", { ...query, level: "error" });
    expect(error).not.toContain("--info");
    expect(error.at(-1)).toBe(
      'process == "Shop" AND eventType == logEvent AND (messageType == error OR messageType == fault)',
    );
  });

  it("escapes quotes and backslashes in the executable name", () => {
    expect(escapePredicateString('My "App"\\x')).toBe('My \\"App\\"\\\\x');
    expect(unifiedLogArguments('My "App"', { ...query, level: "error" }).at(-1)).toContain(
      'process == "My \\"App\\""',
    );
  });

  it("filters by contains at the source, escaped, so a narrow read stays small", () => {
    const args = unifiedLogArguments("Shop", {
      ...query,
      level: "default",
      contains: 'checkout "failed"',
    });

    expect(args.at(-1)).toMatch(/ AND composedMessage CONTAINS\[c\] "checkout \\"failed\\""$/u);
  });

  it("leaves contains with control characters to the post-filter", () => {
    const args = unifiedLogArguments("Shop", { ...query, level: "default", contains: "a\nb" });

    expect(args.at(-1)).not.toContain("composedMessage");
  });

  it("rounds the window and never asks for less than a second", () => {
    expect(unifiedLogArguments("Shop", { ...query, level: "default", sinceSeconds: 0.2 })[2]).toBe(
      "1s",
    );
  });
});

describe("simulatorLogResult", () => {
  const read = (contains: string, stdout: string) =>
    simulatorLogResult({
      query: {
        bundleId: "com.example.shop",
        sinceSeconds: 60,
        level: "default",
        limit: 50,
        contains,
      },
      executable: "Shop",
      result: { stdout, stderr: "", code: 0, signal: null, timedOut: false },
      crashes: [],
    });
  const lines = [
    "2026-10-24 10:00:00.000 Df Shop[1:2] [com.example.shop:ui] tapped\tBuy",
    "2026-10-24 10:00:01.000 Df Shop[1:2] [com.example.shop:ui] opened cart",
  ].join("\n");

  it("trusts the predicate for contains it carried", () => {
    // Both lines came back from a predicate on "buy": neither is re-filtered.
    expect(read("buy", lines).log).toHaveLength(2);
  });

  it("filters by line only the text kept out of the predicate", () => {
    expect(read("\tbuy", lines).log).toEqual([
      "2026-10-24 10:00:00.000 Df Shop[1:2] [com.example.shop:ui] tapped\tBuy",
    ]);
  });
});

describe("tailLines", () => {
  it("keeps the newest lines and cuts long ones", () => {
    const result = tailLines(["a", "b", "c", "x".repeat(600)], 2);

    expect(result.omitted).toBe(2);
    expect(result.lines[0]).toBe("c");
    expect(result.lines[1]).toHaveLength(500);
    expect(result.lines[1]?.endsWith("…")).toBe(true);
  });
});

describe("crash reports", () => {
  it("parses the exception and the abort message", () => {
    const parsed = parseCrashReport(crashReport({ procPath: `/x/${UDID}/Shop.app/Shop` }));

    expect(parsed.exception).toBe("EXC_CRASH (SIGABRT)");
    expect(parsed.reason).toBe("Fatal error: Unexpectedly found nil");
    expect(parsed.procPath).toBe(`/x/${UDID}/Shop.app/Shop`);
  });

  it("falls back to the termination indicator, and to nulls for unreadable reports", () => {
    const header = JSON.stringify({ app_name: "Shop" });
    const body = JSON.stringify({
      exception: { signal: "SIGSEGV" },
      termination: { indicator: "Segmentation fault: 11" },
    });

    expect(parseCrashReport(`${header}\n${body}`)).toEqual({
      procPath: null,
      exception: "SIGSEGV",
      reason: "Segmentation fault: 11",
    });
    expect(parseCrashReport("not json at all")).toEqual({
      procPath: null,
      exception: null,
      reason: null,
    });
  });

  it("returns only recent reports for this simulator, newest first, by file name only", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "ryco-crash-"));
    const now = Date.now();
    const write = async (name: string, contents: string, ageMs: number) => {
      const file = path.join(directory!, name);
      await writeFile(file, contents);
      const time = new Date(now - ageMs);
      await utimes(file, time, time);
    };
    await write("Shop-2026-10-14-010101.ips", crashReport({ procPath: `/d/${UDID}/Shop` }), 5_000);
    await write(
      "Shop-2026-10-14-010202.ips",
      crashReport({ procPath: `/d/${UDID}/Shop`, signal: "SIGSEGV" }),
      1_000,
    );
    await write(
      "Shop-2026-10-13-000000.ips",
      crashReport({ procPath: `/d/${UDID}/Shop` }),
      3_600_000,
    );
    await write("Shop-other.ips", crashReport({ procPath: "/d/OTHER-DEVICE/Shop" }), 1_000);
    await write("Mail-2026.ips", crashReport({ procPath: `/d/${UDID}/Mail` }), 1_000);
    // Another app whose executable name starts with this one's, on the same simulator.
    await write(
      "Shop-Lite-2026-10-14-010303.ips",
      crashReport({ procPath: `/d/${UDID}/Shop-Lite.app/Shop-Lite` }),
      1_000,
    );
    await write("Shop-notes.txt", "not a report", 1_000);

    const reports = await readCrashReports({
      directory,
      executable: "Shop",
      udid: UDID,
      sinceMs: now - 60_000,
    });

    expect(reports.map((report) => report.fileName)).toEqual([
      "Shop-2026-10-14-010202.ips",
      "Shop-2026-10-14-010101.ips",
    ]);
    expect(reports[0]?.exception).toBe("EXC_CRASH (SIGSEGV)");
    expect(JSON.stringify(reports)).not.toContain(directory);
  });

  it("keeps the newest five", async () => {
    directory = await mkdtemp(path.join(tmpdir(), "ryco-crash-"));
    const now = Date.now();
    for (let index = 0; index < 7; index += 1) {
      const file = path.join(directory, `Shop-${index}.ips`);
      await writeFile(file, crashReport({ procPath: `/d/${UDID}/Shop` }));
      const time = new Date(now - index * 1_000);
      await utimes(file, time, time);
    }

    const reports = await readCrashReports({
      directory,
      executable: "Shop",
      udid: UDID,
      sinceMs: now - 60_000,
    });

    expect(reports.map((report) => report.fileName)).toEqual([
      "Shop-0.ips",
      "Shop-1.ips",
      "Shop-2.ips",
      "Shop-3.ips",
      "Shop-4.ips",
    ]);
  });

  it("reads nothing from a directory that does not exist", async () => {
    await expect(
      readCrashReports({
        directory: "/nonexistent/ryco-crash-reports",
        executable: "Shop",
        udid: UDID,
        sinceMs: 0,
      }),
    ).resolves.toEqual([]);
  });
});
