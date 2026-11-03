import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import { TestClock } from "effect/testing";
import { SourceControlProviderError, VcsProcessSpawnError } from "@ryco/contracts";

import { inBackgroundProcessLane } from "../processGovernor.ts";
import {
  FORGE_RATE_LIMIT_CAPACITY,
  ForgeRateLimitScope,
  ForgeRateLimitStore,
  ForgeRateLimits,
  ForgeRequestPausedError,
  forgeChildAdmission,
  forgeRateLimitKeyFor,
  forgeRequestPausedRefusal,
  guardForgeCall,
  pausedUntilFor,
  withForgeRateLimitGuards,
  type ForgeRateLimitKey,
} from "./forgeRateLimit.ts";
import { isForgeRequestRefusedWhilePaused } from "./forgeRequestPaused.ts";
import type {
  SourceControlProviderContext,
  SourceControlProviderShape,
} from "./SourceControlProvider.ts";

const T0 = 1_000_000_000_000;
const github: ForgeRateLimitKey = { provider: "github", host: "github.com", account: "" };

/** A store that has seen one rate limit for `key` at `nowMs`. */
function limitOnce(
  store: ForgeRateLimitStore,
  key: ForgeRateLimitKey,
  nowMs: number,
  retryAt?: number,
) {
  return store.recordRateLimit(store.lease(key), nowMs, retryAt);
}

describe("ForgeRateLimitStore", () => {
  it("pauses 30 s, 60 s, 120 s ... per consecutive episode, capped at 15 min", () => {
    const store = new ForgeRateLimitStore();
    let now = T0;
    const pauses: number[] = [];
    for (let episode = 0; episode < 7; episode += 1) {
      const { started, pause } = limitOnce(store, github, now);
      assert.isTrue(started);
      pauses.push((pause!.retryAt - now) / 1_000);
      now = pause!.retryAt; // the pause ran out without a success
    }
    assert.deepStrictEqual(pauses, [30, 60, 120, 240, 480, 900, 900]);
  });

  it("uses the time the forge named, clamped to an hour", () => {
    const store = new ForgeRateLimitStore();
    const named = limitOnce(store, github, T0, T0 + 120_000).pause!;
    assert.strictEqual(named.retryAt, T0 + 120_000);
    assert.isTrue(named.explicit);

    const later = new ForgeRateLimitStore();
    assert.strictEqual(
      limitOnce(later, github, T0, T0 + 5 * 60 * 60_000).pause!.retryAt,
      T0 + 60 * 60_000,
    );
    // A past time is no time: the guessed pause.
    const past = new ForgeRateLimitStore();
    assert.strictEqual(limitOnce(past, github, T0, T0 - 1).pause!.retryAt, T0 + 30_000);
  });

  it("never escalates on a request sent before the pause, but adopts a later named time", () => {
    const store = new ForgeRateLimitStore();
    const early = store.lease(github);
    limitOnce(store, github, T0);
    assert.deepStrictEqual(store.recordRateLimit(early, T0 + 1_000), {
      started: false,
      pause: null,
    });
    assert.strictEqual(store.pause(github, T0 + 1_000)?.retryAt, T0 + 30_000);
    assert.strictEqual(store.pause(github, T0 + 1_000)?.attempt, 1);

    // Its answer arrives after the pause ended: still about the old episode.
    assert.isFalse(store.recordRateLimit(early, T0 + 40_000).started);
    assert.isNull(store.pause(github, T0 + 40_000));

    const extended = store.recordRateLimit(early, T0 + 1_000, T0 + 300_000);
    assert.isFalse(extended.started);
    assert.strictEqual(extended.pause?.retryAt, T0 + 300_000);
    assert.isTrue(extended.pause?.explicit);
  });

  it("never escalates on a failure sent during a running pause", () => {
    const store = new ForgeRateLimitStore();
    limitOnce(store, github, T0);
    // An interactive request during the pause holds the current generation.
    const during = store.lease(github);
    assert.isFalse(store.recordRateLimit(during, T0 + 10_000).started);
    assert.strictEqual(store.pause(github, T0 + 10_000)?.retryAt, T0 + 30_000);
    assert.strictEqual(
      store.recordRateLimit(during, T0 + 10_000, T0 + 90_000).pause?.retryAt,
      T0 + 90_000,
    );
    assert.strictEqual(store.pause(github, T0 + 10_000)?.attempt, 1);
  });

  it("ends a guessed pause on a success, keeps a named one, and ignores stale successes", () => {
    const guessed = new ForgeRateLimitStore();
    const stale = guessed.lease(github);
    limitOnce(guessed, github, T0);
    guessed.recordSuccess(stale, T0 + 1_000);
    assert.isNotNull(guessed.pause(github, T0 + 1_000));
    guessed.recordSuccess(guessed.lease(github), T0 + 1_000);
    assert.isNull(guessed.pause(github, T0 + 1_000));
    // The next episode starts from the bottom again.
    assert.strictEqual(limitOnce(guessed, github, T0 + 2_000).pause!.retryAt, T0 + 32_000);

    const named = new ForgeRateLimitStore();
    limitOnce(named, github, T0, T0 + 120_000);
    named.recordSuccess(named.lease(github), T0 + 1_000);
    assert.strictEqual(named.pause(github, T0 + 1_000)?.retryAt, T0 + 120_000);
  });

  it("refuses only the background lane", () => {
    const store = new ForgeRateLimitStore();
    limitOnce(store, github, T0);
    assert.strictEqual(store.pausedUntil(github, T0 + 1, "background"), T0 + 30_000);
    assert.isNull(store.pausedUntil(github, T0 + 1, "interactive"));
    assert.isNull(store.pausedUntil(github, T0 + 30_000, "background"));
  });

  it("keeps keys apart by provider, host and account", () => {
    const store = new ForgeRateLimitStore();
    limitOnce(store, github, T0);
    for (const other of [
      { ...github, provider: "gitlab" as const },
      { ...github, host: "ghe.corp.example" },
      { ...github, account: "a1b2c3d4e5f6" },
    ]) {
      assert.isNull(store.pausedUntil(other, T0 + 1, "background"));
    }
    assert.deepStrictEqual(
      store.activePauses(T0 + 1).map((pause) => pause.key),
      [github],
    );
  });

  it("evicts the oldest idle keys over capacity, never a paused one", () => {
    const store = new ForgeRateLimitStore({ capacity: 3 });
    const key = (host: string): ForgeRateLimitKey => ({ ...github, host });
    limitOnce(store, key("paused"), T0, T0 + 60 * 60_000);
    limitOnce(store, key("idle"), T0);
    const later = T0 + 40_000; // "idle"'s 30 s pause is over
    limitOnce(store, key("c"), later);
    limitOnce(store, key("d"), later);
    assert.strictEqual(store.pausedUntil(key("paused"), later, "background"), T0 + 60 * 60_000);
    assert.strictEqual(store.lease(key("idle")).generation, 0, "evicted");
    assert.isNotNull(store.pause(key("c"), later));
    assert.isNotNull(store.pause(key("d"), later));
    assert.strictEqual(FORGE_RATE_LIMIT_CAPACITY, 256);
  });
});

describe("forgeRateLimitKeyFor", () => {
  const context = (baseUrl: string, remoteUrl: string): SourceControlProviderContext => ({
    provider: { kind: "github", name: "GitHub Self-Hosted", baseUrl },
    remoteName: "origin",
    remoteUrl,
  });

  it("keys by lower-cased hostname, so SSH and HTTPS remotes of a host share a pause", () => {
    const https = forgeRateLimitKeyFor(
      context("https://GHE.corp.example", "https://ghe.corp.example/o/r.git"),
    );
    const ssh = forgeRateLimitKeyFor(
      context("https://ghe.corp.example:2222", "ssh://git@ghe.corp.example:2222/o/r.git"),
    );
    assert.deepStrictEqual(https, { provider: "github", host: "ghe.corp.example", account: "" });
    assert.deepStrictEqual(ssh, https);
    // No usable base URL: the remote decides (scp-like too).
    assert.deepStrictEqual(forgeRateLimitKeyFor(context("", "git@GitHub.com:o/r.git")), github);
  });

  it("keys calls without a repository by an explicit host", () => {
    assert.deepStrictEqual(
      forgeRateLimitKeyFor({ provider: "github", host: "github.com" }),
      github,
    );
    assert.deepStrictEqual(
      forgeRateLimitKeyFor({ provider: "gitlab", host: "gitlab.example:8443" }),
      { provider: "gitlab", host: "gitlab.example", account: "" },
    );
    assert.isNull(forgeRateLimitKeyFor({ provider: "unknown", host: "example.com" }));
    assert.isNull(forgeRateLimitKeyFor({ provider: "github", host: " " }));
  });
});

const withStore = (store: ForgeRateLimitStore) => Effect.provideService(ForgeRateLimits, store);

function rateLimited(retryAt?: number): SourceControlProviderError {
  return new SourceControlProviderError({
    provider: "github",
    operation: "listChangeRequests",
    detail: "GitHub API rate limit exceeded. Wait for the reset window and retry.",
    reason: "rate-limited",
    ...(retryAt !== undefined ? { retryAt } : {}),
  });
}

describe("guardForgeCall", () => {
  it.effect("refuses a background call during a pause without running it", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      limitOnce(store, github, T0);
      let runs = 0;
      const error = yield* guardForgeCall(github, "listChangeRequests", () =>
        Effect.sync(() => {
          runs += 1;
        }),
      ).pipe(inBackgroundProcessLane, withStore(store), Effect.flip);
      assert.strictEqual(runs, 0);
      assert.strictEqual(error.reason, "rate-limited");
      assert.strictEqual(error.retryAt, T0 + 30_000);
      assert.strictEqual(error.operation, "listChangeRequests");
      assert.strictEqual(error.detail, "GitHub requests are paused after a rate limit.");
      assert.isTrue(isForgeRequestRefusedWhilePaused(error));
      // A refusal never touches the pause.
      assert.strictEqual(store.pause(github, T0)?.attempt, 1);
    }),
  );

  it.effect("lets an interactive call through a pause", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      limitOnce(store, github, T0, T0 + 120_000);
      const result = yield* guardForgeCall(github, "createChangeRequest", () =>
        Effect.succeed("created"),
      ).pipe(withStore(store));
      assert.strictEqual(result, "created");
    }),
  );

  it.effect(
    "pauses after a rate limit and hands back the pause's end when the forge named none",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(T0);
        const store = new ForgeRateLimitStore();
        const error = yield* guardForgeCall(github, "listChangeRequests", () =>
          Effect.fail(rateLimited()),
        ).pipe(withStore(store), Effect.flip);
        assert.strictEqual(error.retryAt, T0 + 30_000);
        assert.strictEqual(error.reason, "rate-limited");
        assert.strictEqual(error.detail, rateLimited().detail);
        assert.strictEqual(store.pausedUntil(github, T0, "background"), T0 + 30_000);
      }),
  );

  it.effect("keeps the time the forge named", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      const error = yield* guardForgeCall(github, "listChangeRequests", () =>
        Effect.fail(rateLimited(T0 + 300_000)),
      ).pipe(withStore(store), Effect.flip);
      assert.strictEqual(error.retryAt, T0 + 300_000);
      assert.isTrue(store.pause(github, T0)?.explicit);
      // A success does not end a pause the forge timed.
      yield* guardForgeCall(github, "getChangeRequest", () => Effect.void).pipe(withStore(store));
      assert.strictEqual(store.pausedUntil(github, T0, "background"), T0 + 300_000);
    }),
  );

  it.effect("times a slow call's rate limit when it ends, not when it started", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      const error = yield* guardForgeCall(github, "listChangeRequests", () =>
        TestClock.adjust("40 seconds").pipe(Effect.andThen(Effect.fail(rateLimited()))),
      ).pipe(withStore(store), Effect.flip);
      const ended = T0 + 40_000;
      assert.strictEqual(store.pausedUntil(github, ended, "background"), ended + 30_000);
      assert.strictEqual(error.retryAt, ended + 30_000);
    }),
  );

  it.effect("ends a guessed pause when an interactive call goes through", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      limitOnce(store, github, T0);
      yield* guardForgeCall(github, "getChangeRequest", () => Effect.void).pipe(withStore(store));
      assert.isNull(store.pausedUntil(github, T0, "background"));
    }),
  );

  it.effect("records nothing for a child refused after its permit, or for other failures", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      const refused = new SourceControlProviderError({
        provider: "github",
        operation: "listChangeRequests",
        detail: "GitHub requests are paused after a rate limit.",
        reason: "rate-limited",
        retryAt: T0 + 5_000,
        cause: { detail: "wrapped", cause: refusal(T0 + 5_000) },
      });
      yield* guardForgeCall(github, "listChangeRequests", () => Effect.fail(refused)).pipe(
        withStore(store),
        Effect.flip,
      );
      yield* guardForgeCall(github, "listChangeRequests", () =>
        Effect.fail(
          new SourceControlProviderError({
            provider: "github",
            operation: "listChangeRequests",
            detail: "Pull request not found.",
            reason: "not-found",
          }),
        ),
      ).pipe(withStore(store), Effect.flip);
      assert.deepStrictEqual(store.activePauses(T0), []);
    }),
  );

  it.effect("tells the call's forge children which key they serve", () =>
    Effect.gen(function* () {
      const seen = yield* guardForgeCall(github, "listChangeRequests", () => ForgeRateLimitScope);
      assert.deepStrictEqual(seen, github);
      assert.isNull(yield* ForgeRateLimitScope);
    }).pipe(withStore(new ForgeRateLimitStore())),
  );
});

function refusal(retryAt: number) {
  return new ForgeRequestPausedError({ provider: "github", host: "github.com", retryAt });
}

describe("forgeChildAdmission", () => {
  it.effect("refuses a paused background child of a guarded call, and nothing else", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      limitOnce(store, github, T0);
      const scoped = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(Effect.provideService(ForgeRateLimitScope, github), withStore(store));

      const refused = yield* forgeChildAdmission.pipe(inBackgroundProcessLane, scoped, Effect.flip);
      assert.deepStrictEqual(
        { provider: refused.provider, host: refused.host, retryAt: refused.retryAt },
        { provider: "github", host: "github.com", retryAt: T0 + 30_000 },
      );
      assert.isTrue(Exit.isSuccess(yield* forgeChildAdmission.pipe(scoped, Effect.exit)));
      // A child outside any guarded call (discovery probes, git) always runs.
      assert.isTrue(
        Exit.isSuccess(
          yield* forgeChildAdmission.pipe(inBackgroundProcessLane, withStore(store), Effect.exit),
        ),
      );
    }),
  );

  it("is found behind the spawn error VcsProcess reports it as", () => {
    const paused = refusal(T0);
    const spawn = new VcsProcessSpawnError({
      operation: "GitHubCli.execute",
      command: "gh pr list",
      cwd: "/repo",
      cause: paused,
    });
    assert.strictEqual(forgeRequestPausedRefusal(spawn), paused);
    assert.strictEqual(forgeRequestPausedRefusal(paused), paused);
    // The same walk the boot-path caches use, so a client error wrapping it counts too.
    assert.strictEqual(forgeRequestPausedRefusal({ _tag: "GitHubCliError", cause: spawn }), paused);
    assert.isTrue(isForgeRequestRefusedWhilePaused({ _tag: "GitHubCliError", cause: spawn }));
    assert.isNull(
      forgeRequestPausedRefusal(
        new VcsProcessSpawnError({ operation: "x", command: "gh", cwd: "/", cause: new Error() }),
      ),
    );
  });
});

describe("pausedUntilFor", () => {
  it.effect("answers for the caller's lane", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      limitOnce(store, github, T0);
      const target = { provider: "github" as const, host: "GitHub.com" };
      assert.strictEqual(
        yield* pausedUntilFor(target).pipe(inBackgroundProcessLane, withStore(store)),
        T0 + 30_000,
      );
      assert.isNull(yield* pausedUntilFor(target).pipe(withStore(store)));
      assert.isNull(
        yield* pausedUntilFor({ provider: "github", host: "ghe.corp.example" }).pipe(
          inBackgroundProcessLane,
          withStore(store),
        ),
      );
    }),
  );
});

describe("withForgeRateLimitGuards", () => {
  const context: SourceControlProviderContext = {
    provider: { kind: "github", name: "GitHub", baseUrl: "https://github.com" },
    remoteName: "origin",
    remoteUrl: "git@github.com:acme/repo.git",
  };

  function countingProvider(calls: string[]): SourceControlProviderShape {
    const record = (operation: string) => (input: unknown) =>
      Effect.sync(() => {
        calls.push(operation);
        return input;
      });
    return {
      kind: "github",
      listChangeRequests: record("listChangeRequests"),
      searchChangeRequests: record("searchChangeRequests"),
      createRepository: record("createRepository"),
    } as unknown as SourceControlProviderShape;
  }

  it.effect("guards calls by their context or explicit host, and leaves the rest alone", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(T0);
      const store = new ForgeRateLimitStore();
      limitOnce(store, github, T0);
      const calls: string[] = [];
      const provider = withForgeRateLimitGuards(countingProvider(calls));
      assert.strictEqual(provider.kind, "github");
      const background = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(inBackgroundProcessLane, withStore(store), Effect.exit);

      const byContext = yield* background(
        provider.listChangeRequests({ cwd: "/repo", context, headSelector: "", state: "open" }),
      );
      const byHost = yield* background(
        provider.searchChangeRequests({
          cwd: "/repo",
          query: "review-requested:@me",
          host: "github.com",
        } as never),
      );
      const otherHost = yield* background(
        provider.searchChangeRequests({
          cwd: "/repo",
          query: "is:open",
          host: "ghe.corp.example",
        } as never),
      );
      const noTarget = yield* background(
        provider.createRepository({ cwd: "/repo", repository: "acme/new", visibility: "private" }),
      );

      assert.isTrue(Exit.isFailure(byContext));
      assert.isTrue(Exit.isFailure(byHost));
      assert.isTrue(Exit.isSuccess(otherHost));
      assert.isTrue(Exit.isSuccess(noTarget));
      assert.deepStrictEqual(calls, ["searchChangeRequests", "createRepository"]);
      assert.strictEqual(
        Option.getOrUndefined(Exit.findErrorOption(byHost))?.operation,
        "searchChangeRequests",
      );
    }),
  );
});
