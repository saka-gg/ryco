import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { SourceControlProviderError } from "@ryco/contracts";

import { inBackgroundProcessLane } from "../processGovernor.ts";
import {
  ForgeRateLimitStore,
  ForgeRateLimits,
  withForgeRateLimitGuards,
} from "./forgeRateLimit.ts";
import { makePullRequestIndex } from "./pullRequestIndex.ts";
import type {
  SourceControlProviderContext,
  SourceControlProviderShape,
} from "./SourceControlProvider.ts";
import { bindProviderContext } from "./SourceControlProviderRegistry.ts";

const T0 = 1_000_000_000_000;
const repository = "github\u0000https://github.com/acme/repo";
const context: SourceControlProviderContext = {
  provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
  remoteName: "origin",
  remoteUrl: "git@github.com:acme/repo.git",
};

/** A guarded GitHub provider (as the registry hands it out) whose list reads are counted. */
function countingProvider(
  calls: { count: number },
  answer: () => Effect.Effect<[], SourceControlProviderError> = () => Effect.succeed([]),
): SourceControlProviderShape {
  const loaded = {
    kind: "github",
    listChangeRequests: () =>
      Effect.suspend(() => {
        calls.count += 1;
        return answer();
      }),
  } as unknown as SourceControlProviderShape;
  return bindProviderContext(withForgeRateLimitGuards(loaded), context);
}

/** A store with a running 30 s pause for github.com. */
function pausedStore(): ForgeRateLimitStore {
  const store = new ForgeRateLimitStore();
  const key = { provider: "github" as const, host: "github.com", account: "" };
  store.recordRateLimit(store.lease(key), T0);
  return store;
}

describe("pull request index during a rate-limit pause", () => {
  it.effect("does not answer an interactive reader with a refused background read", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const index = yield* makePullRequestIndex;
      const calls = { count: 0 };
      const provider = countingProvider(calls);
      const input = { repository, scope: "all" as const, cwd: "/repo", provider };

      const refused = yield* index.read(input).pipe(inBackgroundProcessLane, Effect.flip);
      assert.strictEqual(refused.reason, "rate-limited");
      const branchRefused = yield* index
        .readBranch({ repository, headSelector: "feature", cwd: "/repo", provider })
        .pipe(inBackgroundProcessLane, Effect.flip);
      assert.strictEqual(branchRefused.reason, "rate-limited");
      assert.strictEqual(calls.count, 0);

      // Within the 10 s a failed listing is kept for, the focused thread reads live.
      yield* TestClock.adjust("2 seconds");
      const listing = yield* index.read(input);
      assert.deepStrictEqual(listing, { items: [], complete: true });
      yield* index.readBranch({ repository, headSelector: "feature", cwd: "/repo", provider });
      assert.strictEqual(calls.count, 2);
    }).pipe(Effect.provideService(ForgeRateLimits, pausedStore())),
  );

  it.effect("still keeps what the forge answered for a short while", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const index = yield* makePullRequestIndex;
      const calls = { count: 0 };
      const provider = countingProvider(calls, () =>
        Effect.fail(
          new SourceControlProviderError({
            provider: "github",
            operation: "listChangeRequests",
            detail: "GitHub API rate limit exceeded. Wait for the reset window and retry.",
            reason: "rate-limited",
          }),
        ),
      );
      const input = { repository, scope: "all" as const, cwd: "/repo", provider };

      yield* index.read(input).pipe(Effect.flip);
      yield* index.read(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 1);
      yield* TestClock.adjust("11 seconds");
      yield* index.read(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 2);
    }).pipe(Effect.provideService(ForgeRateLimits, new ForgeRateLimitStore())),
  );
});
