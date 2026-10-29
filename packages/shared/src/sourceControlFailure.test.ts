import { SourceControlProviderError } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  isRateLimitedSourceControlFailure,
  readSourceControlFailure,
} from "./sourceControlFailure.ts";

describe("readSourceControlFailure", () => {
  it("reads a wire-decoded provider error", () => {
    const decode = Schema.decodeUnknownSync(SourceControlProviderError);
    const error = decode({
      _tag: "SourceControlProviderError",
      provider: "bitbucket",
      operation: "listChangeRequests",
      detail: "Bitbucket is rate limiting requests (HTTP 429).",
      reason: "rate-limited",
      retryAt: 1_000_000_030_000,
    });
    expect(readSourceControlFailure(error)).toEqual({
      provider: "bitbucket",
      reason: "rate-limited",
      retryAt: 1_000_000_030_000,
    });
    expect(isRateLimitedSourceControlFailure(error)).toBe(true);
  });

  it("reads a plain object with the tag, and errors from servers without the fields", () => {
    expect(
      readSourceControlFailure({
        _tag: "SourceControlProviderError",
        provider: "gitlab",
        reason: "not-found",
      }),
    ).toEqual({ provider: "gitlab", reason: "not-found", retryAt: null });
    // A server before the fields sends neither.
    const legacy = Schema.decodeUnknownSync(SourceControlProviderError)({
      _tag: "SourceControlProviderError",
      provider: "github",
      operation: "listChangeRequests",
      detail: "GitHub API rate limit exceeded. Wait for the reset window and retry.",
    });
    expect(readSourceControlFailure(legacy)).toEqual({
      provider: "github",
      reason: null,
      retryAt: null,
    });
    // Without a typed reason, rate-limit wording alone is not a typed pause.
    expect(isRateLimitedSourceControlFailure(legacy)).toBe(false);
  });

  it("reads fields of the wrong type as absent", () => {
    expect(
      readSourceControlFailure({
        _tag: "SourceControlProviderError",
        provider: "sourcehut",
        reason: "quota-reserved",
        retryAt: 1.5,
      }),
    ).toEqual({ provider: "unknown", reason: null, retryAt: null });
    expect(
      readSourceControlFailure({ _tag: "SourceControlProviderError", retryAt: -5 })?.retryAt,
    ).toBeNull();
  });

  it("returns null for other errors", () => {
    expect(readSourceControlFailure({ _tag: "SourceControlRepositoryError" })).toBeNull();
    expect(readSourceControlFailure(new Error("rate limit"))).toBeNull();
    expect(readSourceControlFailure("rate-limited")).toBeNull();
    expect(readSourceControlFailure(null)).toBeNull();
    expect(isRateLimitedSourceControlFailure({ reason: "rate-limited" })).toBe(false);
  });
});
