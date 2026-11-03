import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Duration, Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, it } from "vite-plus/test";

import { makeUsageReadGate, type UsageReadOutcome } from "../usageReadGate.ts";
import {
  type GrokLogin,
  parseGrokBillingRateLimits,
  planGrokUsageRead,
  readGrokLogin,
  resolveGrokAccount,
  resolveGrokAuthPath,
  resolveGrokHomePath,
} from "./GrokUsage.ts";

const LOGIN_KEY = "https://auth.x.ai::b1a00492-073a-47ea-816f-4c329264a828";
const LEGACY_LOGIN_KEY = "https://accounts.x.ai/sign-in";
const BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
const READ_AT_MS = Date.parse("2026-09-16T00:00:00.000Z");
const epochSeconds = (iso: string) => Math.floor(Date.parse(iso) / 1000);

// Recorded shape of the billing response (T3 Code fixtures): a weekly SuperGrok period.
const WEEKLY_PERIOD = {
  type: "USAGE_PERIOD_TYPE_WEEKLY",
  start: "2026-09-11T03:10:30.159171+00:00",
  end: "2026-09-18T03:10:30.159171+00:00",
};
const MONTHLY_PERIOD = {
  type: "USAGE_PERIOD_TYPE_MONTHLY",
  start: "2026-09-01T00:00:00.000Z",
  end: "2026-10-01T00:00:00.000Z",
};
const WEEKLY_RESET = epochSeconds(WEEKLY_PERIOD.end);
const MONTHLY_RESET = epochSeconds(MONTHLY_PERIOD.end);

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

/**
 * A temporary Grok home with `files`, and a separate machine-wide config directory with
 * `systemFiles`, so no test ever reads the real `~/.grok` or `/etc/grok`.
 */
async function grokHome(
  files: Readonly<Record<string, unknown>> = {},
  systemFiles: Readonly<Record<string, string>> = {},
) {
  const base = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "ryco-grok-usage-"));
  temporaryDirectories.push(base);
  const home = NodePath.join(base, "grok-home");
  const systemConfigDir = NodePath.join(base, "etc-grok");
  await mkdir(home, { recursive: true });
  await mkdir(systemConfigDir, { recursive: true });
  for (const [name, contents] of Object.entries(files)) {
    await writeFile(
      NodePath.join(home, name),
      typeof contents === "string" ? contents : JSON.stringify(contents),
    );
  }
  for (const [name, contents] of Object.entries(systemFiles)) {
    await writeFile(NodePath.join(systemConfigDir, name), contents);
  }
  return {
    base,
    home,
    environment: { GROK_HOME: home, HOME: NodePath.join(base, "unrelated-home") },
    options: { systemConfigDir },
  };
}

const readLogin = async (
  environment: NodeJS.ProcessEnv,
  options: { readonly systemConfigDir: string },
) => Effect.runPromise(readGrokLogin(environment, options));

const loginWith = async (store: unknown) => {
  const { environment, options } = await grokHome({ "auth.json": store });
  return readLogin(environment, options);
};

/** A fake fetch answering with `responses` in turn, recording every request it receives. */
function fakeFetch(...responses: ReadonlyArray<() => Response>) {
  const queued = [...responses];
  const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    requests.push({ url: String(url), init });
    const next = queued.shift();
    if (!next) throw new Error("Unexpected billing request.");
    return next();
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, requests };
}

const LOGIN: GrokLogin = {
  email: "someone@example.com",
  token: "session-token",
  accountKey: "a".repeat(64),
  expiresAtMs: undefined,
};

const runAt = <A>(effect: Effect.Effect<A>, nowMs = READ_AT_MS) =>
  Effect.runPromise(
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      return yield* effect;
    }).pipe(Effect.provide(TestClock.layer())),
  );

/** One planned read's outcome, or undefined without a plan. */
const outcomeOf = (login: GrokLogin | undefined, fetchImpl: typeof globalThis.fetch) =>
  runAt(
    Effect.gen(function* () {
      const plan = yield* planGrokUsageRead(login, fetchImpl);
      return plan ? yield* plan.fetch : undefined;
    }),
  );

const jwtWithExp = (expSeconds: number) =>
  [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: "user", exp: expSeconds })).toString("base64url"),
    "signature",
  ].join(".");

describe("resolveGrokHomePath", () => {
  it("prefers GROK_HOME, then the instance's HOME", () => {
    assert.equal(resolveGrokHomePath({ GROK_HOME: "/grok", HOME: "/home/u" }), "/grok");
    assert.equal(resolveGrokHomePath({ HOME: "/home/u" }), NodePath.join("/home/u", ".grok"));
    assert.equal(
      resolveGrokAuthPath({ GROK_HOME: " ", HOME: "/home/u" }),
      NodePath.join("/home/u", ".grok", "auth.json"),
    );
  });
});

describe("readGrokLogin", () => {
  it("prefers the current login entry to the legacy one", async () => {
    const login = await loginWith({
      [LOGIN_KEY]: { key: "session-token", auth_mode: "oauth", email: " Someone@Example.com " },
      [LEGACY_LOGIN_KEY]: { key: "legacy-token", email: "legacy@example.com" },
    });
    assert.equal(login?.token, "session-token");
    assert.equal(login?.email, "Someone@Example.com");
    assert.match(login?.accountKey ?? "", /^[0-9a-f]{64}$/);
    assert.ok(!login?.accountKey.includes("session-token"));
  });

  it("uses the legacy entry, or the file's only auth.x.ai entry", async () => {
    assert.equal(
      (await loginWith({ [LEGACY_LOGIN_KEY]: { key: "legacy-token" } }))?.token,
      "legacy-token",
    );
    const single = await loginWith({
      "https://auth.x.ai::another-client": { key: "single-token", email: "single@example.com" },
      "https://other.example": { key: "unrelated-token" },
    });
    assert.equal(single?.token, "single-token");
    assert.equal(single?.email, "single@example.com");
  });

  it("never picks an arbitrary account", async () => {
    for (const store of [
      {
        "https://auth.x.ai::first-client": { key: "first-token" },
        "https://auth.x.ai::second-client": { key: "second-token" },
      },
      { "https://other.example": { key: "unrelated-token" } },
      // The current entry decides even when it holds no usable token.
      { [LOGIN_KEY]: { key: " " }, [LEGACY_LOGIN_KEY]: { key: "legacy-token" } },
      { [LOGIN_KEY]: { key: 42 } },
      { [LOGIN_KEY]: { key: "api-key", auth_mode: "api_key", email: "someone@example.com" } },
      {},
    ]) {
      assert.equal(await loginWith(store), undefined, JSON.stringify(store));
    }
  });

  it("reads GROK_AUTH instead of the stored login", async () => {
    const { environment, options } = await grokHome({
      "auth.json": { [LOGIN_KEY]: { key: "stored-token" } },
    });
    const login = await readLogin(
      {
        ...environment,
        GROK_AUTH: JSON.stringify({ [LEGACY_LOGIN_KEY]: { key: "inline-token" } }),
      },
      options,
    );
    assert.equal(login?.token, "inline-token");
  });

  it("finds ~/.grok in the instance's HOME when GROK_HOME is unset", async () => {
    const { base, options } = await grokHome();
    await mkdir(NodePath.join(base, ".grok"));
    await writeFile(
      NodePath.join(base, ".grok", "auth.json"),
      JSON.stringify({ [LOGIN_KEY]: { key: "home-token" } }),
    );
    assert.equal((await readLogin({ HOME: base }, options))?.token, "home-token");
  });

  it("reads nothing for an API-key instance or an alternate auth deployment", async () => {
    const { environment, options } = await grokHome({
      "auth.json": { [LOGIN_KEY]: { key: "session-token", email: "someone@example.com" } },
    });
    assert.equal((await readLogin(environment, options))?.token, "session-token");
    for (const name of [
      "XAI_API_KEY",
      "GROK_OIDC_ISSUER",
      "GROK_OIDC_CLIENT_ID",
      "GROK_OAUTH2_ISSUER",
      "GROK_OAUTH2_CLIENT_ID",
      "GROK_OAUTH2_PRINCIPAL_TYPE",
      "GROK_OAUTH2_PRINCIPAL_ID",
      "GROK_AUTH_PROVIDER_COMMAND",
      "GROK_LOCAL_AUTH",
      "GROK_CLI_CHAT_PROXY_BASE_URL",
      "GROK_MODELS_BASE_URL",
      "GROK_CONFIG",
      "GROK_CONFIG_PATH",
    ]) {
      assert.equal(await readLogin({ ...environment, [name]: "set" }, options), undefined, name);
    }
    // Blank values do not count as set.
    assert.equal(
      (await readLogin({ ...environment, XAI_API_KEY: " " }, options))?.token,
      "session-token",
    );
  });

  it("reads nothing when a config selects another auth or endpoint", async () => {
    const auth = { [LOGIN_KEY]: { key: "session-token" } };
    for (const [files, systemFiles] of [
      [{ "config.toml": '[auth]\nprovider_command = "custom-auth"\n' }, {}],
      [{ "config.toml": '[endpoints]\ncli_chat_proxy = "https://proxy.example"\n' }, {}],
      [{ "config.toml": '[endpoints.models]\nbase_url = "https://models.example"\n' }, {}],
      [{ "managed_config.toml": 'auth.issuer = "https://issuer.example"\n' }, {}],
      [{ "requirements.toml": "[[auth]]\nmethod = 'oidc'\n" }, {}],
      [{}, { "managed_config.toml": "[grok_com_config]\nteam = true\n" }],
      [{}, { "requirements.toml": '"endpoints" = { }\n' }],
    ] as const) {
      const { environment, options } = await grokHome({ ...files, "auth.json": auth }, systemFiles);
      assert.equal(
        await readLogin(environment, options),
        undefined,
        JSON.stringify({ files, systemFiles }),
      );
    }

    const { environment, options } = await grokHome(
      { "config.toml": '[ui]\ntheme = "dark"\nauthor = "me"\n', "auth.json": auth },
      { "managed_config.toml": "# auth is managed by the CLI\n" },
    );
    assert.equal((await readLogin(environment, options))?.token, "session-token");
  });

  it("treats a missing or malformed login file as no login", async () => {
    const { environment, options } = await grokHome();
    assert.equal(await readLogin(environment, options), undefined);
    assert.equal(await loginWith("private-token-invalid-json"), undefined);
    assert.equal(await loginWith(["not", "a", "store"]), undefined);
    assert.equal(await readLogin({ ...environment, GROK_AUTH: "not-json" }, options), undefined);
  });

  it("keys the read on the refresh token when there is one", async () => {
    const { environment, home, options } = await grokHome();
    const keyOf = async (entry: Record<string, unknown>) => {
      await writeFile(NodePath.join(home, "auth.json"), JSON.stringify({ [LOGIN_KEY]: entry }));
      return (await readLogin(environment, options))?.accountKey;
    };
    const renewed = await keyOf({ key: "access-1", refresh_token: "refresh" });
    assert.equal(await keyOf({ key: "access-2", refresh_token: "refresh" }), renewed);
    assert.notEqual(await keyOf({ key: "access-1", refresh_token: "other-refresh" }), renewed);
    assert.notEqual(await keyOf({ key: "access-1" }), await keyOf({ key: "access-2" }));
  });

  it("takes the earlier of expires_at and the token's own exp", async () => {
    const at = (iso: string) => Date.parse(iso);
    assert.equal(
      (await loginWith({ [LOGIN_KEY]: { key: "opaque", expires_at: "2026-09-16T01:00:00Z" } }))
        ?.expiresAtMs,
      at("2026-09-16T01:00:00Z"),
    );
    const jwt = jwtWithExp(epochSeconds("2026-09-16T00:30:00Z"));
    assert.equal(
      (await loginWith({ [LOGIN_KEY]: { key: jwt, expires_at: "2026-09-16T01:00:00Z" } }))
        ?.expiresAtMs,
      at("2026-09-16T00:30:00Z"),
    );
    assert.equal((await loginWith({ [LOGIN_KEY]: { key: "opaque" } }))?.expiresAtMs, undefined);
  });
});

describe("parseGrokBillingRateLimits", () => {
  it("maps a weekly period to a weekly credits window and the weekly slot", () => {
    assert.deepEqual(
      parseGrokBillingRateLimits(
        { config: { creditUsagePercent: 37, currentPeriod: WEEKLY_PERIOD } },
        READ_AT_MS,
      ),
      {
        limitId: "grok-credits",
        secondary: { usedPercent: 37, resetsAt: WEEKLY_RESET, windowDurationMins: 10_080 },
        windows: [
          { id: "credits", usedPercent: 37, resetsAt: WEEKLY_RESET, windowDurationMins: 10_080 },
        ],
        observedAt: "2026-09-16T00:00:00.000Z",
      },
    );
  });

  it("maps a monthly period to a monthly credits window and the third slot", () => {
    assert.deepEqual(
      parseGrokBillingRateLimits(
        { config: { creditUsagePercent: 0.5, currentPeriod: MONTHLY_PERIOD } },
        READ_AT_MS,
      ),
      {
        limitId: "grok-credits",
        // A real half-percent reading, never scaled up as if it were a fraction.
        tertiary: { usedPercent: 0.5, resetsAt: MONTHLY_RESET, windowDurationMins: 43_200 },
        windows: [
          { id: "credits", usedPercent: 0.5, resetsAt: MONTHLY_RESET, windowDurationMins: 43_200 },
        ],
        observedAt: "2026-09-16T00:00:00.000Z",
      },
    );
  });

  it("names a window without a known period Credits and fills no slot", () => {
    assert.deepEqual(
      parseGrokBillingRateLimits({ config: { creditUsagePercent: 12 } }, READ_AT_MS),
      {
        limitId: "grok-credits",
        windows: [{ id: "credits", scope: "Credits", usedPercent: 12 }],
        observedAt: "2026-09-16T00:00:00.000Z",
      },
    );
    assert.deepEqual(
      parseGrokBillingRateLimits(
        {
          config: {
            creditUsagePercent: 12,
            currentPeriod: { ...WEEKLY_PERIOD, type: "USAGE_PERIOD_TYPE_DAILY" },
          },
        },
        READ_AT_MS,
      )?.windows,
      [{ id: "credits", scope: "Credits", usedPercent: 12, resetsAt: WEEKLY_RESET }],
    );
  });

  it("reads an omitted percent as zero only for a complete weekly or monthly period", () => {
    for (const period of [WEEKLY_PERIOD, MONTHLY_PERIOD]) {
      assert.equal(
        parseGrokBillingRateLimits({ config: { currentPeriod: period } }, READ_AT_MS)?.windows?.[0]
          ?.usedPercent,
        0,
      );
    }
    for (const period of [
      undefined,
      { ...WEEKLY_PERIOD, type: undefined },
      { ...WEEKLY_PERIOD, type: "USAGE_PERIOD_TYPE_DAILY" },
      { ...WEEKLY_PERIOD, start: undefined },
      { ...WEEKLY_PERIOD, end: undefined },
      { ...WEEKLY_PERIOD, start: "invalid" },
      { ...WEEKLY_PERIOD, start: WEEKLY_PERIOD.end },
      { ...WEEKLY_PERIOD, start: WEEKLY_PERIOD.end, end: WEEKLY_PERIOD.start },
      // Impossible calendar dates, which `Date.parse` would roll into March.
      { ...WEEKLY_PERIOD, start: "2026-02-30T00:00:00.000Z", end: "2026-03-09T00:00:00.000Z" },
      { ...WEEKLY_PERIOD, start: "2026-02-23T00:00:00.000Z", end: "2026-02-30T00:00:00.000Z" },
    ]) {
      assert.equal(
        parseGrokBillingRateLimits({ config: { currentPeriod: period } }, READ_AT_MS),
        undefined,
        JSON.stringify(period),
      );
    }
  });

  it("clamps the percent and leaves out an unparsable reset", () => {
    assert.deepEqual(
      parseGrokBillingRateLimits(
        {
          config: {
            creditUsagePercent: 120,
            currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", end: "invalid" },
          },
        },
        READ_AT_MS,
      )?.windows,
      [{ id: "credits", usedPercent: 100, windowDurationMins: 43_200 }],
    );
    assert.equal(
      parseGrokBillingRateLimits({ config: { creditUsagePercent: -3 } }, READ_AT_MS)?.windows?.[0]
        ?.usedPercent,
      0,
    );
  });

  it("reports nothing for a body without usage", () => {
    for (const body of [
      null,
      "text",
      {},
      { config: null },
      { config: {} },
      { config: { creditUsagePercent: "private-value", currentPeriod: WEEKLY_PERIOD } },
      { config: { creditUsagePercent: Number.NaN } },
    ]) {
      assert.equal(parseGrokBillingRateLimits(body, READ_AT_MS), undefined, JSON.stringify(body));
    }
  });
});

describe("planGrokUsageRead", () => {
  it("sends the login's token to the billing API only, with the CLI's headers", async () => {
    const api = fakeFetch(() =>
      Response.json({ config: { creditUsagePercent: 37, currentPeriod: WEEKLY_PERIOD } }),
    );
    const outcome = await outcomeOf(LOGIN, api.fetchImpl);

    assert.equal(api.requests.length, 1);
    const [request] = api.requests;
    assert.equal(request?.url, BILLING_URL);
    assert.equal(new URL(request?.url ?? "").host, "cli-chat-proxy.grok.com");
    assert.equal(request?.init?.method ?? "GET", "GET");
    assert.deepEqual(Object.fromEntries(new Headers(request?.init?.headers)), {
      accept: "application/json",
      authorization: "Bearer session-token",
      "x-xai-token-auth": "xai-grok-cli",
    });
    // A redirect fails the read instead of carrying the token to another host.
    assert.equal(request?.init?.redirect, "error");
    assert.ok(request?.init?.signal instanceof AbortSignal);
    assert.deepEqual(outcome, {
      _tag: "Read",
      rateLimits: parseGrokBillingRateLimits(
        { config: { creditUsagePercent: 37, currentPeriod: WEEKLY_PERIOD } },
        READ_AT_MS,
      ),
    });
  });

  it("maps refusals, throttling and failures onto read outcomes", async () => {
    const cases: ReadonlyArray<readonly [() => Response, UsageReadOutcome]> = [
      [
        () => new Response("", { status: 429, headers: { "Retry-After": "120" } }),
        { _tag: "Throttled", retryAfterMs: 120_000 },
      ],
      [() => new Response("private response", { status: 401 }), { _tag: "Cleared" }],
      [() => new Response("", { status: 403 }), { _tag: "Cleared" }],
      [() => new Response("", { status: 500 }), { _tag: "Failed" }],
      [() => new Response("not json", { status: 200 }), { _tag: "Failed" }],
      [
        () => Response.json({ config: { creditUsagePercent: "private-value" } }),
        { _tag: "Cleared" },
      ],
    ];
    for (const [response, expected] of cases) {
      const api = fakeFetch(response);
      assert.deepEqual(await outcomeOf(LOGIN, api.fetchImpl), expected);
      assert.equal(api.requests.length, 1);
    }
  });

  it("clears an expired login without a request", async () => {
    const api = fakeFetch();
    for (const expiresAtMs of [READ_AT_MS - 1, READ_AT_MS + 30_000]) {
      assert.deepEqual(await outcomeOf({ ...LOGIN, expiresAtMs }, api.fetchImpl), {
        _tag: "Cleared",
      });
    }
    // The same for a token whose own `exp` has passed.
    const { environment, options } = await grokHome({
      "auth.json": { [LOGIN_KEY]: { key: jwtWithExp(READ_AT_MS / 1000 - 60) } },
    });
    const expired = await readLogin(environment, options);
    assert.ok(expired);
    assert.deepEqual(await outcomeOf(expired, api.fetchImpl), { _tag: "Cleared" });
    assert.equal(api.requests.length, 0);

    assert.equal(await outcomeOf(undefined, api.fetchImpl), undefined);
  });
});

describe("resolveGrokAccount", () => {
  const signedIn = () =>
    grokHome({
      "auth.json": { [LOGIN_KEY]: { key: "session-token", email: "someone@example.com" } },
    });

  it("reads the login's email and credits through the gate", async () => {
    const { environment, options } = await signedIn();
    const api = fakeFetch(
      () => Response.json({ config: { creditUsagePercent: 37, currentPeriod: WEEKLY_PERIOD } }),
      () => new Response("", { status: 429 }),
    );

    const [fresh, throttled] = await runAt(
      Effect.gen(function* () {
        const gate = yield* makeUsageReadGate();
        const read = () =>
          resolveGrokAccount(environment, gate, { ...options, fetchImpl: api.fetchImpl });
        const fresh = yield* read();
        yield* TestClock.adjust(Duration.minutes(5));
        const throttled = yield* read();
        // Inside the cooldown: no request at all.
        yield* TestClock.adjust(Duration.minutes(2));
        yield* read();
        return [fresh, throttled] as const;
      }),
    );

    assert.equal(fresh.email, "someone@example.com");
    assert.equal(fresh.rateLimits?.secondary?.usedPercent, 37);
    assert.equal(fresh.rateLimits?.observedAt, "2026-09-16T00:00:00.000Z");
    assert.deepEqual(throttled, {
      email: "someone@example.com",
      rateLimits: { ...fresh.rateLimits, stale: true, staleReason: "rateLimited" },
    });
    assert.equal(api.requests.length, 2);
  });

  it("reads nothing for an API-key instance", async () => {
    const { environment, options } = await signedIn();
    const api = fakeFetch();
    const account = await runAt(
      Effect.flatMap(makeUsageReadGate(), (gate) =>
        resolveGrokAccount({ ...environment, XAI_API_KEY: "xai-key" }, gate, {
          ...options,
          fetchImpl: api.fetchImpl,
        }),
      ),
    );
    assert.deepEqual(account, {});
    assert.equal(api.requests.length, 0);
  });

  it("keeps the email when the credits cannot be read", async () => {
    const { environment, options } = await signedIn();
    const api = fakeFetch(() => new Response("", { status: 401 }));
    const account = await runAt(
      Effect.flatMap(makeUsageReadGate(), (gate) =>
        resolveGrokAccount(environment, gate, { ...options, fetchImpl: api.fetchImpl }),
      ),
    );
    assert.deepEqual(account, { email: "someone@example.com" });
  });
});
