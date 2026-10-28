import { describe, expect, it } from "vite-plus/test";

import {
  decodeMeasureResults,
  decodeRenderReport,
  endedInWindowWarning,
  formatComparison,
  formatSummary,
  median,
  percentChange,
  pickInspectorTarget,
  remoteCommand,
  type RenderCounterReport,
  routeLink,
  summarize,
  threadLink,
} from "./measureRendersReport.mts";

function report(
  commits: number,
  components: Record<string, number>,
  causes: Record<string, number> = {},
): RenderCounterReport {
  const entries = (counts: Record<string, number>) =>
    Object.entries(counts).map(([key, count]) => ({ key, count }));
  return {
    commits,
    totalRenders: Object.values(components).reduce((total, count) => total + count, 0),
    windowMs: 12_000,
    components: entries(components),
    causes: entries(causes),
    walkErrors: 0,
  };
}

describe("median", () => {
  it("takes the middle value, or the mean of the two middle values", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([7])).toBe(7);
  });

  it("refuses an empty list", () => {
    expect(() => median([])).toThrow("No values");
  });
});

describe("decodeRenderReport", () => {
  const valid = {
    commits: 3,
    totalRenders: 4,
    windowMs: 12_000,
    components: [{ key: "Row", count: 4 }],
    causes: [{ key: "Row props:item", count: 4 }],
    walkErrors: 1,
  };

  it("decodes the JSON string the inspector returns", () => {
    expect(decodeRenderReport(JSON.stringify(valid))).toEqual(valid);
  });

  it("reads a report saved before walk errors were reported as having none", () => {
    const { walkErrors: _walkErrors, ...older } = valid;
    expect(decodeRenderReport(older)).toEqual({ ...valid, walkErrors: 0 });
    expect(() => decodeRenderReport({ ...valid, walkErrors: "1" })).toThrow('"walkErrors"');
  });

  it("rejects a report with a missing or malformed field", () => {
    const { windowMs: _windowMs, ...missing } = valid;
    expect(() => decodeRenderReport(missing)).toThrow('"windowMs"');
    expect(() => decodeRenderReport({ ...valid, components: [{ count: 1 }] })).toThrow(
      "components[0] has no string key",
    );
    expect(() => decodeRenderReport({ ...valid, commits: -1 })).toThrow('"commits"');
    expect(() => decodeRenderReport("{")).toThrow("not valid JSON");
    expect(() => decodeRenderReport(null)).toThrow("not an object");
  });
});

describe("summarize", () => {
  it("takes medians per metric and per component, counting a missing component as 0", () => {
    const summary = summarize([
      report(10, { Row: 30, Header: 10 }, { "Row props:item": 30 }),
      report(20, { Row: 20 }, { "Row props:item": 20 }),
      report(10, { Row: 40, Header: 2 }, { "Row props:item": 40 }),
    ]);

    expect(summary).toEqual({
      runs: 3,
      // Per run: 40/10, 20/20, 42/10.
      rendersPerCommit: 4,
      renders: 40,
      commits: 10,
      windowMs: 12_000,
      components: [
        { key: "Row", count: 30 },
        { key: "Header", count: 2 },
      ],
      causes: [{ key: "Row props:item", count: 30 }],
    });
  });

  it("drops components whose median is zero", () => {
    const summary = summarize([report(1, { Rare: 5 }), report(1, {}), report(1, {})]);
    expect(summary.components).toEqual([]);
  });

  it("refuses to summarize no runs", () => {
    expect(() => summarize([])).toThrow("No successful runs");
  });
});

describe("tables", () => {
  it("leads the summary with renders per commit", () => {
    const text = formatSummary(summarize([report(4, { Row: 6, "A|B": 2 })]), {
      label: "before",
    });
    expect(text.split("\n").slice(0, 7)).toEqual([
      "before: median of 1 run, 12.0 s window",
      "",
      "| metric | value |",
      "| --- | ---: |",
      "| renders per commit | 2.00 |",
      "| renders | 8 |",
      "| commits | 4 |",
    ]);
    expect(text).toContain("| `A\\|B` | 2 |");
  });

  it("signs percent changes", () => {
    expect(percentChange(200, 150)).toBe("-25.0%");
    expect(percentChange(3, 4)).toBe("+33.3%");
    expect(percentChange(5, 5)).toBe("0.0%");
    expect(percentChange(0, 0)).toBe("0.0%");
    expect(percentChange(0, 3)).toBe("new");
  });

  it("compares before and after, including components only one side has", () => {
    const before = summarize([report(10, { Row: 30, Old: 5 })]);
    const after = summarize([report(10, { Row: 15, New: 1 })]);
    expect(formatComparison(before, after).split("\n")).toEqual([
      "before: median of 1 run; after: median of 1 run",
      "",
      "| metric | before | after | change |",
      "| --- | ---: | ---: | ---: |",
      "| renders per commit | 3.50 | 1.60 | -54.3% |",
      "| renders | 35 | 16 | -54.3% |",
      "| commits | 10 | 10 | 0.0% |",
      "",
      "| component | before | after | change |",
      "| --- | ---: | ---: | ---: |",
      "| `Row` | 30 | 15 | -50.0% |",
      "| `Old` | 5 | 0 | -100.0% |",
      "| `New` | 0 | 1 | new |",
    ]);
  });
});

describe("decodeMeasureResults", () => {
  it("reads back what the driver writes", () => {
    const results = {
      version: 1,
      label: "before",
      mode: "stream",
      target: "ryco-dev://threads/env/thread-1",
      windowSeconds: 12,
      createdAt: "2026-10-23T20:00:00.000Z",
      runs: [
        {
          run: 1,
          report: report(2, { Row: 2 }),
          threadId: "thread-1",
          priorRunsOnThread: 0,
          streamingEndedInWindow: false,
          replyChars: 12_345,
        },
      ],
    };
    expect(decodeMeasureResults(JSON.parse(JSON.stringify(results)))).toEqual(results);
  });

  it("rejects other files", () => {
    expect(() => decodeMeasureResults({ version: 2 })).toThrow("version 1");
    expect(() => decodeMeasureResults({ version: 1, mode: "other", runs: [] })).toThrow('"mode"');
  });
});

describe("endedInWindowWarning", () => {
  const run = (number: number, streamingEndedInWindow?: boolean) => ({
    run: number,
    report: report(1, { Row: 1 }),
    ...(streamingEndedInWindow === undefined ? {} : { streamingEndedInWindow }),
  });

  it("names the runs whose turn ended inside the window", () => {
    expect(endedInWindowWarning("after", [run(1, false), run(2, true), run(3, true)])).toBe(
      "warning: after: the turn ended inside the window in runs 2, 3 of 3; compare renders per commit, not totals.",
    );
    expect(endedInWindowWarning("before", [run(1, true), run(2, false)])).toBe(
      "warning: before: the turn ended inside the window in run 1 of 2; compare renders per commit, not totals.",
    );
  });

  it("says nothing when every turn streamed through its window, or for route runs", () => {
    expect(endedInWindowWarning("before", [run(1, false), run(2, false)])).toBeNull();
    expect(endedInWindowWarning("settings", [run(1), run(2)])).toBeNull();
  });
});

describe("pickInspectorTarget", () => {
  const target = (appId: string, url: string) => ({
    appId,
    title: `${appId} runtime`,
    webSocketDebuggerUrl: url,
  });

  it("picks the last target of the app, which is the newest runtime after a reload", () => {
    expect(
      pickInspectorTarget(
        [
          target("dev.ryco.app.dev", "ws://old"),
          target("com.other.app", "ws://other"),
          target("dev.ryco.app.dev", "ws://new"),
          { appId: "dev.ryco.app.dev" },
        ],
        "dev.ryco.app.dev",
      ),
    ).toEqual({
      appId: "dev.ryco.app.dev",
      title: "dev.ryco.app.dev runtime",
      webSocketDebuggerUrl: "ws://new",
    });
  });

  it("lists the app ids it saw when the app is missing", () => {
    expect(() =>
      pickInspectorTarget(
        [target("com.other.app", "ws://a"), target("com.other.app", "ws://b")],
        "dev.ryco.app.dev",
      ),
    ).toThrow('No inspector target for app id "dev.ryco.app.dev". Metro lists: com.other.app.');
    expect(() => pickInspectorTarget([], "dev.ryco.app.dev")).toThrow("is the app open");
    expect(() => pickInspectorTarget({}, "dev.ryco.app.dev")).toThrow("list of targets");
  });
});

describe("links", () => {
  it("encodes thread ids and strips a route's leading slash", () => {
    expect(threadLink("ryco-dev", "env 1", "thread/2")).toBe(
      "ryco-dev://threads/env%201/thread%2F2",
    );
    expect(routeLink("ryco-dev", "/settings")).toBe("ryco-dev://settings");
    expect(routeLink("ryco", "settings/hub")).toBe("ryco://settings/hub");
  });
});

describe("remoteCommand", () => {
  const ryco = ["node", "/repo/apps/server/src/bin.ts"];

  it("puts --base-dir after the remote verb, the only place the CLI accepts it", () => {
    expect(remoteCommand(ryco, "/scratch", "list", ["--json"])).toEqual({
      command: "node",
      args: ["/repo/apps/server/src/bin.ts", "remote", "list", "--base-dir", "/scratch", "--json"],
    });
    expect(remoteCommand(ryco, "/scratch", "send", ["measure", "thread-1", "Hi"])).toEqual({
      command: "node",
      args: [
        "/repo/apps/server/src/bin.ts",
        "remote",
        "send",
        "--base-dir",
        "/scratch",
        "measure",
        "thread-1",
        "Hi",
      ],
    });
  });

  it("leaves the state dir to RYCO_HOME without --base-dir", () => {
    expect(remoteCommand(["ryco"], undefined, "list", ["--json"])).toEqual({
      command: "ryco",
      args: ["remote", "list", "--json"],
    });
  });

  it("refuses an empty --ryco command", () => {
    expect(() => remoteCommand([], undefined, "list", ["--json"])).toThrow("--ryco is empty");
  });
});
