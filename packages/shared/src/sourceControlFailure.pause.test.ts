import { SourceControlProviderError } from "@ryco/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  describeSourceControlPause,
  readSourceControlPause,
  SOURCE_CONTROL_PAUSE_MAX_RETRY_DELAY_MS,
  sourceControlPauseRetryDelayMs,
} from "./sourceControlFailure.ts";

const NOW = 1_000_000_000_000;
const formatTime = (epochMs: number) => (epochMs === NOW + 300_000 ? "14:32" : `t${epochMs}`);

function pausedError(input: {
  readonly provider?: "github" | "gitlab" | "bitbucket" | "forgejo" | "unknown";
  readonly retryAt?: number;
}) {
  return Schema.decodeUnknownSync(SourceControlProviderError)({
    _tag: "SourceControlProviderError",
    provider: input.provider ?? "github",
    operation: "listChangeRequests",
    detail: "GitHub requests are paused after a rate limit.",
    reason: "rate-limited",
    ...(input.retryAt !== undefined ? { retryAt: input.retryAt } : {}),
  });
}

describe("readSourceControlPause", () => {
  it("reads a typed pause, with and without its end", () => {
    expect(readSourceControlPause(pausedError({ retryAt: NOW + 300_000 }))).toEqual({
      provider: "github",
      retryAt: NOW + 300_000,
    });
    expect(readSourceControlPause(pausedError({ provider: "gitlab" }))).toEqual({
      provider: "gitlab",
      retryAt: null,
    });
  });

  it("reads an older server's rate-limit detail as a pause without an end", () => {
    // A server before the reason field sends none.
    const legacy = Schema.decodeUnknownSync(SourceControlProviderError)({
      _tag: "SourceControlProviderError",
      provider: "github",
      operation: "listChangeRequests",
      detail: "GitHub API rate limit exceeded. Wait for the reset window and retry.",
    });
    expect(readSourceControlPause(legacy)).toEqual({ provider: "github", retryAt: null });
  });

  it("never reads a newer server's unclassified failure as a pause", () => {
    // The process error's text names the cwd, here a folder called "API rate limit service".
    const unclassified = new SourceControlProviderError({
      provider: "github",
      operation: "listChangeRequests",
      detail:
        "VCS process failed in GitHubCli.execute: gh pr list (/Users/x/Code/API rate limit service) exited with 1 - unexpected EOF",
    });
    const wire = Schema.decodeUnknownSync(SourceControlProviderError)(
      Schema.encodeSync(SourceControlProviderError)(unclassified),
    );
    expect(wire.reason).toBe("failed");
    expect(readSourceControlPause(wire)).toBeNull();
    expect(readSourceControlPause(unclassified)).toBeNull();
  });

  it("trusts any other typed reason over the words in the detail", () => {
    // A title in the command line can put "rate limit" into a not-found detail.
    const notFound = new SourceControlProviderError({
      provider: "github",
      operation: "createChangeRequest",
      detail: "gh pr create --title Handle rate limit errors: not found",
      reason: "not-found",
    });
    expect(readSourceControlPause(notFound)).toBeNull();
  });

  it("is null for other errors", () => {
    expect(readSourceControlPause(new Error("API rate limit exceeded"))).toBeNull();
    expect(readSourceControlPause({ _tag: "SourceControlRepositoryError" })).toBeNull();
    expect(
      readSourceControlPause(
        new SourceControlProviderError({
          provider: "github",
          operation: "listChangeRequests",
          detail: "gh: Not Found (HTTP 404)",
        }),
      ),
    ).toBeNull();
    expect(readSourceControlPause(null)).toBeNull();
  });
});

describe("describeSourceControlPause", () => {
  it("names the host and the time requests go out again", () => {
    expect(
      describeSourceControlPause(
        { provider: "github", retryAt: NOW + 300_000 },
        { nowMs: NOW, formatTime },
      ),
    ).toEqual({
      title: "GitHub requests paused until 14:32",
      detail: "GitHub is rate limiting this account. Ryco tries again then.",
    });
  });

  it("leaves the time out when none is known or it has passed", () => {
    const noTime = {
      title: "GitHub requests paused",
      detail: "GitHub is rate limiting this account. Ryco tries again shortly.",
    };
    expect(
      describeSourceControlPause({ provider: "github", retryAt: null }, { nowMs: NOW, formatTime }),
    ).toEqual(noTime);
    expect(
      describeSourceControlPause({ provider: "github", retryAt: NOW }, { nowMs: NOW, formatTime }),
    ).toEqual(noTime);
  });

  it("uses each host's name", () => {
    const title = (provider: "gitlab" | "bitbucket" | "forgejo" | "unknown") =>
      describeSourceControlPause({ provider, retryAt: null }, { nowMs: NOW, formatTime }).title;
    expect(title("gitlab")).toBe("GitLab requests paused");
    expect(title("bitbucket")).toBe("Bitbucket requests paused");
    expect(title("forgejo")).toBe("Forgejo requests paused");
    expect(title("unknown")).toBe("Source control requests paused");
    expect(
      describeSourceControlPause({ provider: "unknown", retryAt: null }, { nowMs: NOW, formatTime })
        .detail,
    ).toBe("The source control provider is rate limiting this account. Ryco tries again shortly.");
  });
});

describe("sourceControlPauseRetryDelayMs", () => {
  it("waits until the pause ends, between 1 s and 15 min", () => {
    expect(sourceControlPauseRetryDelayMs(pausedError({ retryAt: NOW + 120_000 }), NOW)).toBe(
      120_000,
    );
    expect(sourceControlPauseRetryDelayMs(pausedError({ retryAt: NOW + 200 }), NOW)).toBe(1_000);
    expect(sourceControlPauseRetryDelayMs(pausedError({ retryAt: NOW - 5_000 }), NOW)).toBe(1_000);
    expect(sourceControlPauseRetryDelayMs(pausedError({ retryAt: NOW + 3_600_000 }), NOW)).toBe(
      SOURCE_CONTROL_PAUSE_MAX_RETRY_DELAY_MS,
    );
  });

  it("backs off when the pause's end has already passed", () => {
    // A rate-limited answer the server still holds, or a browser clock ahead of the node's.
    const passed = pausedError({ retryAt: NOW - 5_000 });
    expect(
      [1, 2, 3, 4, 5].map((failures) => sourceControlPauseRetryDelayMs(passed, NOW, failures)),
    ).toEqual([1_000, 2_000, 4_000, 8_000, 16_000]);
    expect(sourceControlPauseRetryDelayMs(passed, NOW, 40)).toBe(
      SOURCE_CONTROL_PAUSE_MAX_RETRY_DELAY_MS,
    );
    // A pause still running ends when it says, unless that is sooner than the backoff.
    expect(sourceControlPauseRetryDelayMs(pausedError({ retryAt: NOW + 120_000 }), NOW, 3)).toBe(
      120_000,
    );
    expect(sourceControlPauseRetryDelayMs(pausedError({ retryAt: NOW + 3_000 }), NOW, 3)).toBe(
      4_000,
    );
  });

  it("is null without a known end or for other errors", () => {
    expect(sourceControlPauseRetryDelayMs(pausedError({}), NOW)).toBeNull();
    expect(sourceControlPauseRetryDelayMs(new Error("timeout"), NOW)).toBeNull();
    expect(sourceControlPauseRetryDelayMs(null, NOW)).toBeNull();
  });
});
