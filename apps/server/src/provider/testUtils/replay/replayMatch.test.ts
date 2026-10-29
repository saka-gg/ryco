import { assert, describe, it } from "@effect/vitest";

import { ASSISTANT_ATTACHMENT_INSTRUCTIONS } from "../../../assistantAttachments.ts";
import {
  firstDiffPath,
  makeReplayCursor,
  normalizeCodexOutbound,
  sameFrame,
  stableStringify,
  type ReplayCursor,
  type ReplayInboundStep,
} from "./replayMatch.ts";
import type { ReplayEntry } from "./replayTranscript.ts";

const request = (id: number, method: string, params?: unknown) => ({
  id,
  method,
  ...(params === undefined ? {} : { params }),
});

/** Takes every inbound step that may flow now. */
function drain(cursor: ReplayCursor): Array<ReplayInboundStep> {
  const steps: Array<ReplayInboundStep> = [];
  for (let step = cursor.peekInbound(); step !== undefined; step = cursor.peekInbound()) {
    steps.push(step);
    cursor.takeInbound();
  }
  return steps;
}

const frames = (steps: ReadonlyArray<ReplayInboundStep>) =>
  steps.map((step) => (step.type === "emit" ? step.frame : { exit: step.status }));

describe("replay frame comparison", () => {
  it("stringifies with sorted keys at every depth", () => {
    assert.equal(
      stableStringify({ b: [{ d: 1, c: 2 }], a: null, skipped: undefined }),
      '{"a":null,"b":[{"c":2,"d":1}]}',
    );
  });

  it("finds the first differing path", () => {
    assert.equal(firstDiffPath({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 }), undefined);
    assert.equal(
      firstDiffPath({ params: { input: [{ text: "a" }] } }, { params: { input: [{ text: "b" }] } }),
      "$.params.input[0].text",
    );
    assert.equal(firstDiffPath({ list: [1] }, { list: [1, 2] }), "$.list[1]");
    assert.equal(firstDiffPath({ "mcp.servers": 1 }, {}), '$["mcp.servers"]');
    assert.equal(firstDiffPath(1, "1"), "$");
  });

  it("tells a missing key from an explicit null, as sameFrame does", () => {
    const pairs: ReadonlyArray<readonly [unknown, unknown, string | undefined]> = [
      [{ a: null }, {}, "$.a"],
      [{}, { a: null }, "$.a"],
      [{ params: { effort: null } }, { params: {} }, "$.params.effort"],
      [{ a: undefined }, {}, undefined],
      [{ a: null }, { a: null }, undefined],
      [[null], [null], undefined],
    ];
    for (const [expected, actual, path] of pairs) {
      assert.equal(firstDiffPath(expected, actual), path);
      assert.equal(sameFrame(expected, actual), path === undefined);
    }

    // A client that adds `"effort": null` to a recorded turn/start does not match it.
    const cursor = makeReplayCursor(
      [{ type: "expect_outbound", frame: request(1, "turn/start", { threadId: "t" }) }],
      { scenario: "unit" },
    );
    const error = cursor.matchOutbound(request(1, "turn/start", { threadId: "t", effort: null }));
    assert.equal(error?._tag, "ReplayFrameMismatchError");
    assert.equal(error?._tag === "ReplayFrameMismatchError" && error.diffPath, "$.params.effort");
  });

  it("normalizes what Codex outbound frames vary per run", () => {
    const initialize = (version: string) =>
      request(1, "initialize", {
        clientInfo: { name: "ryco_desktop", title: "Ryco Desktop", version },
        capabilities: { experimentalApi: true },
      });
    assert.isTrue(sameFrame(initialize("0.1.0"), initialize("9.9.9"), normalizeCodexOutbound));

    assert.deepEqual(
      normalizeCodexOutbound(
        request(2, "thread/resume", {
          threadId: "t",
          cwd: "/somewhere",
          config: {
            "features.goals": true,
            mcp_servers: { ryco_device: { http_headers: { Authorization: "Bearer secret" } } },
            "mcp_servers.ryco_agent_control.url": "http://127.0.0.1:1",
          },
        }),
      ),
      request(2, "thread/resume", { threadId: "t", config: { "features.goals": true } }),
    );

    assert.deepEqual(
      normalizeCodexOutbound(
        request(3, "turn/start", {
          threadId: "t",
          input: [
            { type: "text", text: `${ASSISTANT_ATTACHMENT_INSTRUCTIONS}\n\nSay hello.` },
            { type: "text", text: "unchanged" },
            { type: "image", url: "file:///a.png" },
          ],
          collaborationMode: {
            mode: "plan",
            settings: { model: "m", developer_instructions: "long product copy" },
          },
        }),
      ),
      request(3, "turn/start", {
        threadId: "t",
        input: [
          { type: "text", text: "<attachment-instructions>\n\nSay hello." },
          { type: "text", text: "unchanged" },
          { type: "image", url: "file:///a.png" },
        ],
        collaborationMode: {
          mode: "plan",
          settings: { model: "m", developer_instructions: "<ignored>" },
        },
      }),
    );
    assert.deepEqual(normalizeCodexOutbound({ method: "initialized" }), {
      method: "initialized",
    });
  });
});

describe("replay cursor", () => {
  it("binds a request id and rewrites the response to the client's id", () => {
    const cursor = makeReplayCursor(
      [
        { type: "expect_outbound", frame: request(7, "thread/read", { threadId: "t" }) },
        { type: "emit_inbound", frame: { method: "turn/started", params: { id: 7 } } },
        { type: "emit_inbound", frame: { id: 7, result: { ok: true } } },
        { type: "emit_inbound", frame: { id: 0, method: "item/tool/requestUserInput" } },
        { type: "expect_outbound", frame: { id: 0, result: { answers: {} } } },
      ],
      { scenario: "unit" },
    );
    assert.deepEqual(drain(cursor), []);
    assert.isUndefined(cursor.matchOutbound(request(3, "thread/read", { threadId: "t" })));
    assert.deepEqual(frames(drain(cursor)), [
      // Only response ids are rewritten.
      { method: "turn/started", params: { id: 7 } },
      { id: 3, result: { ok: true } },
      // Server requests keep the transcript's id, and the client must echo it.
      { id: 0, method: "item/tool/requestUserInput" },
    ]);
    const wrongEcho = cursor.matchOutbound({ id: 3, result: { answers: {} } });
    assert.equal(wrongEcho?._tag, "ReplayFrameMismatchError");
  });

  it("matches a run of consecutive outbound entries in any order", () => {
    const cursor = makeReplayCursor(
      [
        { type: "expect_outbound", label: "A", frame: request(1, "a") },
        { type: "expect_outbound", label: "B", frame: request(2, "b") },
        { type: "emit_inbound", frame: { id: 1, result: "a" } },
        { type: "emit_inbound", frame: { id: 2, result: "b" } },
      ],
      { scenario: "unit" },
    );
    assert.isUndefined(cursor.matchOutbound(request(1, "b")));
    // The run is not complete: nothing flows yet.
    assert.deepEqual(drain(cursor), []);
    assert.deepEqual(cursor.remainingLabels(), [
      "A",
      "emit_inbound:response:1",
      "emit_inbound:response:2",
    ]);
    assert.isUndefined(cursor.matchOutbound(request(2, "a")));
    assert.deepEqual(frames(drain(cursor)), [
      { id: 2, result: "a" },
      { id: 1, result: "b" },
    ]);
    assert.deepEqual(cursor.remainingLabels(), []);
  });

  it("skips an optional entry the client never sends, with its recorded answer", () => {
    const entries: ReadonlyArray<ReplayEntry> = [
      { type: "expect_outbound", label: "turn", frame: request(1, "turn/start") },
      {
        type: "expect_outbound",
        label: "skills",
        frame: request(2, "skills/list"),
        optional: true,
      },
      { type: "emit_inbound", frame: { id: 2, result: { data: [] } } },
      { type: "emit_inbound", frame: { id: 1, result: { turn: {} } } },
      { type: "expect_outbound", label: "interrupt", frame: request(3, "turn/interrupt") },
      { type: "emit_inbound", frame: { id: 3, result: {} } },
    ];

    const skipped = makeReplayCursor(entries, { scenario: "unit" });
    assert.isUndefined(skipped.matchOutbound(request(1, "turn/start")));
    assert.deepEqual(frames(drain(skipped)), [{ id: 1, result: { turn: {} } }]);
    assert.isUndefined(skipped.matchOutbound(request(2, "turn/interrupt")));
    assert.deepEqual(frames(drain(skipped)), [{ id: 2, result: {} }]);
    assert.deepEqual(skipped.remainingLabels(), []);

    // Sent late, it still matches, and its held answer flows with the client's id.
    const late = makeReplayCursor(entries, { scenario: "unit" });
    assert.isUndefined(late.matchOutbound(request(1, "turn/start")));
    drain(late);
    assert.isUndefined(late.matchOutbound(request(2, "turn/interrupt")));
    drain(late);
    assert.isUndefined(late.matchOutbound(request(3, "skills/list")));
    assert.deepEqual(frames(drain(late)), [{ id: 3, result: { data: [] } }]);
  });

  it("reports a mismatch with the differing path and normalized frames", () => {
    const cursor = makeReplayCursor(
      [
        { type: "expect_outbound", label: "init", frame: request(1, "initialize") },
        {
          type: "expect_outbound",
          label: "start",
          frame: request(2, "thread/start", { cwd: "<workspace>", model: "a" }),
        },
      ],
      { scenario: "unit", spawn: 2, normalize: normalizeCodexOutbound },
    );
    const error = cursor.matchOutbound(
      request(9, "thread/start", {
        cwd: "/run",
        model: "b",
        config: { mcp_servers: { x: { http_headers: { Authorization: "Bearer sk-secret" } } } },
      }),
    );
    assert.equal(error?._tag, "ReplayFrameMismatchError");
    if (error?._tag !== "ReplayFrameMismatchError") return;
    assert.equal(error.diffPath, "$.params.config");
    assert.equal(error.label, "start");
    assert.equal(error.cursor, 1);
    assert.equal(error.spawn, 2);
    assert.include(error.message, "at $.params.config");
    assert.notInclude(error.message, "sk-secret");
    assert.notInclude(error.message, "/run");
  });

  it("fails an outbound frame after the last entry or a recorded exit", () => {
    const exhausted = makeReplayCursor([], { scenario: "unit" });
    assert.equal(exhausted.matchOutbound(request(1, "x"))?._tag, "ReplayExhaustedError");

    const exited = makeReplayCursor(
      [
        { type: "emit_inbound", frame: { method: "bye" } },
        { type: "runtime_exit", status: "success" },
      ],
      { scenario: "unit" },
    );
    assert.deepEqual(frames(drain(exited)), [{ method: "bye" }, { exit: "success" }]);
    assert.equal(exited.matchOutbound(request(1, "x"))?._tag, "ReplayUnexpectedOutboundError");
  });

  it("lists the entries a scenario never reached", () => {
    const cursor = makeReplayCursor(
      [
        { type: "expect_outbound", frame: request(1, "initialize") },
        { type: "emit_inbound", label: "ready", frame: { id: 1, result: {} } },
        { type: "expect_outbound", frame: request(2, "thread/start") },
        { type: "expect_outbound", frame: request(3, "skills/list"), optional: true },
        { type: "runtime_exit", status: "success" },
      ],
      { scenario: "unit" },
    );
    assert.isUndefined(cursor.matchOutbound(request(1, "initialize")));
    assert.deepEqual(cursor.remainingLabels(), ["ready", "expect_outbound:thread/start"]);
    drain(cursor);
    assert.deepEqual(cursor.remainingLabels(), ["expect_outbound:thread/start"]);
    assert.include(cursor.describeWaiting(), "waiting for outbound expect_outbound:thread/start");
  });
});
