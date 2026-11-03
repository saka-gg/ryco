import { assert, describe, it } from "@effect/vitest";
import type { ServerProviderRateLimits } from "@ryco/contracts";
import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";

import {
  credentialUsageReadPlan,
  makeUsageReadGate,
  parseCredentialExpiresAtMs,
  parseRetryAfterMs,
  requestUsage,
  usageAccountKey,
  usageOutcomeForStatus,
  type UsageReadOutcome,
} from "./usageReadGate.ts";

const START_MS = Date.parse("2026-10-28T12:00:00.000Z");
const START = new Date(START_MS).toISOString();
const minutes = (count: number) => count * 60_000;
const epochSeconds = (ms: number) => Math.floor(ms / 1000);

const FIVE_HOUR = {
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: epochSeconds(START_MS + minutes(20)),
};
const WEEKLY = {
  usedPercent: 70,
  windowDurationMins: 10_080,
  resetsAt: epochSeconds(START_MS + minutes(3 * 24 * 60)),
};
const OPUS_WEEKLY = {
  id: "seven_day_opus",
  scope: "Opus",
  usedPercent: 90,
  windowDurationMins: 10_080,
  resetsAt: epochSeconds(START_MS + minutes(40)),
};
const USAGE: ServerProviderRateLimits = {
  limitId: "claude-oauth",
  primary: FIVE_HOUR,
  secondary: WEEKLY,
  windows: [{ id: "five_hour", ...FIVE_HOUR }, { id: "seven_day", ...WEEKLY }, OPUS_WEEKLY],
};

const read = (rateLimits: ServerProviderRateLimits = USAGE): UsageReadOutcome => ({
  _tag: "Read",
  rateLimits,
});
const throttled = (retryAfterMs?: number): UsageReadOutcome => ({
  _tag: "Throttled",
  retryAfterMs,
});
const FAILED: UsageReadOutcome = { _tag: "Failed" };
const CLEARED: UsageReadOutcome = { _tag: "Cleared" };

/** A fake usage API: answers with the queued outcomes in turn and counts its calls. */
function fakeUsageApi() {
  const queued: UsageReadOutcome[] = [];
  const api = {
    calls: 0,
    answer: (...outcomes: ReadonlyArray<UsageReadOutcome>) => {
      queued.push(...outcomes);
    },
    plan: (accountKey = "account-a") =>
      Effect.succeed({
        accountKey,
        fetch: Effect.sync(() => {
          api.calls += 1;
          const outcome = queued.shift();
          if (!outcome) throw new Error("Unexpected usage request.");
          return outcome;
        }),
      }),
  };
  return api;
}

/** A gate and a fake usage API; `setup` also starts the clock at `START_MS`. */
const fixture = Effect.gen(function* () {
  return { gate: yield* makeUsageReadGate(), api: fakeUsageApi() };
});
const setup = TestClock.setTime(START_MS).pipe(Effect.andThen(fixture));

describe("makeUsageReadGate", () => {
  it.effect("stamps a read with its read time and drops any stale marker", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(
        read({ ...USAGE, observedAt: "2020-01-01T00:00:00.000Z", stale: true, staleReason: "x" }),
      );

      assert.deepEqual(yield* gate.read(api.plan()), { ...USAGE, observedAt: START });
    }),
  );

  it.effect("re-serves the last good read during a Retry-After cooldown, then reads again", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(read());
      yield* gate.read(api.plan());
      yield* TestClock.adjust(Duration.minutes(1));

      api.answer(usageOutcomeForStatus(429, "120", START_MS + minutes(1)));
      const stale = { ...USAGE, observedAt: START, stale: true, staleReason: "rateLimited" };
      assert.deepEqual(yield* gate.read(api.plan()), stale);
      assert.equal(api.calls, 2);

      yield* TestClock.adjust(Duration.seconds(119));
      assert.deepEqual(yield* gate.read(api.plan()), stale);
      assert.equal(api.calls, 2);

      yield* TestClock.adjust(Duration.seconds(1));
      api.answer(read({ ...USAGE, primary: { ...FIVE_HOUR, usedPercent: 45 } }));
      const fresh = yield* gate.read(api.plan());
      assert.equal(api.calls, 3);
      assert.equal(fresh?.primary?.usedPercent, 45);
      assert.equal(fresh?.observedAt, new Date(START_MS + minutes(3)).toISOString());
      assert.equal(fresh?.stale, undefined);
    }),
  );

  it.effect("backs off 5 minutes by default, at least 1 minute and at most 15 minutes", () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [number | undefined, number]> = [
        [undefined, minutes(5)],
        [0, minutes(5)],
        [1_000, minutes(1)],
        [minutes(7), minutes(7)],
        [24 * minutes(60), minutes(15)],
      ];
      yield* TestClock.setTime(START_MS);
      for (const [retryAfterMs, cooldownMs] of cases) {
        const { gate, api } = yield* fixture;
        api.answer(throttled(retryAfterMs));
        assert.equal(yield* gate.read(api.plan()), undefined);

        yield* TestClock.adjust(Duration.millis(cooldownMs - 1));
        yield* gate.read(api.plan());
        assert.equal(api.calls, 1, `no request during a ${cooldownMs} ms cooldown`);

        yield* TestClock.adjust(Duration.millis(1));
        api.answer(read());
        yield* gate.read(api.plan());
        assert.equal(api.calls, 2, `a request after a ${cooldownMs} ms cooldown`);
      }
    }),
  );

  it.effect("re-serves a failed read for a minute, marked unreachable", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(read(), FAILED);
      yield* gate.read(api.plan());

      const stale = yield* gate.read(api.plan());
      assert.equal(stale?.stale, true);
      assert.equal(stale?.staleReason, "unreachable");
      assert.equal(stale?.observedAt, START);

      yield* TestClock.adjust(Duration.seconds(59));
      yield* gate.read(api.plan());
      assert.equal(api.calls, 2);
      yield* TestClock.adjust(Duration.seconds(1));
      api.answer(read());
      yield* gate.read(api.plan());
      assert.equal(api.calls, 3);
    }),
  );

  it.effect("reads another account at once, even during a cooldown, and never re-serves", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(read(), throttled(minutes(10)));
      yield* gate.read(api.plan("account-a"));
      assert.equal((yield* gate.read(api.plan("account-a")))?.stale, true);

      api.answer(throttled());
      assert.equal(yield* gate.read(api.plan("account-b")), undefined);
      assert.equal(api.calls, 3);
      // Back on the first account, nothing of its earlier state is left either.
      api.answer(throttled());
      assert.equal(yield* gate.read(api.plan("account-a")), undefined);
      assert.equal(api.calls, 4);
    }),
  );

  it.effect("forgets the last good read when a read clears or the login is gone", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(read(), CLEARED, throttled());
      yield* gate.read(api.plan());
      assert.equal(yield* gate.read(api.plan()), undefined);
      assert.equal(yield* gate.read(api.plan()), undefined);

      const next = yield* fixture;
      next.api.answer(read(), throttled(), read());
      yield* next.gate.read(next.api.plan());
      assert.equal((yield* next.gate.read(next.api.plan()))?.stale, true);
      assert.equal(yield* next.gate.read(Effect.succeed(undefined)), undefined);
      // The cooldown went with it: a login that comes back reads at once.
      assert.equal((yield* next.gate.read(next.api.plan()))?.stale, undefined);
      assert.equal(next.api.calls, 3);
    }),
  );

  it.effect("leaves windows past their reset out of a re-served read", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(read());
      yield* gate.read(api.plan());

      yield* TestClock.adjust(Duration.minutes(25));
      api.answer(FAILED);
      const afterFiveHourReset = yield* gate.read(api.plan());
      assert.equal(afterFiveHourReset?.primary, undefined);
      assert.deepEqual(afterFiveHourReset?.secondary, WEEKLY);
      assert.deepEqual(
        afterFiveHourReset?.windows?.map((window) => window.id),
        ["seven_day", "seven_day_opus"],
      );

      yield* TestClock.adjust(Duration.minutes(20));
      api.answer(FAILED);
      const afterOpusReset = yield* gate.read(api.plan());
      assert.deepEqual(
        afterOpusReset?.windows?.map((window) => window.id),
        ["seven_day"],
      );
    }),
  );

  it.effect("re-serves nothing once every window has reset", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(read({ limitId: "opencode-go", primary: FIVE_HOUR }));
      yield* gate.read(api.plan());

      yield* TestClock.adjust(Duration.minutes(20));
      api.answer(FAILED);
      assert.equal(yield* gate.read(api.plan()), undefined);
    }),
  );

  it.effect("re-serves nothing older than the stale age limit", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(read({ limitId: "claude-oauth", secondary: WEEKLY }));
      yield* gate.read(api.plan());

      yield* TestClock.adjust(Duration.minutes(60));
      api.answer(FAILED);
      assert.equal((yield* gate.read(api.plan()))?.observedAt, START);

      yield* TestClock.adjust(Duration.seconds(1));
      assert.equal(yield* gate.read(api.plan()), undefined);
    }),
  );

  it.effect("sends one request for concurrent reads that meet a throttle", () =>
    Effect.gen(function* () {
      const { gate, api } = yield* setup;
      api.answer(throttled());
      yield* Effect.all([gate.read(api.plan()), gate.read(api.plan())], { concurrency: 2 });
      assert.equal(api.calls, 1);
    }),
  );
});

describe("usageOutcomeForStatus", () => {
  it("throttles on 429, clears on refusals and fails on timeouts and server errors", () => {
    assert.deepEqual(usageOutcomeForStatus(429, "120", START_MS), throttled(120_000));
    assert.deepEqual(usageOutcomeForStatus(429, null, START_MS), throttled(undefined));
    for (const status of [401, 403, 404]) {
      assert.deepEqual(usageOutcomeForStatus(status, null, START_MS), CLEARED);
    }
    for (const status of [408, 500, 502, 503]) {
      assert.deepEqual(usageOutcomeForStatus(status, "120", START_MS), FAILED);
    }
  });
});

describe("parseRetryAfterMs", () => {
  it("reads delta seconds and HTTP dates", () => {
    assert.equal(parseRetryAfterMs("120", START_MS), 120_000);
    assert.equal(parseRetryAfterMs(" 120 ", START_MS), 120_000);
    assert.equal(
      parseRetryAfterMs(new Date(START_MS + minutes(2)).toUTCString(), START_MS),
      minutes(2),
    );
  });

  it("has no delay for absent, zero, past, unsafe or non-HTTP values", () => {
    for (const value of [null, "", "0", "1.5", "+10", "-10", "1e3", "0x10", "soon"]) {
      assert.equal(parseRetryAfterMs(value, START_MS), undefined, String(value));
    }
    assert.equal(parseRetryAfterMs(new Date(START_MS - 1_000).toUTCString(), START_MS), undefined);
    assert.equal(parseRetryAfterMs(String(Number.MAX_SAFE_INTEGER), START_MS), undefined);
  });
});

describe("requestUsage", () => {
  const parse = (body: unknown, nowMs: number): ServerProviderRateLimits | undefined =>
    (body as { readonly percent?: number }).percent === undefined
      ? undefined
      : {
          primary: { usedPercent: (body as { readonly percent: number }).percent },
          observedAt: new Date(nowMs).toISOString(),
        };
  const outcome = (send: () => Promise<Response>) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START_MS);
      return yield* requestUsage(send, parse);
    });

  it.effect("maps each response to its outcome", () =>
    Effect.gen(function* () {
      assert.deepEqual(
        yield* outcome(async () => Response.json({ percent: 12 })),
        read({ primary: { usedPercent: 12 }, observedAt: START }),
      );
      assert.deepEqual(yield* outcome(async () => Response.json({})), CLEARED);
      assert.deepEqual(
        yield* outcome(
          async () => new Response("", { status: 429, headers: { "Retry-After": "90" } }),
        ),
        throttled(90_000),
      );
      assert.deepEqual(yield* outcome(async () => new Response("", { status: 401 })), CLEARED);
      assert.deepEqual(yield* outcome(async () => new Response("", { status: 503 })), FAILED);
    }),
  );

  it.effect("fails on a network error, a timeout or a body it cannot read", () =>
    Effect.gen(function* () {
      assert.deepEqual(yield* outcome(() => Promise.reject(new TypeError("fetch failed"))), FAILED);
      assert.deepEqual(
        yield* outcome(() =>
          Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
        ),
        FAILED,
      );
      assert.deepEqual(yield* outcome(async () => new Response("not json")), FAILED);
      assert.deepEqual(yield* outcome(async () => Response.json(null)), FAILED);
    }),
  );
});

describe("parseCredentialExpiresAtMs", () => {
  it("reads ISO dates and epoch seconds or milliseconds", () => {
    assert.equal(parseCredentialExpiresAtMs(START), START_MS);
    assert.equal(parseCredentialExpiresAtMs(epochSeconds(START_MS)), START_MS);
    assert.equal(parseCredentialExpiresAtMs(String(epochSeconds(START_MS))), START_MS);
    assert.equal(parseCredentialExpiresAtMs(START_MS), START_MS);
    assert.equal(parseCredentialExpiresAtMs(String(START_MS)), START_MS);
  });

  it("has no expiry for absent or unreadable values", () => {
    for (const value of [undefined, null, "", "  ", "soon", Number.NaN, Infinity, {}]) {
      assert.equal(parseCredentialExpiresAtMs(value), undefined, String(value));
    }
  });
});

describe("credentialUsageReadPlan", () => {
  const plannedOutcome = (expiresAtMs: number | undefined) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(START_MS);
      let requests = 0;
      const request = Effect.sync((): UsageReadOutcome => {
        requests += 1;
        return read(USAGE);
      });
      const plan = yield* credentialUsageReadPlan("account", expiresAtMs, request);
      assert.equal(plan.accountKey, "account");
      return { outcome: yield* plan.fetch, requests };
    });

  it.effect(
    "reads with a credential that is valid for more than a minute or of unknown expiry",
    () =>
      Effect.gen(function* () {
        for (const expiresAtMs of [undefined, START_MS + minutes(1), START_MS + minutes(60)]) {
          assert.deepEqual(yield* plannedOutcome(expiresAtMs), {
            outcome: read(USAGE),
            requests: 1,
          });
        }
      }),
  );

  it.effect("clears usage without a request once the credential expires within a minute", () =>
    Effect.gen(function* () {
      for (const expiresAtMs of [START_MS + minutes(1) - 1, START_MS, START_MS - minutes(60)]) {
        assert.deepEqual(yield* plannedOutcome(expiresAtMs), { outcome: CLEARED, requests: 0 });
      }
    }),
  );
});

describe("usageAccountKey", () => {
  it("is a stable digest that never contains the credential", () => {
    const key = usageAccountKey("claude", "/home/a/.claude/.credentials.json", "secret-token");
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(
      key,
      usageAccountKey("claude", "/home/a/.claude/.credentials.json", "secret-token"),
    );
    assert.notInclude(key, "secret-token");
    assert.notEqual(
      key,
      usageAccountKey("claude", "/home/a/.claude/.credentials.json", "other-token"),
    );
    // Part boundaries count: shifted parts are another account.
    assert.notEqual(usageAccountKey("ab", "c"), usageAccountKey("a", "bc"));
  });
});
