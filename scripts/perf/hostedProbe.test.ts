import { assert, describe, it } from "@effect/vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  chooseRowKey,
  compareHostedSummaries,
  computeCriticalPath,
  formatComparisonTable,
  formatSummaryTable,
  initiatorPath,
  interleavedOrder,
  newTimelineEntries,
  parseOnlineNodes,
  parseThreadRoute,
  readCookieFile,
  runHostedCompare,
  summarizeColdLoadRuns,
  summarizeMetrics,
  summarizeSwitchRuns,
  threadPath,
  type ColdLoadRun,
  type HostedRoute,
  type RecordedRequest,
  type SwitchRun,
} from "./hostedProbe.ts";

function request(
  requestPath: string,
  initiator: string | null,
  startMs: number,
  endMs: number | null,
  extra: Partial<RecordedRequest> = {},
): RecordedRequest {
  return {
    path: requestPath,
    type: "Script",
    initiator,
    startMs,
    endMs,
    transferSize: 100,
    ...extra,
  };
}

function switchRun(overrides: Partial<SwitchRun> = {}): SwitchRun {
  return {
    kind: "cross-node",
    side: null,
    rowKey: "env_a:thread-1",
    clickEpochMs: 1,
    firstFrame: 10,
    route: 20,
    content: 300,
    writable: 400,
    readOnlySeen: null,
    sendAccepted: null,
    detailState: null,
    longTasks: [],
    timedOut: false,
    profiled: false,
    error: null,
    timelines: [],
    ...overrides,
  };
}

describe("hosted probe statistics", () => {
  it("alternates which side is measured first", () => {
    assert.deepStrictEqual(
      [0, 1, 2, 3].map((iteration) => interleavedOrder(iteration)[0]),
      ["baseline", "candidate", "baseline", "candidate"],
    );
    assert.deepStrictEqual(interleavedOrder(1), ["candidate", "baseline"]);
  });

  it("summarizes the median and min-max per metric and omits metrics without values", () => {
    const summary = summarizeMetrics([
      { writable: 500, content: 400, sendAccepted: null },
      { writable: 300, content: 350 },
      { writable: 700, content: null },
    ]);
    assert.deepStrictEqual(Object.keys(summary), ["content", "writable"]);
    assert.equal(summary.writable?.median, 500);
    assert.equal(summary.writable?.minimum, 300);
    assert.equal(summary.writable?.maximum, 700);
    assert.equal(summary.writable?.count, 3);
    assert.equal(summary.content?.count, 2);
    assert.equal(summary.content?.median, 375);
    assert.match(formatSummaryTable(summary), /\| writable \| 500 \| 300-700 \| 3 \|/u);
  });

  it("leaves profiled and failed switches out of the medians", () => {
    const summary = summarizeSwitchRuns([
      switchRun({
        writable: 400,
        longTasks: [
          [0, 120],
          [200, 60],
        ],
      }),
      switchRun({ writable: 600 }),
      switchRun({ writable: 9_000, profiled: true }),
      switchRun({ writable: null, error: "row-missing" }),
      switchRun({ kind: "same-node", writable: 100 }),
    ]);
    assert.equal(summary["cross-node.writable"]?.median, 500);
    assert.equal(summary["cross-node.writable"]?.count, 2);
    assert.equal(summary["cross-node.longTaskCount"]?.maximum, 2);
    assert.equal(summary["cross-node.longTaskMaxMs"]?.maximum, 120);
    assert.equal(summary["cross-node.longTaskTotalMs"]?.maximum, 180);
    assert.equal(summary["same-node.writable"]?.median, 100);
  });

  it("tallies the runs of each kind, including timed-out and failed ones", () => {
    const summary = summarizeSwitchRuns([
      switchRun({ writable: 400 }),
      switchRun({ writable: null, timedOut: true }),
      switchRun({ writable: null, error: "row-missing" }),
      switchRun({ writable: 9_000, profiled: true }),
      switchRun({ kind: "same-node", writable: 100 }),
    ]);
    const tallies = (kind: string) =>
      ["runs", "timedOut", "failed"].map((name) => summary[`${kind}.${name}`]?.median);
    assert.deepStrictEqual(tallies("cross-node"), [3, 1, 1]);
    assert.deepStrictEqual(tallies("same-node"), [1, 0, 0]);
    assert.equal(summary["cross-node.runs"]?.count, 3);
    assert.equal(summary["cross-node.writable"]?.count, 1);
  });

  it("adds the phases of the newest node-switch timeline as metrics", () => {
    const summary = summarizeSwitchRuns([
      switchRun({
        timelines: [
          { n: 1, phases: { route: 5, "mutation-ready": 800 } },
          { n: 2, phases: { route: 6, "mutation-ready": 900 } },
        ],
      }),
    ]);
    assert.equal(summary["cross-node.timeline.mutation-ready"]?.median, 900);
    assert.equal(summary["cross-node.timeline.route"]?.median, 6);
  });

  const coldLoadRun = (firstContent: number): ColdLoadRun => ({
    side: null,
    firstContent,
    writable: firstContent + 50,
    timedOut: false,
    startup: { "primary-shell-painted": firstContent / 2 },
    requestCount: 40,
    transferBytes: 1_000,
    webSocketFrames: 3,
    serialRoundTrips: 5,
    criticalPath: [],
    cutList: [],
    errors: [],
    error: null,
  });

  it("summarizes cold loads including startup measures", () => {
    const summary = summarizeColdLoadRuns([
      coldLoadRun(1_000),
      coldLoadRun(1_200),
      coldLoadRun(1_100),
    ]);
    assert.equal(summary.firstContent?.median, 1_100);
    assert.equal(summary.writable?.median, 1_150);
    assert.equal(summary["startup.primary-shell-painted"]?.median, 550);
    assert.equal(summary.serialRoundTrips?.median, 5);
  });

  it("leaves cold loads that failed out of the medians", () => {
    const failed: ColdLoadRun = {
      ...coldLoadRun(0),
      firstContent: null,
      writable: null,
      startup: {},
      requestCount: 0,
      transferBytes: 0,
      webSocketFrames: 0,
      serialRoundTrips: null,
      error: "page.goto: Timeout 30000ms exceeded",
    };
    const summary = summarizeColdLoadRuns([coldLoadRun(1_000), failed, coldLoadRun(1_200)]);
    assert.equal(summary.firstContent?.count, 2);
    assert.equal(summary.firstContent?.median, 1_100);
    assert.equal(summary.requestCount?.count, 2);
    assert.equal(summary.requestCount?.minimum, 40);
  });

  it("tallies cold loads that timed out or failed", () => {
    const summary = summarizeColdLoadRuns([
      coldLoadRun(1_000),
      { ...coldLoadRun(1_100), writable: null, timedOut: true },
      { ...coldLoadRun(0), firstContent: null, writable: null, error: "net::ERR_FAILED" },
    ]);
    assert.deepStrictEqual(
      ["cold.runs", "cold.timedOut", "cold.failed"].map((name) => summary[name]?.median),
      [3, 1, 1],
    );
    assert.equal(summary.writable?.count, 1);
  });
});

describe("hosted probe comparison", () => {
  const baseline = summarizeMetrics([{ "cross-node.writable": 1_800, content: 900 }]);
  const candidate = summarizeMetrics([{ "cross-node.writable": 450, content: 950 }]);

  it("reports median deltas and evaluates targets against the candidate median", () => {
    const passing = compareHostedSummaries(baseline, candidate, { "cross-node.writable": 500 });
    assert.isTrue(passing.passed);
    const writable = passing.rows.find((row) => row.metric === "cross-node.writable");
    assert.equal(writable?.delta, -1_350);
    assert.equal(writable?.deltaPercent, -75);
    assert.isTrue(writable?.passed);
    assert.isNull(passing.rows.find((row) => row.metric === "content")?.passed);

    const failing = compareHostedSummaries(baseline, candidate, { "cross-node.writable": 400 });
    assert.isFalse(failing.passed);
    assert.match(
      formatComparisonTable(failing.rows),
      /\| cross-node\.writable \| 1800 \| 450 \| -1350 \| -75 \| 400 \| FAIL \|/u,
    );
  });

  it("fails a target whose metric the candidate did not record", () => {
    const result = compareHostedSummaries(baseline, candidate, { "same-node.writable": 500 });
    assert.isFalse(result.passed);
    assert.isNull(result.rows.find((row) => row.metric === "same-node.writable")?.candidateMedian);
  });

  describe("candidate runs that did not complete", () => {
    const target = { "cross-node.writable": 500 };
    const timedOut = () => switchRun({ content: 900, writable: null, timedOut: true });
    const writableRuns = (...values: number[]) => values.map((writable) => switchRun({ writable }));
    const baselineRuns = summarizeSwitchRuns(
      writableRuns(1_800, 1_800, 1_800, 1_800, 1_800, 1_800, 1_800),
    );

    it("fails a candidate whose switches mostly never became writable", () => {
      const mostlyTimedOut = summarizeSwitchRuns([
        ...Array.from({ length: 5 }, timedOut),
        ...writableRuns(300, 320),
      ]);
      // The median alone is 310 ms over the two switches that finished.
      assert.equal(mostlyTimedOut["cross-node.writable"]?.count, 2);
      assert.equal(mostlyTimedOut["cross-node.writable"]?.median, 310);

      const result = compareHostedSummaries(baselineRuns, mostlyTimedOut, target);
      assert.isFalse(result.passed);
      const row = result.rows.find((candidateRow) => candidateRow.metric === "cross-node.writable");
      assert.equal(row?.incomplete, "5 of 7 runs timed out (baseline 0)");
      assert.match(
        formatComparisonTable(result.rows),
        /\| cross-node\.writable \| 1800 \| 310 \| -1490 \| -82\.8 \| 500 \| FAIL \(5 of 7 runs timed out \(baseline 0\)\) \|/u,
      );
      // The tallies are rows too, so the table shows what was lost.
      assert.equal(result.rows.find((r) => r.metric === "cross-node.timedOut")?.candidateMedian, 5);
    });

    it("fails the gate read from result files", () => {
      const root = mkdtempSync(path.join(os.tmpdir(), "ryco-hosted-incomplete-test-"));
      try {
        const write = (name: string, value: unknown) => {
          const file = path.join(root, name);
          writeFileSync(file, JSON.stringify(value));
          return file;
        };
        const candidateRuns = [...Array.from({ length: 5 }, timedOut), ...writableRuns(300, 320)];
        const baselineFile = write("baseline.json", { summary: baselineRuns });
        const candidateFile = write("candidate.json", {
          summary: summarizeSwitchRuns(candidateRuns),
        });
        const targetsFile = write("targets.json", target);
        assert.isFalse(runHostedCompare({ baselineFile, candidateFile, targetsFile }).passed);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("fails a candidate with more failed switches than the baseline", () => {
      const withFailure = summarizeSwitchRuns([
        ...writableRuns(300, 320, 310, 305, 315, 300),
        switchRun({ writable: null, error: "row-missing" }),
      ]);
      const result = compareHostedSummaries(baselineRuns, withFailure, target);
      assert.isFalse(result.passed);
      assert.equal(
        result.rows.find((row) => row.metric === "cross-node.writable")?.incomplete,
        "1 of 7 runs failed (baseline 0)",
      );
    });

    it("fails a candidate that lost a metric from runs that completed", () => {
      const sends = (accepted: ReadonlyArray<number | null>) =>
        summarizeSwitchRuns(accepted.map((sendAccepted) => switchRun({ sendAccepted })));
      const result = compareHostedSummaries(sends([800, 820, 810]), sends([300, null, 310]), {
        "cross-node.sendAccepted": 500,
      });
      assert.isFalse(result.passed);
      assert.equal(
        result.rows.find((row) => row.metric === "cross-node.sendAccepted")?.incomplete,
        "2 of 3 completed runs recorded it",
      );
    });

    it("passes a faster candidate whose runs all completed", () => {
      const faster = summarizeSwitchRuns(writableRuns(300, 320, 310, 305, 315, 300, 325));
      const result = compareHostedSummaries(baselineRuns, faster, target);
      assert.isTrue(result.passed);
      assert.isTrue(result.rows.every((row) => row.incomplete === null));
    });

    it("judges a candidate with as many timeouts as the baseline on its median", () => {
      const baselineWithTimeouts = summarizeSwitchRuns([
        ...writableRuns(1_800, 1_800, 1_800, 1_800, 1_800),
        timedOut(),
        timedOut(),
      ]);
      const candidateWithTimeouts = summarizeSwitchRuns([
        ...writableRuns(300, 320, 310, 305, 315),
        timedOut(),
        timedOut(),
      ]);
      const passing = compareHostedSummaries(baselineWithTimeouts, candidateWithTimeouts, target);
      assert.isTrue(passing.passed);
      assert.isNull(passing.rows.find((row) => row.metric === "cross-node.writable")?.incomplete);

      const failing = compareHostedSummaries(baselineWithTimeouts, candidateWithTimeouts, {
        "cross-node.writable": 200,
      });
      assert.isFalse(failing.passed);
      assert.match(formatComparisonTable(failing.rows), /\| 200 \| FAIL \|/u);
    });

    it("applies the same rule to cold loads", () => {
      const coldLoad = (firstContent: number, timedOutLoad = false): ColdLoadRun => ({
        side: null,
        firstContent,
        writable: timedOutLoad ? null : firstContent + 50,
        timedOut: timedOutLoad,
        startup: {},
        requestCount: 40,
        transferBytes: 1_000,
        webSocketFrames: 3,
        serialRoundTrips: 5,
        criticalPath: [],
        cutList: [],
        errors: [],
        error: null,
      });
      const coldBaseline = summarizeColdLoadRuns([
        coldLoad(2_000),
        coldLoad(2_100),
        coldLoad(2_050),
      ]);
      const coldCandidate = summarizeColdLoadRuns([
        coldLoad(900),
        coldLoad(950, true),
        coldLoad(1_000, true),
      ]);
      const result = compareHostedSummaries(coldBaseline, coldCandidate, { writable: 1_500 });
      assert.isFalse(result.passed);
      assert.equal(
        result.rows.find((row) => row.metric === "writable")?.incomplete,
        "2 of 3 runs timed out (baseline 0)",
      );
    });
  });

  it("compares two result files with an optional targets file", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-hosted-compare-test-"));
    try {
      const write = (name: string, value: unknown) => {
        const file = path.join(root, name);
        writeFileSync(file, JSON.stringify(value));
        return file;
      };
      const baselineFile = write("baseline.json", { summary: baseline });
      const candidateFile = write("candidate.json", { summary: candidate });
      const targetsFile = write("targets.json", { "cross-node.writable": 400 });

      assert.isTrue(runHostedCompare({ baselineFile, candidateFile, targetsFile: null }).passed);
      assert.isFalse(runHostedCompare({ baselineFile, candidateFile, targetsFile }).passed);
      assert.throws(
        () =>
          runHostedCompare({
            baselineFile: write("empty.json", {}),
            candidateFile,
            targetsFile: null,
          }),
        /no metric summary/u,
      );
      assert.throws(
        () =>
          runHostedCompare({ baselineFile, candidateFile, targetsFile: write("bad.json", [1]) }),
        /Targets must be/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads the cookie file the Hub session comes from", () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-hosted-cookie-test-"));
    try {
      const file = path.join(root, "cookie.json");
      writeFileSync(file, JSON.stringify({ cookieName: "name", cookieValue: "value", extra: 1 }));
      assert.deepStrictEqual(readCookieFile(file), { cookieName: "name", cookieValue: "value" });
      writeFileSync(file, JSON.stringify({ cookieName: "name" }));
      assert.throws(() => readCookieFile(file), /cookieValue/u);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("hosted probe critical path", () => {
  it("follows the initiator chain back from the last response before first content", () => {
    const requests = [
      request("/node/n1/env_a/t1", null, 0, 50, { type: "Document" }),
      request("/assets/entry.js", "/node/n1/env_a/t1", 60, 120),
      request("/assets/chunk.js", "/assets/entry.js", 130, 200),
      request("/api/thread", "/assets/chunk.js", 210, 400, { type: "Fetch" }),
      // Parallel work that finished earlier, and work that ended after first content.
      request("/assets/style.css", "/node/n1/env_a/t1", 60, 150, { type: "Stylesheet" }),
      request("/assets/other.js", "/assets/entry.js", 130, 390),
      request("/assets/late.js", "/assets/entry.js", 130, 700),
      request("/events", "/assets/chunk.js", 210, null, { type: "Fetch" }),
    ];

    const criticalPath = computeCriticalPath(requests, 420);
    assert.deepStrictEqual(
      criticalPath.items.map((item) => item.path),
      ["/node/n1/env_a/t1", "/assets/entry.js", "/assets/chunk.js", "/api/thread"],
    );
    assert.equal(criticalPath.serialRoundTrips, 4);
    assert.deepStrictEqual(
      criticalPath.cutList.map((item) => [item.path, item.durationMs, item.initiator]),
      [
        ["/api/thread", 190, "/assets/chunk.js"],
        ["/assets/chunk.js", 70, "/assets/entry.js"],
        ["/assets/entry.js", 60, "/node/n1/env_a/t1"],
        ["/node/n1/env_a/t1", 50, null],
      ],
    );
  });

  it("counts requests that overlap on the chain as one wave", () => {
    const criticalPath = computeCriticalPath(
      [
        request("/a.js", null, 0, 100),
        request("/b.js", "/a.js", 80, 150),
        request("/c.js", "/b.js", 160, 200),
      ],
      250,
    );
    assert.deepStrictEqual(
      criticalPath.items.map((item) => item.path),
      ["/a.js", "/b.js", "/c.js"],
    );
    assert.equal(criticalPath.serialRoundTrips, 2);
  });

  it("ends the chain at a WebSocket's last frame before first content", () => {
    const criticalPath = computeCriticalPath(
      [
        request("/node/n1/env_a/t1", null, 0, 50, { type: "Document" }),
        request("/assets/entry.js", "/node/n1/env_a/t1", 60, 120),
        request("/relay", "/assets/entry.js", 130, null, {
          type: "WebSocket",
          frameTimesMs: [200, 340, 600],
        }),
        request("/assets/side.js", "/node/n1/env_a/t1", 60, 330),
      ],
      420,
    );
    assert.deepStrictEqual(
      criticalPath.items.map((item) => [item.path, item.endMs]),
      [
        ["/node/n1/env_a/t1", 50],
        ["/assets/entry.js", 120],
        ["/relay", 340],
      ],
    );
    assert.equal(criticalPath.serialRoundTrips, 3);
    assert.equal(criticalPath.cutList[0]?.path, "/relay");
    assert.equal(criticalPath.cutList[0]?.durationMs, 210);
  });

  it("is empty when nothing finished before first content and tolerates unknown initiators", () => {
    assert.deepStrictEqual(computeCriticalPath([request("/a.js", null, 0, 500)], 100).items, []);
    const criticalPath = computeCriticalPath([request("/a.js", "/missing.js", 0, 50)], 100);
    assert.equal(criticalPath.items.length, 1);
    assert.equal(criticalPath.serialRoundTrips, 1);
  });

  it("reads the initiating module from a request's CDP initiator", () => {
    assert.equal(initiatorPath(undefined), null);
    assert.equal(initiatorPath({ url: "https://hub.example/assets/a.js?v=2" }), "/assets/a.js");
    assert.equal(
      initiatorPath({
        stack: {
          callFrames: [{ url: "" }],
          parent: { callFrames: [{ url: "https://hub.example/assets/b.js" }] },
        },
      }),
      "/assets/b.js",
    );
    assert.equal(initiatorPath({ url: "data:text/javascript,1" }), null);
  });
});

describe("hosted probe workspace helpers", () => {
  it("keeps only online nodes from the Hub directory", () => {
    assert.deepStrictEqual(
      parseOnlineNodes({
        nodes: [
          { id: "n1", environmentId: "env_a", presence: { online: true } },
          { id: "n2", environmentId: "env_b", presence: { online: false } },
          { id: "n3", presence: { online: true } },
          { id: "n4", environmentId: "env_d", presence: { online: true } },
        ],
      }),
      [
        { id: "n1", environmentId: "env_a" },
        { id: "n4", environmentId: "env_d" },
      ],
    );
    assert.throws(() => parseOnlineNodes({}), /node list/u);
    assert.equal(
      threadPath({ id: "n1", environmentId: "env_a" }),
      "/node/n1/env_a/fixture-thread-1",
    );
    assert.deepStrictEqual(parseThreadRoute("/node/n1/env_a/t1"), {
      nodeId: "n1",
      environmentId: "env_a",
      threadId: "t1",
    });
    assert.isNull(parseThreadRoute("/settings"));
  });

  const rows = [
    ...Array.from({ length: 30 }, (_, index) => `env_a:t${index}`),
    ...Array.from({ length: 30 }, (_, index) => `env_b:t${index}`),
    ...Array.from({ length: 30 }, (_, index) => `env_c:t${index}`),
  ];

  it("rotates cross-node switches through the other environments", () => {
    const used = new Set<string>();
    const environments: string[] = [];
    let current: HostedRoute | null = parseThreadRoute("/node/n1/env_a/t0");
    for (let ordinal = 0; ordinal < 6; ordinal += 1) {
      const key: string = chooseRowKey({
        rowKeys: rows,
        kind: "cross-node",
        current,
        ordinal,
        used,
      })!;
      environments.push(key.split(":")[0]!);
      used.add(key);
      const [environmentId, threadId] = key.split(":");
      current = { nodeId: "n1", environmentId: environmentId!, threadId: threadId! };
    }
    assert.deepStrictEqual(environments, ["env_b", "env_c", "env_a", "env_b", "env_c", "env_a"]);
    assert.equal(used.size, 6);
  });

  it("never picks a thread whose id equals the open one on another node", () => {
    // Fixture nodes generate the same message ids for the same thread id.
    const key = chooseRowKey({
      rowKeys: rows,
      kind: "cross-node",
      current: { environmentId: "env_a", threadId: "t6" },
      ordinal: 3,
      used: new Set(),
    });
    assert.match(key ?? "", /^env_b:/u);
    assert.notEqual(key, "env_b:t6");
    for (let ordinal = 0; ordinal < 30; ordinal += 1) {
      const next = chooseRowKey({
        rowKeys: rows,
        kind: "cross-node",
        current: { environmentId: "env_a", threadId: "t6" },
        ordinal,
        used: new Set(),
      });
      assert.notEqual(next, "env_b:t6");
    }
    assert.isNull(
      chooseRowKey({
        rowKeys: ["env_a:t0", "env_b:t0"],
        kind: "cross-node",
        current: { environmentId: "env_a", threadId: "t0" },
        ordinal: 0,
        used: new Set(),
      }),
    );
  });

  it("has no cross-node row when only the open environment lists rows", () => {
    const onlyCurrent = Array.from({ length: 5 }, (_, index) => `env_a:t${index}`);
    for (let ordinal = 0; ordinal < 4; ordinal += 1) {
      assert.isNull(
        chooseRowKey({
          rowKeys: onlyCurrent,
          kind: "cross-node",
          current: { environmentId: "env_a", threadId: "t0" },
          ordinal,
          used: new Set(),
        }),
      );
    }
    // The same rows still serve the same-node control.
    assert.match(
      chooseRowKey({
        rowKeys: onlyCurrent,
        kind: "same-node",
        current: { environmentId: "env_a", threadId: "t0" },
        ordinal: 0,
        used: new Set(),
      }) ?? "",
      /^env_a:t[1-4]$/u,
    );
    // With no open thread, any listed environment is another node.
    assert.match(
      chooseRowKey({
        rowKeys: onlyCurrent,
        kind: "cross-node",
        current: null,
        ordinal: 0,
        used: new Set(),
      }) ?? "",
      /^env_a:/u,
    );
  });

  it("stays on the current environment for same-node controls and never reopens the open thread", () => {
    const key = chooseRowKey({
      rowKeys: rows,
      kind: "same-node",
      current: { environmentId: "env_b", threadId: "t20" },
      ordinal: 0,
      used: new Set(),
    });
    assert.match(key ?? "", /^env_b:/u);
    assert.notEqual(key, "env_b:t20");

    const tiny = chooseRowKey({
      rowKeys: ["env_a:t0", "env_a:t1"],
      kind: "same-node",
      current: { environmentId: "env_a", threadId: "t0" },
      ordinal: 0,
      used: new Set(["env_a:t1"]),
    });
    assert.equal(tiny, "env_a:t1");
    assert.isNull(
      chooseRowKey({ rowKeys: [], kind: "cross-node", current: null, ordinal: 0, used: new Set() }),
    );
  });

  it("reads timelines recorded since an earlier read", () => {
    const first = { n: 1, phases: { route: 1 } };
    const second = { n: 2, phases: { route: 2 } };
    assert.deepStrictEqual(newTimelineEntries([first], [first, second]), [second]);
    assert.deepStrictEqual(newTimelineEntries(null, [first]), [first]);
    assert.deepStrictEqual(newTimelineEntries(null, null), []);
    assert.deepStrictEqual(
      newTimelineEntries([{ phases: {} }], [{ phases: {} }, { phases: { a: 1 } }]),
      [{ phases: { a: 1 } }],
    );
  });
});
