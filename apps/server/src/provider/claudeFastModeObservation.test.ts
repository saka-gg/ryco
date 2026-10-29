import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { ClaudeFastModeReport } from "@ryco/shared/claudeFastMode";
import { describe, expect, it } from "vite-plus/test";

import {
  decideClaudeFastModePublish,
  readClaudeFastModeFrame,
} from "./claudeFastModeObservation.ts";

const frame = (value: Record<string, unknown>) =>
  ({ uuid: "frame", session_id: "sdk-session", ...value }) as unknown as SDKMessage;

const init = (extra: Record<string, unknown>) =>
  frame({ type: "system", subtype: "init", model: "claude-opus-4-8", ...extra });
const result = (extra: Record<string, unknown>) =>
  frame({ type: "result", subtype: "success", is_error: false, ...extra });

describe("readClaudeFastModeFrame", () => {
  it("reads the state and reason of init and result frames", () => {
    expect(readClaudeFastModeFrame(init({ fast_mode_state: "on" }))).toEqual({ state: "on" });
    expect(
      readClaudeFastModeFrame(
        result({ fast_mode_state: "off", fast_mode_disabled_reason: "not_first_party" }),
      ),
    ).toEqual({ state: "off", disabledReason: "not_first_party" });
    expect(
      readClaudeFastModeFrame(
        frame({ type: "result", subtype: "error_during_execution", fast_mode_state: "cooldown" }),
      ),
    ).toEqual({ state: "cooldown" });
  });

  it("ignores every other frame, frames without a state and subagent frames", () => {
    for (const message of [
      frame({ type: "system", subtype: "status", status: null, fast_mode_state: "on" }),
      frame({ type: "assistant", fast_mode_state: "on", parent_tool_use_id: null }),
      frame({ type: "stream_event", fast_mode_state: "on", parent_tool_use_id: null }),
      frame({ type: "rate_limit_event", fast_mode_state: "on" }),
      init({}),
      result({}),
      result({ fast_mode_state: "turbo" }),
      init({ fast_mode_state: "on", parent_tool_use_id: "tool-agent-1" }),
    ]) {
      expect(readClaudeFastModeFrame(message), JSON.stringify(message)).toBeUndefined();
    }
  });
});

describe("decideClaudeFastModePublish", () => {
  /** Feeds frames in order and returns which of them published. */
  const run = (
    frames: ReadonlyArray<readonly [ClaudeFastModeReport, "init" | "result"]>,
    fastRequested = true,
  ): ReadonlyArray<boolean> => {
    let previousSignature: string | undefined;
    return frames.map(([report, kind]) => {
      const decision = decideClaudeFastModePublish({
        previousSignature,
        report,
        isResult: kind === "result",
        fastRequested,
      });
      previousSignature = decision.signature;
      return decision.publish;
    });
  };
  const holding = (report: ClaudeFastModeReport) =>
    [
      [report, "init"],
      [report, "result"],
      [report, "init"],
      [report, "result"],
    ] as const;

  it("publishes the first report and every change of state or reason", () => {
    expect(
      run([
        [{ state: "on" }, "init"],
        [{ state: "on" }, "result"],
        [{ state: "on" }, "init"],
        [{ state: "cooldown" }, "result"],
        [{ state: "off", disabledReason: "preference" }, "init"],
        [{ state: "off", disabledReason: "free" }, "init"],
        [{ state: "off" }, "result"],
      ]),
    ).toEqual([true, false, false, true, true, true, true]);
  });

  it("republishes requested fast mode on each result while it does not serve, never on an init", () => {
    for (const report of [
      { state: "off", disabledReason: "not_first_party" },
      { state: "off", disabledReason: "something_new" },
      { state: "off", disabledReason: "preference" },
      { state: "off" },
      { state: "cooldown" },
    ] satisfies ReadonlyArray<ClaudeFastModeReport>) {
      expect(run(holding(report)), JSON.stringify(report)).toEqual([true, true, false, true]);
    }
  });

  it("never republishes requested fast mode while it serves", () => {
    expect(run(holding({ state: "on" }))).toEqual([true, false, false, false]);
  });

  it("republishes fast mode Claude Code turned on itself, and nothing else, when not requested", () => {
    expect(run(holding({ state: "on" }), false)).toEqual([true, true, false, true]);
    for (const report of [
      { state: "off" },
      { state: "off", disabledReason: "preference" },
      { state: "off", disabledReason: "free" },
      { state: "cooldown" },
    ] satisfies ReadonlyArray<ClaudeFastModeReport>) {
      expect(run(holding(report), false), JSON.stringify(report)).toEqual([
        true,
        false,
        false,
        false,
      ]);
    }
  });

  it("signs a report by state and reason only", () => {
    const sign = (report: ClaudeFastModeReport) =>
      decideClaudeFastModePublish({
        previousSignature: undefined,
        report,
        isResult: false,
        fastRequested: true,
      }).signature;
    expect(sign({ state: "off", disabledReason: "free", model: "claude-opus-4-8" })).toBe(
      "off:free",
    );
    expect(sign({ state: "on" })).toBe("on:");
  });
});
