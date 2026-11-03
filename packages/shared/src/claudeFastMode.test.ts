import { describe, expect, it } from "vite-plus/test";

import {
  classifyClaudeFastModeReport,
  type ClaudeFastModeReport,
  parseClaudeFastModeReport,
} from "./claudeFastMode.ts";

describe("parseClaudeFastModeReport", () => {
  it("keeps a valid report", () => {
    expect(
      parseClaudeFastModeReport({
        state: "off",
        disabledReason: "not_first_party",
        model: "claude-opus-4-8",
      }),
    ).toEqual({ state: "off", disabledReason: "not_first_party", model: "claude-opus-4-8" });
    expect(parseClaudeFastModeReport({ state: "on" })).toEqual({ state: "on" });
    expect(parseClaudeFastModeReport({ state: "cooldown", extra: true })).toEqual({
      state: "cooldown",
    });
  });

  it("rejects a record without a state Claude Code defines", () => {
    for (const value of [
      undefined,
      null,
      "on",
      [],
      {},
      { state: "ON" },
      { state: "fast" },
      { state: 1 },
      { disabledReason: "free" },
    ]) {
      expect(parseClaudeFastModeReport(value), JSON.stringify(value)).toBeUndefined();
    }
  });

  it("drops a reason that is not a bounded snake_case word", () => {
    for (const disabledReason of [
      "Not First Party",
      "not-first-party",
      "free<script>",
      "",
      "a".repeat(49),
      42,
    ]) {
      expect(parseClaudeFastModeReport({ state: "off", disabledReason })).toEqual({ state: "off" });
    }
    expect(parseClaudeFastModeReport({ state: "off", disabledReason: "a".repeat(48) })).toEqual({
      state: "off",
      disabledReason: "a".repeat(48),
    });
  });

  it("drops an empty, long or non-string model", () => {
    for (const model of ["", "m".repeat(200), "m".repeat(129), 7]) {
      expect(parseClaudeFastModeReport({ state: "on", model })).toEqual({ state: "on" });
    }
    expect(parseClaudeFastModeReport({ state: "on", model: "m".repeat(128) })?.model).toBe(
      "m".repeat(128),
    );
  });

  it("keeps whether the session requested fast mode only as a boolean", () => {
    expect(parseClaudeFastModeReport({ state: "on", requested: true })).toEqual({
      state: "on",
      requested: true,
    });
    expect(parseClaudeFastModeReport({ state: "on", requested: false })).toEqual({
      state: "on",
      requested: false,
    });
    for (const requested of ["true", 1, null]) {
      expect(parseClaudeFastModeReport({ state: "on", requested })).toEqual({ state: "on" });
    }
  });
});

describe("classifyClaudeFastModeReport", () => {
  it("reads each state and reason", () => {
    const table: ReadonlyArray<readonly [ClaudeFastModeReport, string]> = [
      [{ state: "on" }, "serving"],
      [{ state: "on", disabledReason: "free" }, "serving"],
      [{ state: "cooldown" }, "cooldown"],
      [{ state: "off" }, "standard"],
      [{ state: "off", disabledReason: "preference" }, "standard"],
      [{ state: "off", disabledReason: "sdk_opt_in_required" }, "standard"],
      [{ state: "off", disabledReason: "pending" }, "standard"],
      [{ state: "off", disabledReason: "not_first_party" }, "blocked"],
      [{ state: "off", disabledReason: "free" }, "blocked"],
      [{ state: "off", disabledReason: "extra_usage_disabled" }, "blocked"],
      [{ state: "off", disabledReason: "disabled_by_env" }, "blocked"],
      [{ state: "off", disabledReason: "model_not_allowed" }, "blocked"],
      [{ state: "off", disabledReason: "network_error" }, "blocked"],
      [{ state: "off", disabledReason: "unknown" }, "blocked"],
      [{ state: "off", disabledReason: "something_new" }, "blocked"],
    ];
    for (const [report, expected] of table) {
      expect(classifyClaudeFastModeReport(report), JSON.stringify(report)).toBe(expected);
    }
  });
});
