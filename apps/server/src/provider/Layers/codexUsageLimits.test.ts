import {
  EventId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
  type ProviderEvent,
  type ProviderRuntimeEvent,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  codexErrorInfoCode,
  codexUsageLimitState,
  isCodexUsageLimitError,
  makeCodexUsageLimitTracker,
  mergeCodexRateLimitSnapshot,
} from "./codexUsageLimits.ts";

const NOW_MS = Date.parse("2026-10-04T10:00:00.000Z");
const RESETS_AT = NOW_MS / 1000 + 3_600;
const RESET_ISO = new Date(RESETS_AT * 1000).toISOString();
const threadId = ThreadId.make("thread-1");
const turnId = TurnId.make("turn-1");
const codex = ProviderDriverKind.make("codex");

function providerEvent(method: string, payload: unknown, id = method): ProviderEvent {
  return {
    id: EventId.make(`evt-${id}`),
    kind: "notification",
    provider: codex,
    threadId,
    createdAt: "2026-10-04T10:00:00.000Z",
    method,
    turnId,
    payload,
  };
}

const base = (id: string) => ({
  eventId: EventId.make(`evt-${id}`),
  provider: codex,
  threadId,
  turnId,
  createdAt: "2026-10-04T10:00:00.000Z",
});

const rateLimitsMapped = (): ProviderRuntimeEvent[] => [
  { ...base("rate"), type: "account.rate-limits.updated", payload: { rateLimits: {} } },
];
const errorMapped = (message = "You've hit your usage limit."): ProviderRuntimeEvent[] => [
  { ...base("error"), type: "runtime.error", payload: { message, class: "provider_error" } },
];
const failedTurnMapped = (): ProviderRuntimeEvent[] => [
  {
    ...base("turn/completed"),
    type: "turn.completed",
    payload: { state: "failed", errorMessage: "Limit" },
  },
];

const exhausted = {
  rateLimits: { primary: { usedPercent: 100, resetsAt: RESETS_AT } },
};

describe("mergeCodexRateLimitSnapshot", () => {
  it("overrides present values and never clears on null or absent", () => {
    const first = mergeCodexRateLimitSnapshot(undefined, {
      planType: "pro",
      primary: { usedPercent: 50, resetsAt: RESETS_AT },
      secondary: { usedPercent: 10, resetsAt: RESETS_AT + 100 },
    });
    const merged = mergeCodexRateLimitSnapshot(first, {
      planType: null,
      primary: { usedPercent: 100, resetsAt: null },
    });
    expect(merged).toEqual({
      planType: "pro",
      primary: { usedPercent: 100, resetsAt: RESETS_AT },
      secondary: { usedPercent: 10, resetsAt: RESETS_AT + 100 },
    });
    expect(mergeCodexRateLimitSnapshot(merged, "junk")).toBe(merged);
  });
});

describe("codexUsageLimitState", () => {
  it("reads primary and secondary windows with second resets", () => {
    expect(codexUsageLimitState(exhausted.rateLimits, NOW_MS)).toEqual({
      exhausted: true,
      resetAt: RESET_ISO,
    });
    expect(
      codexUsageLimitState({ primary: { usedPercent: 100, resetsAt: NOW_MS / 1000 - 1 } }, NOW_MS),
    ).toEqual({ exhausted: false, resetAt: null });
    expect(codexUsageLimitState({ primary: { usedPercent: 100 } }, NOW_MS)).toEqual({
      exhausted: true,
      resetAt: null,
    });
    expect(codexUsageLimitState(undefined, NOW_MS)).toEqual({ exhausted: false, resetAt: null });
  });
});

describe("codexErrorInfoCode and isCodexUsageLimitError", () => {
  it("reads strings, single-key objects and rejects junk", () => {
    expect(codexErrorInfoCode("usageLimitExceeded")).toBe("usageLimitExceeded");
    expect(codexErrorInfoCode({ httpConnectionFailed: { httpStatusCode: 429 } })).toBe(
      "httpConnectionFailed",
    );
    expect(codexErrorInfoCode({ a: 1, b: 2 })).toBeUndefined();
    expect(codexErrorInfoCode(42)).toBeUndefined();
    expect(codexErrorInfoCode(null)).toBeUndefined();
  });

  it("only counts rateLimitExceeded while the snapshot is exhausted", () => {
    expect(isCodexUsageLimitError("usageLimitExceeded", { exhausted: false })).toBe(true);
    expect(isCodexUsageLimitError("rateLimitExceeded", { exhausted: false })).toBe(false);
    expect(isCodexUsageLimitError("rateLimitExceeded", { exhausted: true })).toBe(true);
    expect(isCodexUsageLimitError("badRequest", { exhausted: true })).toBe(false);
  });
});

describe("makeCodexUsageLimitTracker", () => {
  it("attaches the usage-limit state to rate-limit updates", () => {
    const tracker = makeCodexUsageLimitTracker();
    const [update] = tracker.annotate(
      providerEvent("account/rateLimits/updated", exhausted),
      rateLimitsMapped(),
      NOW_MS,
    );
    expect(
      update?.type === "account.rate-limits.updated" && update.payload.usageLimitState,
    ).toEqual({ exhausted: true, resetAt: RESET_ISO });
  });

  it("marks a usage-limit error with the reset and suppresses the turn's duplicate", () => {
    const tracker = makeCodexUsageLimitTracker();
    tracker.annotate(providerEvent("account/rateLimits/updated", exhausted), [], NOW_MS);
    const [error] = tracker.annotate(
      providerEvent("error", {
        error: { message: "Limit", codexErrorInfo: "usageLimitExceeded" },
        willRetry: false,
      }),
      errorMapped(),
      NOW_MS,
    );
    expect(error?.type === "runtime.error" && error.payload).toMatchObject({
      class: "usage_limit",
      resetAt: RESET_ISO,
    });
    const completed = tracker.annotate(
      providerEvent("turn/completed", {
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "Limit", codexErrorInfo: "usageLimitExceeded" },
        },
      }),
      failedTurnMapped(),
      NOW_MS,
    );
    expect(completed.map((event) => event.type)).toEqual(["turn.completed"]);
  });

  it("prepends a usage-limit error to a failed turn that had none", () => {
    const tracker = makeCodexUsageLimitTracker();
    const events = tracker.annotate(
      providerEvent("turn/completed", {
        turn: {
          id: "turn-1",
          status: "failed",
          error: { message: "Usage limit hit", codexErrorInfo: "usageLimitExceeded" },
        },
      }),
      failedTurnMapped(),
      NOW_MS,
    );
    expect(events.map((event) => event.type)).toEqual(["runtime.error", "turn.completed"]);
    const [error] = events;
    expect(error?.eventId).toBe("evt-turn/completed:usage-limit");
    expect(error?.turnId).toBe(turnId);
    expect(error?.type === "runtime.error" && error.payload).toEqual({
      message: "Usage limit hit",
      class: "usage_limit",
      resetAt: null,
    });
  });

  it("leaves rateLimitExceeded and retried errors alone unless the account is exhausted", () => {
    const tracker = makeCodexUsageLimitTracker();
    const rateLimited = providerEvent("error", {
      error: { message: "429", codexErrorInfo: "rateLimitExceeded" },
      willRetry: false,
    });
    expect(tracker.annotate(rateLimited, errorMapped("429"), NOW_MS)[0]).toMatchObject({
      payload: { class: "provider_error" },
    });
    const retried = providerEvent("error", {
      error: { message: "Limit", codexErrorInfo: "usageLimitExceeded" },
      willRetry: true,
    });
    expect(tracker.annotate(retried, errorMapped(), NOW_MS)[0]).toMatchObject({
      payload: { class: "provider_error" },
    });
    tracker.annotate(providerEvent("account/rateLimits/updated", exhausted), [], NOW_MS);
    expect(tracker.annotate(rateLimited, errorMapped("429"), NOW_MS)[0]).toMatchObject({
      payload: { class: "usage_limit", resetAt: RESET_ISO },
    });
  });
});
