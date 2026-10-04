import { describe, expect, it } from "vite-plus/test";
import { Cause } from "effect";

import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderSessionNotFoundError,
  ProviderTurnNotSteerableError,
} from "../provider/Errors.ts";
import {
  classifyTurnSteerFailure,
  TURN_STEER_FAILED_FALLBACK,
  TURN_STEER_SESSION_ENDED_DETAIL,
} from "./turnSteerFailure.ts";
import { userFacingFailureDetail } from "./userFacingErrors.ts";

const classify = (error: unknown) =>
  classifyTurnSteerFailure(Cause.fail(error), (cause) => userFacingFailureDetail(cause));

describe("classifyTurnSteerFailure", () => {
  it("defers a not-steerable turn with its own detail", () => {
    expect(
      classify(
        new ProviderTurnNotSteerableError({
          provider: "claudeAgent",
          threadId: "thread-1",
          reason: "busy",
          detail: "Claude is waiting for an approval or answer. The message stays queued.",
        }),
      ),
    ).toEqual({
      reason: "deferred",
      error: "Claude is waiting for an approval or answer. The message stays queued.",
    });
  });

  it.each([
    new ProviderSessionNotFoundError({ threadId: "thread-1" }),
    new ProviderAdapterSessionNotFoundError({ provider: "codex", threadId: "thread-1" }),
    new ProviderAdapterSessionClosedError({ provider: "codex", threadId: "thread-1" }),
  ])("defers a vanished session without its raw text: $_tag", (error) => {
    const classified = classify(error);
    expect(classified).toEqual({ reason: "deferred", error: TURN_STEER_SESSION_ENDED_DETAIL });
    expect(classified.error).not.toContain("Unknown provider thread");
    expect(classified.error).not.toContain("thread-1");
  });

  it("fails a request error with its detail", () => {
    expect(
      classify(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "turn/steer",
          detail: "steer exploded",
        }),
      ),
    ).toEqual({ reason: "failed", error: "steer exploded" });
  });

  it("falls back when the failure has no text", () => {
    expect(classifyTurnSteerFailure(Cause.fail("x"), () => "   ")).toEqual({
      reason: "failed",
      error: TURN_STEER_FAILED_FALLBACK,
    });
  });

  it("caps the error at 1,000 characters", () => {
    const classified = classifyTurnSteerFailure(Cause.fail("x"), () => "a".repeat(1_500));
    expect(classified.reason).toBe("failed");
    expect(classified.error).toHaveLength(1_000);
  });
});
