import { SourceControlProviderError } from "@ryco/contracts";
import { Schema } from "effect";
import { assert, describe, it } from "vite-plus/test";

import { classifyOverviewError } from "./overviewErrors.logic";

const NOW = 1_000_000_000_000;
const options = { nowMs: NOW, formatTime: () => "14:32" };

describe("classifyOverviewError", () => {
  it("returns null when there is no error", () => {
    assert.equal(classifyOverviewError(null), null);
    assert.equal(classifyOverviewError(undefined), null);
    assert.equal(classifyOverviewError(""), null);
    assert.equal(classifyOverviewError("   "), null);
  });

  it("classifies the gh timeout as transient without leaking the command", () => {
    const raw =
      "Source control provider github failed in getChangeRequestDetail: VcsProcessTimeoutError VCS process timed out in GitHubCli.execute: gh pr view 159 --json number,title,url after 30000ms";
    const info = classifyOverviewError(raw);
    assert.equal(info?.kind, "transient");
    assert.equal(info?.message, "Loading pull request details timed out. Try refreshing.");
    // The raw text is preserved for logging but is not the user-facing message.
    assert.equal(info?.raw, raw);
    assert.equal(info?.message.includes("gh pr view"), false);
  });

  it("classifies network failures as transient", () => {
    assert.equal(classifyOverviewError("connect ECONNRESET 140.82.121.4:443")?.kind, "transient");
    assert.equal(classifyOverviewError("getaddrinfo ENOTFOUND api.github.com")?.kind, "transient");
    assert.equal(classifyOverviewError("fetch failed")?.kind, "transient");
  });

  it("classifies rate limiting as transient", () => {
    const info = classifyOverviewError("API rate limit exceeded for user");
    assert.equal(info?.kind, "transient");
    assert.match(info?.message ?? "", /rate limiting/i);
  });

  it("classifies auth and not-found failures as terminal", () => {
    assert.equal(classifyOverviewError("gh auth login required")?.kind, "terminal");
    assert.equal(classifyOverviewError("HTTP 401: Bad credentials")?.kind, "terminal");
    assert.equal(
      classifyOverviewError("Could not resolve to a PullRequest with the number 159.")?.kind,
      "terminal",
    );
  });

  it("treats unrecognized errors as transient with generic copy", () => {
    const info = classifyOverviewError("something totally unexpected happened");
    assert.equal(info?.kind, "transient");
    assert.equal(info?.message, "Couldn't load pull request details. Try refreshing.");
  });

  it("reads the message from Error instances and message-bearing objects", () => {
    assert.equal(classifyOverviewError(new Error("request timed out"))?.kind, "transient");
    assert.equal(classifyOverviewError({ message: "HTTP 401" })?.kind, "terminal");
  });
});

describe("classifyOverviewError with typed provider errors", () => {
  it("says until when a rate-limited host pauses requests", () => {
    const info = classifyOverviewError(
      new SourceControlProviderError({
        provider: "github",
        operation: "getChangeRequestDetail",
        detail: "GitHub requests are paused after a rate limit.",
        reason: "rate-limited",
        retryAt: NOW + 300_000,
      }),
      options,
    );
    assert.equal(info?.kind, "transient");
    assert.equal(info?.message, "GitHub requests paused until 14:32");
    assert.equal(info?.paused, true);
  });

  it("follows the typed reason, not words the command line put into the message", () => {
    // `gh pr view` of a branch titled "Fix rate limit 401": the text matches every rule.
    const detail = 'gh pr view "Fix rate limit 401" --json number: no pull requests found';
    const notFound = classifyOverviewError(
      new SourceControlProviderError({
        provider: "github",
        operation: "getChangeRequestDetail",
        detail,
        reason: "not-found",
      }),
      options,
    );
    assert.equal(notFound?.kind, "terminal");
    assert.equal(notFound?.message, "This pull request could not be found.");
    assert.equal(notFound?.paused, undefined);

    const signIn = classifyOverviewError(
      new SourceControlProviderError({
        provider: "gitlab",
        operation: "getChangeRequestDetail",
        detail: "glab mr view 404 failed",
        reason: "unauthenticated",
      }),
      options,
    );
    assert.equal(
      signIn?.message,
      "Sign in to your source control provider to load this pull request.",
    );

    // Any other typed reason skips the reason rules; timeouts still read as timeouts.
    const failed = classifyOverviewError(
      new SourceControlProviderError({
        provider: "github",
        operation: "getChangeRequestDetail",
        detail: "gh pr view rate-limit-401-not-found timed out",
        reason: "failed",
      }),
      options,
    );
    assert.equal(failed?.message, "Loading pull request details timed out. Try refreshing.");
  });

  it("keeps today's rules for errors without a reason", () => {
    // A server before the reason field sends none.
    const olderServerError = (detail: string) =>
      Schema.decodeUnknownSync(SourceControlProviderError)({
        _tag: "SourceControlProviderError",
        provider: "github",
        operation: "getChangeRequestDetail",
        detail,
      });
    const legacy = classifyOverviewError(
      olderServerError("Could not resolve to a PullRequest with the number 159."),
      options,
    );
    assert.equal(legacy?.message, "This pull request could not be found.");
    // An older server's rate-limit detail reads as a pause without a time.
    const legacyPause = classifyOverviewError(
      olderServerError("GitHub API rate limit exceeded. Wait for the reset window and retry."),
      options,
    );
    assert.equal(legacyPause?.message, "GitHub requests paused");
    assert.equal(legacyPause?.paused, true);
  });
});
