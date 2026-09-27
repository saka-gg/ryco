import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { CodexResetCreditInput, CodexResetCredits } from "./codexResetCredits.ts";

describe("reset credit wire contracts", () => {
  it("preserves unknown versus empty details and an authoritative capped count", () => {
    const decode = Schema.decodeUnknownSync(CodexResetCredits);
    expect(decode({ availableCount: 3 })).toEqual({ availableCount: 3 });
    expect(decode({ availableCount: 3, credits: [] })).toEqual({ availableCount: 3, credits: [] });
    const detail = {
      id: "fixture-credit",
      grantedAt: 100,
      expiresAt: null,
      status: "available",
      resetType: "codexRateLimits",
    };
    expect(decode({ availableCount: 3, credits: [detail] }).credits?.[0]?.expiresAt).toBeNull();
  });
  it("requires an instance, account binding and nonempty attempt key", () => {
    const decode = Schema.decodeUnknownSync(CodexResetCreditInput);
    expect(() =>
      decode({ instanceId: "fixture", accountBinding: "fixture-account", idempotencyKey: " " }),
    ).toThrow();
    expect(() => decode({ instanceId: "fixture", idempotencyKey: "fixture-key" })).toThrow();
  });
});
