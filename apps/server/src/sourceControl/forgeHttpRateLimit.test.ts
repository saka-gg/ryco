import { describe, expect, it } from "@effect/vitest";

import {
  FORGE_MAX_EXPLICIT_PAUSE_MS,
  forgeFailureFields,
  forgeFailureKindFromHttp,
  forgeHttpFailureFields,
  retryAtFromHeaders,
} from "./forgeHttpRateLimit.ts";

const NOW = 1_000_000_000_000;

describe("retryAtFromHeaders", () => {
  it("reads Retry-After as delta-seconds or an HTTP-date", () => {
    expect(retryAtFromHeaders({ "retry-after": "120" }, NOW)).toBe(NOW + 120_000);
    const date = new Date(NOW + 90_000).toUTCString();
    expect(retryAtFromHeaders({ "retry-after": date }, NOW)).toBe(NOW + 90_000);
  });

  it("reads reset headers only when their quota is spent", () => {
    // GitHub: epoch seconds.
    expect(
      retryAtFromHeaders({ "x-ratelimit-reset": "1000000600", "x-ratelimit-remaining": "0" }, NOW),
    ).toBe(1_000_000_600_000);
    // GitLab (IETF draft): delta-seconds.
    expect(retryAtFromHeaders({ "ratelimit-reset": "30", "ratelimit-remaining": "0" }, NOW)).toBe(
      NOW + 30_000,
    );
    // GitHub sends the primary window's reset on every response, also on a
    // secondary limit with quota left: that is not when to retry.
    expect(
      retryAtFromHeaders(
        { "x-ratelimit-reset": "1000000600", "x-ratelimit-remaining": "4999" },
        NOW,
      ),
    ).toBeUndefined();
    expect(retryAtFromHeaders({ "x-ratelimit-reset": "1000000600" }, NOW)).toBeUndefined();
    expect(retryAtFromHeaders({ "ratelimit-reset": "30" }, NOW)).toBeUndefined();
  });

  it("prefers Retry-After, then falls through to the next usable header", () => {
    expect(
      retryAtFromHeaders(
        {
          "retry-after": "60",
          "x-ratelimit-reset": "1000000600",
          "x-ratelimit-remaining": "0",
        },
        NOW,
      ),
    ).toBe(NOW + 60_000);
    expect(
      retryAtFromHeaders(
        {
          "retry-after": "soon",
          "x-ratelimit-reset": "1000000600",
          "x-ratelimit-remaining": "0",
        },
        NOW,
      ),
    ).toBe(1_000_000_600_000);
  });

  it("ignores past, garbage and fractional values", () => {
    expect(retryAtFromHeaders({ "retry-after": "0" }, NOW)).toBeUndefined();
    expect(
      retryAtFromHeaders({ "retry-after": new Date(NOW - 60_000).toUTCString() }, NOW),
    ).toBeUndefined();
    // An epoch reset that already passed (2020-09-13 against 2023-11-14).
    expect(
      retryAtFromHeaders(
        { "x-ratelimit-reset": "1600000000", "x-ratelimit-remaining": "0" },
        1_700_000_000_000,
      ),
    ).toBeUndefined();
    expect(retryAtFromHeaders({ "retry-after": "soon" }, NOW)).toBeUndefined();
    expect(retryAtFromHeaders({ "retry-after": "1.5" }, NOW)).toBeUndefined();
    expect(retryAtFromHeaders({ "retry-after": "-30" }, NOW)).toBeUndefined();
    expect(retryAtFromHeaders({ "retry-after": "" }, NOW)).toBeUndefined();
    expect(retryAtFromHeaders({}, NOW)).toBeUndefined();
  });

  it("clamps to an hour and returns whole milliseconds", () => {
    expect(retryAtFromHeaders({ "retry-after": "999999" }, NOW)).toBe(
      NOW + FORGE_MAX_EXPLICIT_PAUSE_MS,
    );
    expect(FORGE_MAX_EXPLICIT_PAUSE_MS).toBe(3_600_000);
    const at = retryAtFromHeaders({ "retry-after": "30" }, NOW + 0.25);
    expect(Number.isInteger(at)).toBe(true);
    expect(at).toBe(NOW + 30_001);
  });
});

describe("forgeFailureKindFromHttp", () => {
  it("maps the statuses that state a kind", () => {
    expect(forgeFailureKindFromHttp(401)).toBe("unauthenticated");
    expect(forgeFailureKindFromHttp(404)).toBe("not-found");
    expect(forgeFailureKindFromHttp(429)).toBe("rate-limited");
  });

  it("reads a 403 as a rate limit only with Retry-After or a spent quota", () => {
    expect(forgeFailureKindFromHttp(403, { "retry-after": "60" })).toBe("rate-limited");
    expect(forgeFailureKindFromHttp(403, { "x-ratelimit-remaining": "0" })).toBe("rate-limited");
    expect(forgeFailureKindFromHttp(403, { "ratelimit-remaining": "0" })).toBe("rate-limited");
    expect(forgeFailureKindFromHttp(403, { "x-ratelimit-remaining": "12" })).toBeUndefined();
    expect(forgeFailureKindFromHttp(403)).toBeUndefined();
  });

  it("leaves other statuses unclassified", () => {
    expect(forgeFailureKindFromHttp(500)).toBeUndefined();
    expect(forgeFailureKindFromHttp(409)).toBeUndefined();
    expect(forgeFailureKindFromHttp(null)).toBeUndefined();
    expect(forgeFailureKindFromHttp(undefined)).toBeUndefined();
  });
});

describe("forgeFailureFields", () => {
  it("keeps only the fields that are set, and a retry time only for a rate limit", () => {
    expect(forgeFailureFields({})).toEqual({});
    expect(forgeFailureFields({ failureKind: undefined, retryAt: NOW })).toEqual({});
    expect(forgeFailureFields({ failureKind: "not-found", retryAt: NOW })).toEqual({
      failureKind: "not-found",
    });
    expect(forgeFailureFields({ failureKind: "rate-limited" })).toEqual({
      failureKind: "rate-limited",
    });
    expect(forgeFailureFields({ failureKind: "rate-limited", retryAt: NOW })).toEqual({
      failureKind: "rate-limited",
      retryAt: NOW,
    });
  });
});

describe("forgeHttpFailureFields", () => {
  it("reads the kind from the status and the retry time from a rate limit's headers", () => {
    expect(forgeHttpFailureFields(429, { "retry-after": "30" }, NOW)).toEqual({
      failureKind: "rate-limited",
      retryAt: NOW + 30_000,
    });
    expect(forgeHttpFailureFields(429, {}, NOW)).toEqual({ failureKind: "rate-limited" });
    expect(forgeHttpFailureFields(404, { "retry-after": "30" }, NOW)).toEqual({
      failureKind: "not-found",
    });
    expect(forgeHttpFailureFields(500, { "retry-after": "30" }, NOW)).toEqual({});
  });
});
