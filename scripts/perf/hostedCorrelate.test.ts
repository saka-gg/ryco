import { assert, describe, it } from "@effect/vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  correlateRuns,
  discoverNodeDirs,
  formatCorrelationTable,
  parseHubEventLine,
  parseSpanStartLine,
  readSpanStarts,
  runHostedCorrelate,
  traceFilesOf,
} from "./hostedCorrelate.ts";

const SHELL_SPAN = "ws.rpc.orchestration.subscribeShell";
const THREAD_SPAN = "ws.rpc.orchestration.subscribeThreadWindow";
const CLICK = 1_800_000_000_000;

function span(name: string, startMs: number): string {
  return JSON.stringify({
    type: "effect-span",
    name,
    startTimeUnixNano: String(BigInt(startMs) * 1_000_000n),
    durationMs: 12,
  });
}

function hubLine(offsetMs: number, route: string, event = "relay.connection.authenticated") {
  return JSON.stringify({ time: new Date(CLICK + offsetMs).toISOString(), route, event });
}

describe("hosted switch correlation", () => {
  it("reads span starts and hub events only for the configured names", () => {
    assert.deepStrictEqual(parseSpanStartLine(span(SHELL_SPAN, CLICK + 5), [SHELL_SPAN]), {
      name: SHELL_SPAN,
      startMs: CLICK + 5,
    });
    assert.isNull(parseSpanStartLine(span("other.span", CLICK), [SHELL_SPAN]));
    assert.isNull(parseSpanStartLine("not json " + SHELL_SPAN, [SHELL_SPAN]));

    const filter = { event: "relay.connection.authenticated", route: "client" };
    assert.equal(parseHubEventLine(hubLine(30, "client"), filter), CLICK + 30);
    assert.isNull(parseHubEventLine(hubLine(30, "node"), filter));
    assert.isNull(parseHubEventLine(hubLine(30, "client", "relay.other"), filter));
    assert.equal(
      parseHubEventLine(
        JSON.stringify({ event: filter.event, time: new Date(CLICK).toISOString() }),
        filter,
      ),
      CLICK,
    );
  });

  it("credits an event to the switch whose click precedes it, up to the next click", () => {
    const nodes = new Map([
      [
        "env_a",
        {
          label: "node0",
          spanStarts: new Map([[SHELL_SPAN, [CLICK + 20, CLICK + 2_020]]]),
        },
      ],
      [
        "env_b",
        {
          label: "node1",
          spanStarts: new Map([
            [SHELL_SPAN, [CLICK + 1_530]],
            [THREAD_SPAN, [CLICK + 1_600]],
          ]),
        },
      ],
    ]);
    const rows = correlateRuns({
      runs: [
        {
          kind: "cross-node",
          rowKey: "env_a:thread-1",
          clickEpochMs: CLICK,
          firstFrame: 8.4,
          content: 900,
          writable: 950,
        },
        {
          kind: "cross-node",
          rowKey: "env_b:thread-2",
          clickEpochMs: CLICK + 1_500,
          firstFrame: 4,
          content: 700,
        },
        { kind: "same-node", rowKey: "env_unknown:thread-3", clickEpochMs: CLICK + 3_000 },
      ],
      nodes,
      hubEvents: [CLICK + 12, CLICK + 1_512],
    });

    assert.deepStrictEqual(rows[0], {
      kind: "cross-node",
      node: "node0",
      offsets: {
        firstFrame: 8,
        route: null,
        "hub.stream": 12,
        "node.shell": 20,
        "node.thread": null,
        "node.channelOpen": null,
        "node.channelAdvertise": null,
        "node.firstResponse": null,
        content: 900,
        writable: 950,
      },
    });
    // The first node's second subscription belongs to a later switch.
    assert.equal(rows[1]?.offsets["node.shell"], 30);
    assert.equal(rows[1]?.offsets["node.thread"], 100);
    assert.equal(rows[1]?.offsets["hub.stream"], 12);
    assert.isNull(rows[1]?.offsets.writable);
    assert.isNull(rows[2]?.node);
    assert.isNull(rows[2]?.offsets["node.shell"]);
  });

  it("credits an event between the press and the click to that switch, before the click", () => {
    const nodes = new Map([
      ["env_a", { label: "node0", spanStarts: new Map([[THREAD_SPAN, [CLICK - 1]]]) }],
      ["env_b", { label: "node1", spanStarts: new Map([[SHELL_SPAN, [CLICK + 1_499]]]) }],
    ]);
    const rows = correlateRuns({
      runs: [
        {
          kind: "same-node",
          rowKey: "env_a:thread-1",
          pressEpochMs: CLICK - 3,
          clickEpochMs: CLICK,
        },
        {
          kind: "cross-node",
          rowKey: "env_b:thread-2",
          pressEpochMs: CLICK + 1_497,
          clickEpochMs: CLICK + 1_500,
        },
      ],
      nodes,
      hubEvents: [CLICK - 2, CLICK + 1_498],
    });

    assert.equal(rows[0]?.offsets["hub.stream"], -2);
    assert.equal(rows[0]?.offsets["node.thread"], -1);
    // The next switch's press-time stream belongs to it, so it still reads as cold.
    assert.equal(rows[1]?.offsets["hub.stream"], -2);
    assert.equal(rows[1]?.offsets["node.shell"], -1);
  });

  it("does not credit the next switch's press-time event to this one", () => {
    const rows = correlateRuns({
      runs: [
        {
          kind: "cross-node",
          rowKey: "env_a:thread-1",
          pressEpochMs: CLICK - 3,
          clickEpochMs: CLICK,
        },
        {
          kind: "cross-node",
          rowKey: "env_b:thread-2",
          pressEpochMs: CLICK + 1_490,
          clickEpochMs: CLICK + 1_500,
        },
      ],
      nodes: new Map(),
      hubEvents: [CLICK + 1_495],
    });

    assert.isNull(rows[0]?.offsets["hub.stream"]);
    assert.equal(rows[1]?.offsets["hub.stream"], -5);
  });

  it("joins from the click when the probe recorded no press", () => {
    const nodes = new Map([
      ["env_a", { label: "node0", spanStarts: new Map([[THREAD_SPAN, [CLICK - 1, CLICK + 30]]]) }],
    ]);
    const runsWith = (press: { readonly pressEpochMs?: null }) => [
      { kind: "same-node", rowKey: "env_a:thread-1", clickEpochMs: CLICK, ...press },
      { kind: "same-node", rowKey: "env_a:thread-2", clickEpochMs: CLICK + 1_500, ...press },
    ];
    const hubEvents = [CLICK - 2, CLICK + 12, CLICK + 1_498, CLICK + 1_512];
    const rows = correlateRuns({ runs: runsWith({}), nodes, hubEvents });

    // Nothing before a click counts, and a window ends at the next click.
    assert.deepStrictEqual(
      rows.map((row) => [row.offsets["hub.stream"], row.offsets["node.thread"]]),
      [
        [12, 30],
        [12, null],
      ],
    );
    assert.deepStrictEqual(
      correlateRuns({ runs: runsWith({ pressEpochMs: null }), nodes, hubEvents }),
      rows,
    );
  });

  it("reads the rotated backups of a trace file and nothing else", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-correlate-rotated-"));
    try {
      const trace = path.join(root, "server.trace.ndjson");
      writeFileSync(trace, span(SHELL_SPAN, CLICK + 3_000) + "\n");
      writeFileSync(`${trace}.1`, span(SHELL_SPAN, CLICK + 2_000) + "\n");
      writeFileSync(`${trace}.2`, span(SHELL_SPAN, CLICK + 1_000) + "\n");
      // Not backups of this file.
      writeFileSync(`${trace}.bak`, span(SHELL_SPAN, CLICK + 9_000) + "\n");
      writeFileSync(
        path.join(root, "server.trace.ndjson1"),
        span(SHELL_SPAN, CLICK + 9_001) + "\n",
      );
      writeFileSync(
        path.join(root, "other.trace.ndjson.1"),
        span(SHELL_SPAN, CLICK + 9_002) + "\n",
      );

      assert.deepStrictEqual(
        traceFilesOf(trace)
          .map((file) => path.basename(file))
          .toSorted(),
        ["server.trace.ndjson", "server.trace.ndjson.1", "server.trace.ndjson.2"],
      );
      const starts = await readSpanStarts(trace);
      assert.deepStrictEqual(starts.get(SHELL_SPAN), [CLICK + 1_000, CLICK + 2_000, CLICK + 3_000]);

      // Only backups on disk: the live file may not exist yet.
      rmSync(trace);
      assert.deepStrictEqual((await readSpanStarts(trace)).get(SHELL_SPAN), [
        CLICK + 1_000,
        CLICK + 2_000,
      ]);
      assert.deepStrictEqual(
        traceFilesOf(path.join(root, "missing-dir", "server.trace.ndjson")),
        [],
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("joins a probe result with node trace files and a hub log", async () => {
    const root = mkdtempSync(path.join(os.tmpdir(), "ryco-correlate-test-"));
    try {
      for (const [index, environmentId] of ["env_a", "env_b"].entries()) {
        const logs = path.join(root, `node${index}`, "userdata", "logs");
        mkdirSync(logs, { recursive: true });
        writeFileSync(
          path.join(root, `node${index}`, "userdata", "hub-identity.json"),
          JSON.stringify({ version: 1, environmentId }),
        );
        writeFileSync(
          path.join(logs, "server.trace.ndjson"),
          [span("unrelated", CLICK), span(SHELL_SPAN, CLICK + (index === 0 ? 40 : 1_560))].join(
            "\n",
          ) + "\n",
        );
      }
      writeFileSync(path.join(root, "node10"), "not a directory");
      const hubLog = path.join(root, "hub.log");
      writeFileSync(hubLog, [hubLine(25, "client"), hubLine(26, "node"), "garbage"].join("\n"));
      const probeFile = path.join(root, "hosted-switch.json");
      writeFileSync(
        probeFile,
        JSON.stringify({
          runs: [
            {
              kind: "cross-node",
              rowKey: "env_a:t1",
              clickEpochMs: CLICK,
              firstFrame: 3,
              content: 600,
              writable: 640,
            },
            {
              kind: "cross-node",
              rowKey: "env_b:t2",
              clickEpochMs: CLICK + 1_500,
              firstFrame: 5,
              content: 620,
              writable: 660,
            },
          ],
        }),
      );

      const nodeDirs = discoverNodeDirs(root);
      assert.deepStrictEqual(
        nodeDirs.map((dir) => path.basename(dir)),
        ["node0", "node1"],
      );

      const rows = await runHostedCorrelate({
        probeFile,
        nodeDirs,
        hubLog,
        hubEvent: "relay.connection.authenticated",
        hubRoute: "client",
      });
      assert.deepStrictEqual(
        rows.map((row) => [
          row.node,
          row.offsets["hub.stream"],
          row.offsets["node.shell"],
          row.offsets.writable,
        ]),
        [
          ["node0", 25, 40, 640],
          ["node1", null, 60, 660],
        ],
      );
      assert.match(
        formatCorrelationTable(rows),
        /\| cross-node \| node0 \| 3 \| - \| 25 \| 40 \|/u,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
