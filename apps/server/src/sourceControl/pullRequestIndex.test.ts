import { assert, describe, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { TestClock } from "effect/testing";
import { type ChangeRequest, SourceControlProviderError } from "@ryco/contracts";

import { inBackgroundProcessLane } from "../processGovernor.ts";
import {
  ForgeRateLimitStore,
  ForgeRateLimits,
  withForgeRateLimitGuards,
} from "./forgeRateLimit.ts";
import { pausedUntilOf } from "./lastGoodWhilePaused.ts";
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

const changeRequest = (number: number): ChangeRequest => ({
  provider: "github",
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/repo/pull/${number}`,
  baseRefName: "main",
  headRefName: "feature",
  state: "open",
  updatedAt: Option.none(),
});

const rateLimited = (retryAt?: number) =>
  new SourceControlProviderError({
    provider: "github",
    operation: "listChangeRequests",
    detail: "GitHub API rate limit exceeded. Wait for the reset window and retry.",
    reason: "rate-limited",
    ...(retryAt !== undefined ? { retryAt } : {}),
  });

/** A guarded GitHub provider (as the registry hands it out) whose list reads are counted. */
function countingProvider(
  calls: { count: number },
  answer: () => Effect.Effect<ReadonlyArray<ChangeRequest>, SourceControlProviderError> = () =>
    Effect.succeed([]),
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

/**
 * A forge that answers `[#1]` until `limit` is set, then "rate limited" (until `limit.retryAt`
 * when given), and again once `limit` is cleared.
 */
function limitingForge() {
  const calls = { count: 0 };
  const forge: { limit: { readonly retryAt?: number } | null } = { limit: null };
  const provider = countingProvider(calls, () =>
    forge.limit === null
      ? Effect.succeed([changeRequest(1)])
      : Effect.fail(rateLimited(forge.limit.retryAt)),
  );
  return { calls, forge, provider };
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

  it.effect("holds what the forge answered until its pause ends", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const index = yield* makePullRequestIndex;
      const calls = { count: 0 };
      const provider = countingProvider(calls, () => Effect.fail(rateLimited()));
      const input = { repository, scope: "all" as const, cwd: "/repo", provider };

      // No time named: the guessed pause (30 s) is the hold.
      const error = yield* index.read(input).pipe(Effect.flip);
      assert.strictEqual(error.retryAt, T0 + 30_000);
      yield* index.read(input).pipe(Effect.flip);
      yield* TestClock.adjust("11 seconds");
      yield* index.read(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 1);
      yield* TestClock.adjust("20 seconds");
      yield* index.read(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 2);
    }).pipe(Effect.provideService(ForgeRateLimits, new ForgeRateLimitStore())),
  );

  it.effect("serves the last good listing to background readers only", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const index = yield* makePullRequestIndex;
      const { calls, forge, provider } = limitingForge();
      const input = { repository, scope: "all" as const, cwd: "/repo", provider };

      const fresh = yield* index.read(input);
      assert.strictEqual(pausedUntilOf(fresh), null);
      forge.limit = {};
      yield* TestClock.adjust("61 seconds");

      // The focused thread gets the typed error, so it can say the forge is paused.
      const error = yield* index.read(input).pipe(Effect.flip);
      const retryAt = T0 + 61_000 + 30_000;
      assert.strictEqual(error.retryAt, retryAt);
      // Sidebar badges and sweeps keep the last listing, marked as served while paused.
      const served = yield* index.read(input).pipe(inBackgroundProcessLane);
      assert.deepStrictEqual(served.items, fresh.items);
      assert.strictEqual(pausedUntilOf(served), retryAt);
      assert.strictEqual(pausedUntilOf(served.items), retryAt);
      // It is never a known state for link writes.
      assert.deepStrictEqual(yield* index.peek(repository), []);
      assert.strictEqual(calls.count, 2);

      // After the pause the forge is asked again, and a fresh listing is unmarked.
      forge.limit = null;
      yield* TestClock.adjust("31 seconds");
      const again = yield* index.read(input).pipe(inBackgroundProcessLane);
      assert.strictEqual(pausedUntilOf(again), null);
      assert.strictEqual(calls.count, 3);
      assert.strictEqual((yield* index.peek(repository)).length, 1);
    }).pipe(Effect.provideService(ForgeRateLimits, new ForgeRateLimitStore())),
  );

  it.effect("serves nothing older than an hour, and nothing for other failures", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const index = yield* makePullRequestIndex;
      let answer: Effect.Effect<
        ReadonlyArray<ChangeRequest>,
        SourceControlProviderError
      > = Effect.succeed([changeRequest(1)]);
      const calls = { count: 0 };
      const provider = countingProvider(calls, () => answer);
      const input = { repository, scope: "open" as const, cwd: "/repo", provider };

      yield* index.read(input);
      answer = Effect.fail(
        new SourceControlProviderError({
          provider: "github",
          operation: "listChangeRequests",
          detail: "host unreachable",
        }),
      );
      yield* TestClock.adjust("61 seconds");
      const offline = yield* index.read(input).pipe(inBackgroundProcessLane, Effect.flip);
      assert.strictEqual(offline.detail, "host unreachable");

      answer = Effect.fail(rateLimited());
      yield* TestClock.adjust("60 minutes");
      const tooOld = yield* index.read(input).pipe(inBackgroundProcessLane, Effect.flip);
      assert.strictEqual(tooOld.reason, "rate-limited");
    }).pipe(Effect.provideService(ForgeRateLimits, new ForgeRateLimitStore())),
  );

  it.effect("keeps a held answer through invalidations while the pause runs", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const index = yield* makePullRequestIndex;
      const { calls, forge, provider } = limitingForge();
      const input = { repository, scope: "all" as const, cwd: "/repo", provider };
      let pauseChecks = 0;
      const stillPaused = (paused: boolean) =>
        Effect.sync(() => {
          pauseChecks += 1;
          return paused;
        });

      yield* index.read(input);
      // Nothing held: an invalidation drops as before and does not ask about a pause.
      yield* index.invalidate(repository, { keepHeldWhile: stillPaused(true) });
      assert.strictEqual(pauseChecks, 0);

      // The forge names a reset five minutes out.
      forge.limit = { retryAt: T0 + 5 * 60_000 };
      yield* index.read(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 2);

      // The periodic remote refresh invalidates before every read: while the
      // pause runs, the held answer survives it and the forge is not asked.
      for (let poll = 0; poll < 9; poll += 1) {
        yield* TestClock.adjust("30 seconds");
        yield* index.invalidate(repository, { keepHeldWhile: stillPaused(true) });
        const error = yield* index.read(input).pipe(Effect.flip);
        assert.strictEqual(error.retryAt, T0 + 5 * 60_000);
        const served = yield* index.read(input).pipe(inBackgroundProcessLane);
        assert.strictEqual(served.items[0]?.number, 1);
      }
      assert.strictEqual(calls.count, 2);
      assert.strictEqual(pauseChecks, 9);

      // A request of the user's ended the pause: the next invalidation drops the hold.
      yield* index.invalidate(repository, { keepHeldWhile: stillPaused(false) });
      yield* index.read(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 3);
      // Without a pause check an invalidation drops it too.
      yield* index.invalidate(repository);
      yield* index.read(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 4);
    }).pipe(Effect.provideService(ForgeRateLimits, new ForgeRateLimitStore())),
  );

  it.effect("keeps a branch's last good answer and hold across invalidations", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const index = yield* makePullRequestIndex;
      const { calls, forge, provider } = limitingForge();
      const input = { repository, headSelector: "feature", cwd: "/repo", provider };

      yield* index.readBranch(input);
      // The generation bump drops the cached answer, not the last good one.
      yield* index.invalidate(repository);
      forge.limit = { retryAt: T0 + 120_000 };
      yield* index.readBranch(input).pipe(Effect.flip);
      const served = yield* index.readBranch(input).pipe(inBackgroundProcessLane);
      assert.deepStrictEqual(
        served.map((item) => item.number),
        [1],
      );
      assert.strictEqual(pausedUntilOf(served), T0 + 120_000);

      yield* index.invalidate(repository, { keepHeldWhile: Effect.succeed(true) });
      yield* index.readBranch(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 2);
      yield* index.invalidate(repository, { keepHeldWhile: Effect.succeed(false) });
      yield* index.readBranch(input).pipe(Effect.flip);
      assert.strictEqual(calls.count, 3);
    }).pipe(Effect.provideService(ForgeRateLimits, new ForgeRateLimitStore())),
  );
});
