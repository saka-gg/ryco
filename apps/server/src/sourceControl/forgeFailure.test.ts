import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { afterAll, assert, describe, expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { VcsProcessExitError, VcsProcessSpawnError, VcsProcessTimeoutError } from "@ryco/contracts";

import * as VcsProcess from "../vcs/VcsProcess.ts";
import {
  classifyForgeFailure,
  forgeFailureText,
  isForgeRateLimitText,
  isMissingToolSpawnError,
  sourceControlProviderErrorFrom,
} from "./forgeFailure.ts";

describe("isForgeRateLimitText", () => {
  it("matches the limits forges report", () => {
    for (const text of [
      "gh: API rate limit exceeded for user ID 1. (HTTP 403)",
      "GraphQL: API rate limit already exceeded for user ID 1.",
      "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.",
      "You have triggered an abuse detection mechanism. Please wait a few minutes.",
      "glab: 429 Too Many Requests (HTTP 429)",
      "Request failed with status code 429",
      "Too Many Requests (429)",
      "gh: HTTP 403: rate limit for this resource (https://api.github.com/graphql)",
      "TF400733: The request has been canceled: Request was blocked due to exceeding usage of resource 'Concurrency' in namespace 'User'.",
    ]) {
      expect(isForgeRateLimitText(text), text).toBe(true);
    }
  });

  it("does not match MR numbers, titles or GraphQL fields", () => {
    for (const text of [
      "merge request !429 not found",
      "Fix rate-limit handling",
      "rateLimit { remaining resetAt }",
      "gh: Not Found (HTTP 404)",
      "HTTP 403: Must have admin rights to Repository.",
      // Branch and repository names the CLIs echo (no spaces or colons in them).
      'no pull requests found for branch "fix-(429)"',
      "TF401398: The source branch refs/heads/fix/tf400733-retry no longer exists.",
    ]) {
      expect(isForgeRateLimitText(text), text).toBe(false);
    }
  });
});

describe("forgeFailureText", () => {
  it("returns what the forge said, not the command line or cwd", () => {
    expect(
      forgeFailureText(
        new VcsProcessExitError({
          operation: "GitHubCli.execute",
          command: "gh pr create --title Handle rate limit errors",
          cwd: "/repo/rate limit demo",
          exitCode: 1,
          detail: 'a pull request for branch "feature" into branch "main" already exists',
        }),
      ),
    ).toBe('a pull request for branch "feature" into branch "main" already exists');
    expect(forgeFailureText({ detail: "gh: API rate limit exceeded" })).toBe(
      "gh: API rate limit exceeded",
    );
    expect(forgeFailureText("Too Many Requests")).toBe("Too Many Requests");
  });

  it("drops the lines for steps that went through, which can hold a title", () => {
    expect(
      forgeFailureText(
        new VcsProcessExitError({
          operation: "GitHubCli.execute",
          command: "gh pr close 12 --delete-branch",
          cwd: "/repo",
          exitCode: 1,
          detail:
            "✓ Closed pull request o/r#12 (Fix API rate limit exceeded errors)\nfailed to delete remote branch feature: HTTP 422",
        }),
      ),
    ).toBe("failed to delete remote branch feature: HTTP 422");
    expect(forgeFailureText({ detail: "  ✓ Merged\ngh: API rate limit exceeded" })).toBe(
      "gh: API rate limit exceeded",
    );
  });

  it("drops gh's failure and warning lines, which can hold a title too", () => {
    expect(
      forgeFailureText(
        new VcsProcessExitError({
          operation: "GitHubCli.execute",
          command: "gh pr close 12",
          cwd: "/repo",
          exitCode: 1,
          detail:
            "X Pull request o/r#12 (Retry on too many requests) can't be closed because it was already merged",
        }),
      ),
    ).toBe("");
    expect(
      forgeFailureText({
        detail:
          "! Pull request o/r#12 (Back off on API rate limit) is already closed\nfailed to delete remote branch feature: HTTP 422",
      }),
    ).toBe("failed to delete remote branch feature: HTTP 422");
    // Only gh's icons: a line that merely starts with the letter keeps its text.
    expect(forgeFailureText({ detail: "X-RateLimit-Remaining: 0\nToo Many Requests" })).toBe(
      "X-RateLimit-Remaining: 0\nToo Many Requests",
    );
  });

  it("is empty for the exit line VcsProcess fills in and for errors without forge text", () => {
    expect(
      forgeFailureText(
        new VcsProcessExitError({
          operation: "GitHubCli.execute",
          command: "gh pr create --title Handle rate limit errors",
          cwd: "/repo",
          exitCode: 1,
          detail: "gh pr create --title Handle rate limit errors exited with code 1.",
        }),
      ),
    ).toBe("");
    expect(
      forgeFailureText(
        new VcsProcessTimeoutError({
          operation: "GitHubCli.execute",
          command: "gh pr list --search rate limit",
          cwd: "/repo",
          timeoutMs: 30_000,
        }),
      ),
    ).toBe("");
    expect(
      forgeFailureText(
        new VcsProcessSpawnError({
          operation: "GitHubCli.execute",
          command: "gh pr list",
          cwd: "/repo/rate limit demo",
          cause: new Error("spawn gh ENOENT"),
        }),
      ),
    ).toBe("");
    // Client errors carry Ryco's own text (and sometimes the command line).
    expect(forgeFailureText({ _tag: "GitHubCliError", detail: "rate limit" })).toBe("");
    expect(forgeFailureText(null)).toBe("");
    expect(forgeFailureText(429)).toBe("");
  });
});

describe("classifyForgeFailure", () => {
  const exit = (command: string, detail: string) =>
    new VcsProcessExitError({ operation: "test", command, cwd: "/repo", exitCode: 1, detail });

  it("reads kinds from the forge's text only", () => {
    const fromArgv = classifyForgeFailure(
      exit("glab mr list --source-branch fix/refresh-token-rate-limit-exceeded", "500 Oops"),
    );
    expect(fromArgv.rateLimited).toBe(false);
    expect(fromArgv.kindIf("unauthenticated", (text) => text.includes("token"))).toBeUndefined();
    expect(fromArgv.missingToolIf((text) => text.includes("command not found"))).toBeUndefined();

    const fromForge = classifyForgeFailure(exit("glab mr list", "401 Unauthorized: invalid token"));
    expect(fromForge.rateLimited).toBe(false);
    expect(fromForge.kindIf("unauthenticated", (text) => text.includes("token"))).toBe(
      "unauthenticated",
    );
    expect(classifyForgeFailure(exit("gh pr list", "gh: HTTP 429")).rateLimited).toBe(true);
  });
});

describe("with the real process runner", () => {
  const root = mkdtempSync(NodePath.join(NodeOS.tmpdir(), "ryco-forge-failure-"));
  // A project folder whose name reads like a rate limit.
  const cwd = NodePath.join(root, "rate limit demo");
  mkdirSync(cwd);
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  const layer = VcsProcess.layer.pipe(Layer.provideMerge(NodeServices.layer));

  it.effect("drops the exit line VcsProcess writes for a silent failure", () =>
    Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const error = yield* process
        .run({
          operation: "forgeFailure.test",
          command: globalThis.process.execPath,
          // Arguments after the script reach it as argv; they stand in for a PR title.
          args: ["-e", "process.exit(1)", "pr", "create", "--title", "Handle rate limit errors"],
          cwd,
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "VcsProcessExitError");
      // The old classifier read this message, command line included.
      expect(error.message.toLowerCase()).toContain("rate limit");
      expect(forgeFailureText(error)).toBe("");
      expect(isForgeRateLimitText(forgeFailureText(error))).toBe(false);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("tells a missing CLI from a missing working directory", () =>
    Effect.gen(function* () {
      const process = yield* VcsProcess.VcsProcess;
      const missingTool = yield* process
        .run({
          operation: "forgeFailure.test",
          command: "ryco-forge-cli-that-does-not-exist",
          args: ["pr", "list"],
          cwd: root,
        })
        .pipe(Effect.flip);
      assert.strictEqual(missingTool._tag, "VcsProcessSpawnError");
      expect(isMissingToolSpawnError(missingTool)).toBe(true);

      const missingCwd = yield* process
        .run({
          operation: "forgeFailure.test",
          command: globalThis.process.execPath,
          args: ["-e", "0"],
          cwd: NodePath.join(root, "gone"),
        })
        .pipe(Effect.flip);
      assert.strictEqual(missingCwd._tag, "VcsProcessSpawnError");
      expect(isMissingToolSpawnError(missingCwd)).toBe(false);
      expect(isMissingToolSpawnError({ _tag: "VcsProcessExitError" })).toBe(false);
    }).pipe(Effect.provide(layer)),
  );
});

describe("sourceControlProviderErrorFrom", () => {
  it("carries the kind as reason and a rate limit's retry time", () => {
    const error = sourceControlProviderErrorFrom("forgejo", "listChangeRequests", {
      detail: "Forgejo is rate limiting requests (HTTP 429).",
      failureKind: "rate-limited",
      retryAt: 1_000_000_030_000.4,
    });
    expect(error.provider).toBe("forgejo");
    expect(error.operation).toBe("listChangeRequests");
    expect(error.detail).toBe("Forgejo is rate limiting requests (HTTP 429).");
    expect(error.reason).toBe("rate-limited");
    // Rounded up: the contract takes whole epoch ms.
    expect(error.retryAt).toBe(1_000_000_030_001);
  });

  it("keeps a retry time only on a rate limit, and leaves unclassified errors as before", () => {
    const notFound = sourceControlProviderErrorFrom("bitbucket", "getChangeRequest", {
      detail: "Bitbucket returned HTTP 404.",
      failureKind: "not-found",
      retryAt: 1_000_000_030_000,
    });
    expect(notFound.reason).toBe("not-found");
    expect(notFound.retryAt).toBeUndefined();

    const plain = sourceControlProviderErrorFrom("github", "listChangeRequests", {
      detail: "GitHub CLI exited with code 1.",
    });
    expect(plain.reason).toBeUndefined();
    expect(plain.retryAt).toBeUndefined();
    expect(Object.hasOwn(plain, "reason")).toBe(false);

    const unusable = sourceControlProviderErrorFrom("gitlab", "listChangeRequests", {
      detail: "GitLab is rate limiting requests (HTTP 429).",
      failureKind: "rate-limited",
      retryAt: Number.NaN,
    });
    expect(unusable.reason).toBe("rate-limited");
    expect(unusable.retryAt).toBeUndefined();
  });
});
