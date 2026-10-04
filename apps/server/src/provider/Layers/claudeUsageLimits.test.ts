import type { SDKRateLimitInfo, SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";

import {
  applyClaudeRateLimitInfo,
  classifyClaudeUsageLimitResult,
  claudeUsageLimitState,
  type ClaudeRejectedRateLimitWindows,
} from "./claudeUsageLimits.ts";

const NOW_MS = Date.parse("2026-10-04T10:00:00.000Z");
const RESETS_AT = NOW_MS / 1000 + 3_600;
const RESET_ISO = new Date(RESETS_AT * 1000).toISOString();

const info = (overrides: Partial<SDKRateLimitInfo>): SDKRateLimitInfo => ({
  status: "rejected",
  rateLimitType: "five_hour",
  resetsAt: RESETS_AT,
  ...overrides,
});

const success = (overrides: Record<string, unknown> = {}): SDKResultMessage =>
  ({
    type: "result",
    subtype: "success",
    is_error: false,
    result: "done",
    ...overrides,
  }) as unknown as SDKResultMessage;

const failure = (overrides: Record<string, unknown> = {}): SDKResultMessage =>
  ({
    type: "result",
    subtype: "error_during_execution",
    is_error: true,
    errors: ["Request failed"],
    ...overrides,
  }) as unknown as SDKResultMessage;

function rejectedWindows(): ClaudeRejectedRateLimitWindows {
  const windows: ClaudeRejectedRateLimitWindows = new Map();
  applyClaudeRateLimitInfo(windows, info({}));
  return windows;
}

describe("applyClaudeRateLimitInfo", () => {
  it("tracks blocked windows and clears them when allowed or overage covers them", () => {
    const windows: ClaudeRejectedRateLimitWindows = new Map();
    const blocked = applyClaudeRateLimitInfo(windows, info({}));
    expect(blocked).toEqual({
      blocked: true,
      key: `five_hour:${RESETS_AT}`,
      limitType: "five_hour",
      resetAt: RESET_ISO,
    });
    expect(windows.get("five_hour")).toBe(RESET_ISO);

    expect(applyClaudeRateLimitInfo(windows, info({ status: "allowed" })).blocked).toBe(false);
    expect(windows.has("five_hour")).toBe(false);

    applyClaudeRateLimitInfo(windows, info({}));
    const overage = applyClaudeRateLimitInfo(windows, info({ overageStatus: "allowed" }));
    expect(overage.blocked).toBe(false);
    expect(windows.size).toBe(0);
    expect(applyClaudeRateLimitInfo(windows, info({ isUsingOverage: true })).blocked).toBe(false);
    expect(applyClaudeRateLimitInfo(windows, info({ status: "allowed_warning" })).blocked).toBe(
      false,
    );
  });

  it("records an unknown reset for missing or unrepresentable times", () => {
    const windows: ClaudeRejectedRateLimitWindows = new Map();
    applyClaudeRateLimitInfo(windows, { status: "rejected" });
    expect(windows.get("unknown")).toBeNull();
    applyClaudeRateLimitInfo(windows, info({ rateLimitType: "seven_day", resetsAt: 1e16 }));
    expect(windows.get("seven_day")).toBeNull();
  });
});

describe("claudeUsageLimitState", () => {
  it("ignores windows whose reset already passed", () => {
    const windows: ClaudeRejectedRateLimitWindows = new Map([
      ["five_hour", new Date(NOW_MS - 1_000).toISOString()],
    ]);
    expect(claudeUsageLimitState(windows, NOW_MS)).toEqual({ exhausted: false, resetAt: null });
    expect(claudeUsageLimitState(rejectedWindows(), NOW_MS)).toEqual({
      exhausted: true,
      resetAt: RESET_ISO,
    });
  });
});

describe("classifyClaudeUsageLimitResult", () => {
  const classify = (result: SDKResultMessage, windows = new Map<string, string | null>()) =>
    classifyClaudeUsageLimitResult({ result, windows, nowMs: NOW_MS });

  it("treats blocking_limit as a limit with or without a rejected window", () => {
    expect(
      classify(success({ is_error: true, terminal_reason: "blocking_limit", result: "Limit" })),
    ).toEqual({ message: "Limit", resetAt: null });
    expect(
      classify(
        success({ is_error: true, terminal_reason: "blocking_limit", result: "Limit" }),
        rejectedWindows(),
      ),
    ).toEqual({ message: "Limit", resetAt: RESET_ISO });
  });

  it("treats an error result while a window is rejected as a limit", () => {
    expect(classify(failure(), rejectedWindows())).toEqual({
      message: "Request failed",
      resetAt: RESET_ISO,
    });
    expect(
      classify(
        success({ is_error: true, terminal_reason: "api_error", api_error_status: 429 }),
        rejectedWindows(),
      ),
    ).toMatchObject({ resetAt: RESET_ISO });
  });

  it("leaves a bare 429 without a rejected window alone", () => {
    expect(
      classify(success({ is_error: true, terminal_reason: "api_error", api_error_status: 429 })),
    ).toBeNull();
  });

  it("does not classify other terminal reasons, other statuses or successful results", () => {
    expect(classify(failure({ terminal_reason: "prompt_too_long" }), rejectedWindows())).toBeNull();
    expect(
      classify(success({ is_error: true, api_error_status: 500 }), rejectedWindows()),
    ).toBeNull();
    expect(classify(success(), rejectedWindows())).toBeNull();
  });

  it("ignores expired windows", () => {
    const expired = new Map([["five_hour", new Date(NOW_MS - 1).toISOString()]]);
    expect(classify(failure(), expired)).toBeNull();
  });

  it("falls back to a stock message and truncates long ones", () => {
    expect(
      classify(success({ is_error: true, terminal_reason: "blocking_limit", result: "  " })),
    ).toEqual({ message: "Claude usage limit reached.", resetAt: null });
    const long = "x".repeat(800);
    expect(
      classify(success({ is_error: true, terminal_reason: "blocking_limit", result: long }))
        ?.message,
    ).toHaveLength(500);
  });
});
