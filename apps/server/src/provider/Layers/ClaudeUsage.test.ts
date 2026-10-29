import { mkdtemp, rm, writeFile } from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { Effect } from "effect";
import { TestClock } from "effect/testing";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { CLAUDE_OAUTH_USAGE_URL } from "../claudeOAuthUsage.ts";
import type { UsageReadOutcome } from "../usageReadGate.ts";
import {
  type ClaudeCredentialStore,
  parseClaudeUsageRateLimits,
  planClaudeUsageRead,
  resolveClaudeLoginStore,
} from "./ClaudeUsage.ts";

const READ_AT_MS = Date.parse("2026-05-11T15:04:05.000Z");

describe("parseClaudeUsageRateLimits", () => {
  it("maps Claude OAuth five-hour and seven-day tiers into provider rate limits", () => {
    const parsed = parseClaudeUsageRateLimits(
      {
        five_hour: {
          utilization: 42,
          resets_at: "2026-05-11T17:30:00.000Z",
        },
        seven_day: {
          utilization: 7,
          resets_at: "2026-05-18T12:00:00.000Z",
        },
        seven_day_sonnet: {
          utilization: 12,
          resets_at: "2026-05-18T12:00:00.000Z",
        },
        extra_usage: {
          is_enabled: true,
        },
      },
      "Claude Max Subscription",
      READ_AT_MS,
    );

    expect(parsed).toEqual({
      limitId: "claude-oauth",
      limitName: "Claude Max Subscription",
      planType: "Claude Max Subscription",
      primary: {
        usedPercent: 42,
        windowDurationMins: 300,
        resetsAt: 1_778_520_600,
      },
      secondary: {
        usedPercent: 7,
        windowDurationMins: 10_080,
        resetsAt: 1_779_105_600,
      },
      windows: [
        { id: "five_hour", usedPercent: 42, windowDurationMins: 300, resetsAt: 1_778_520_600 },
        { id: "seven_day", usedPercent: 7, windowDurationMins: 10_080, resetsAt: 1_779_105_600 },
        {
          id: "seven_day_sonnet",
          scope: "Sonnet",
          usedPercent: 12,
          windowDurationMins: 10_080,
          resetsAt: 1_779_105_600,
        },
      ],
      observedAt: "2026-05-11T15:04:05.000Z",
    });
  });

  it("lists model-scoped windows and credit pools beside the unchanged account-wide slots", () => {
    const parsed = parseClaudeUsageRateLimits(
      {
        five_hour: { utilization: 10, resets_at: "2026-05-11T17:30:00.000Z" },
        seven_day: { utilization: 20, resets_at: "2026-05-18T12:00:00.000Z" },
        seven_day_opus: { utilization: 30, resets_at: "2026-05-18T12:00:00.000Z" },
        limits: [
          {
            kind: "weekly_scoped",
            percent: 55,
            resets_at: "2026-05-18T12:00:00.000Z",
            is_active: true,
            scope: { model: { display_name: "Fable" } },
          },
        ],
        iguana_necktie: { utilization: 4, used_dollars: 2, limit_dollars: 50 },
      },
      "max",
      READ_AT_MS,
    );

    expect(parsed?.primary).toEqual({
      usedPercent: 10,
      windowDurationMins: 300,
      resetsAt: 1_778_520_600,
    });
    expect(parsed?.secondary).toEqual({
      usedPercent: 20,
      windowDurationMins: 10_080,
      resetsAt: 1_779_105_600,
    });
    expect(parsed?.tertiary).toBeUndefined();
    expect(parsed?.windows).toEqual([
      { id: "five_hour", usedPercent: 10, windowDurationMins: 300, resetsAt: 1_778_520_600 },
      { id: "seven_day", usedPercent: 20, windowDurationMins: 10_080, resetsAt: 1_779_105_600 },
      {
        id: "seven_day_opus",
        scope: "Opus",
        usedPercent: 30,
        windowDurationMins: 10_080,
        resetsAt: 1_779_105_600,
      },
      {
        id: "seven_day_fable",
        scope: "Fable",
        usedPercent: 55,
        windowDurationMins: 10_080,
        resetsAt: 1_779_105_600,
      },
      { id: "cloud_session_credits", scope: "Cloud session credits", usedPercent: 4 },
    ]);
    expect(parsed?.observedAt).toBe("2026-05-11T15:04:05.000Z");
  });

  it("returns undefined when no primary usage tiers are present", () => {
    expect(
      parseClaudeUsageRateLimits(
        {
          seven_day_sonnet: { utilization: 12 },
          extra_usage: { is_enabled: true },
        },
        null,
        READ_AT_MS,
      ),
    ).toBeUndefined();
  });
});

describe("resolveClaudeLoginStore", () => {
  const userHome = "/home/mock";
  const resolve = (
    environment: NodeJS.ProcessEnv,
    account: { readonly subscriptionType?: string; readonly tokenSource?: string } = {
      subscriptionType: "Claude Max",
    },
  ) =>
    resolveClaudeLoginStore(
      { USER: "mock-user", ...environment },
      { subscriptionType: account.subscriptionType, tokenSource: account.tokenSource },
      userHome,
    );
  const defaultStore = {
    credentialsPath: "/home/mock/.claude/.credentials.json",
    keychain: { service: "Claude Code-credentials", account: "mock-user" },
  };

  it("uses the default home's file and global Keychain item", () => {
    expect(resolve({})).toEqual(defaultStore);
    expect(resolve({ HOME: userHome })).toEqual(defaultStore);
  });

  it("uses only an overridden home's file", () => {
    expect(resolve({ HOME: "/srv/work" })).toEqual({
      credentialsPath: "/srv/work/.claude/.credentials.json",
      keychain: undefined,
    });
  });

  it("uses a configuration directory's file and its directory-scoped Keychain item", () => {
    expect(resolve({ CLAUDE_CONFIG_DIR: "/srv/claude" })).toEqual({
      credentialsPath: "/srv/claude/.credentials.json",
      keychain: { service: "Claude Code-credentials-bc29611f", account: "mock-user" },
    });
    expect(resolve({ HOME: "/srv/work", CLAUDE_CONFIG_DIR: "/srv/claude" })).toEqual({
      credentialsPath: "/srv/claude/.credentials.json",
      keychain: undefined,
    });
    expect(resolve({ CLAUDE_CONFIG_DIR: "" })).toEqual(defaultStore);
  });

  it("uses Claude Code's fallback Keychain account for unusable user names", () => {
    expect(resolve({ USER: "mock user" })?.keychain?.account).toBe("claude-code-user");
  });

  it("has no store under Claude Code's internal storage override", () => {
    expect(resolve({ CLAUDE_SECURESTORAGE_CONFIG_DIR: "/srv/secure" })).toBeUndefined();
  });

  it("has no store for an instance routed through a proxy", () => {
    expect(
      resolve({
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
        ANTHROPIC_AUTH_TOKEN: "proxy-token",
        ANTHROPIC_API_KEY: "",
      }),
    ).toBeUndefined();
  });

  it.each([
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "ANTHROPIC_PROFILE",
    "ANTHROPIC_UNIX_SOCKET",
    "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  ])("has no store when %s is set, and ignores it when blank", (name) => {
    expect(resolve({ [name]: "mock-value" })).toBeUndefined();
    expect(resolve({ [name]: " " })).toEqual(defaultStore);
  });

  it.each([
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
    "CLAUDE_CODE_USE_ANTHROPIC_AWS",
    "CLAUDE_CODE_USE_ANTHROPIC_GOOGLE_CLOUD",
    "CLAUDE_CODE_USE_MANTLE",
    "CLAUDE_CODE_USE_GATEWAY",
  ])("has no store when %s switches providers, and ignores falsy values", (name) => {
    for (const value of ["1", "true", "YES", " on "]) {
      expect(resolve({ [name]: value })).toBeUndefined();
    }
    for (const value of ["", "0", "false", "off"]) {
      expect(resolve({ [name]: value })).toEqual(defaultStore);
    }
  });

  it("has a store only while Claude Code reports using its claude.ai subscription", () => {
    expect(resolve({}, { subscriptionType: "Claude Pro" })).toEqual(defaultStore);
    // Reported when a claude.ai login exists but Claude Code authenticates another way.
    expect(resolve({}, { tokenSource: "claude.ai" })).toBeUndefined();
    expect(resolve({}, { tokenSource: "ANTHROPIC_AUTH_TOKEN" })).toBeUndefined();
    expect(resolve({}, { tokenSource: "apiKeyHelper" })).toBeUndefined();
    expect(resolve({}, { tokenSource: "none" })).toBeUndefined();
    expect(
      resolve({}, { subscriptionType: "Claude Pro", tokenSource: "CLAUDE_CODE_OAUTH_TOKEN" }),
    ).toBeUndefined();
    // Third-party providers and Anthropic profiles report neither field.
    expect(resolve({}, {})).toBeUndefined();
  });
});

describe("planClaudeUsageRead", () => {
  const NOW_MS = Date.parse("2026-10-28T12:00:00.000Z");
  const temporaryDirectories: string[] = [];
  afterEach(async () => {
    await Promise.all(
      temporaryDirectories
        .splice(0)
        .map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

  // A login in its own credential file; no Keychain item, so nothing outside the temp dir is read.
  const loginStore = async (
    oauth: Record<string, unknown> = {
      accessToken: "mock-access",
      refreshToken: "mock-refresh",
      expiresAt: NOW_MS + 3_600_000,
      subscriptionType: "max",
    },
  ): Promise<ClaudeCredentialStore> => {
    const directory = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "ryco-claude-usage-"));
    temporaryDirectories.push(directory);
    const credentialsPath = NodePath.join(directory, ".credentials.json");
    await writeFile(credentialsPath, JSON.stringify({ claudeAiOauth: oauth }));
    return { credentialsPath, keychain: undefined };
  };
  const fakeFetch = (response: () => Promise<Response>) => {
    const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
    const fetchImpl = ((url: string, init?: RequestInit) => {
      requests.push({ url, init });
      return response();
    }) as unknown as typeof globalThis.fetch;
    return { fetchImpl, requests };
  };
  const plan = (store: ClaudeCredentialStore, fetchImpl: typeof globalThis.fetch) =>
    Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        return yield* planClaudeUsageRead(store, "2.1.296", fetchImpl);
      }).pipe(Effect.provide(TestClock.layer())),
    );
  const outcome = async (response: () => Promise<Response>): Promise<UsageReadOutcome> => {
    const api = fakeFetch(response);
    const read = await plan(await loginStore(), api.fetchImpl);
    if (!read) throw new Error("Expected a usage read.");
    return Effect.runPromise(
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        return yield* read.fetch;
      }).pipe(Effect.provide(TestClock.layer())),
    );
  };

  it("sends one request with the login's token and reads every window", async () => {
    const api = fakeFetch(async () =>
      Response.json({ five_hour: { utilization: 42 }, seven_day_opus: { utilization: 9 } }),
    );
    const read = await plan(await loginStore(), api.fetchImpl);
    expect(read?.accountKey).toMatch(/^[0-9a-f]{64}$/);
    expect(api.requests).toHaveLength(0);

    const result = await Effect.runPromise(read!.fetch);
    expect(api.requests.map(({ url }) => url)).toEqual([CLAUDE_OAUTH_USAGE_URL]);
    const headers = api.requests[0]?.init?.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer mock-access");
    expect(headers["User-Agent"]).toBe("claude-code/2.1.296");
    expect(result._tag).toBe("Read");
    if (result._tag !== "Read") return;
    expect(result.rateLimits.planType).toBe("max");
    expect(result.rateLimits.windows?.map((window) => window.id)).toEqual([
      "five_hour",
      "seven_day_opus",
    ]);
  });

  it("maps throttled, refused, failing and timed-out requests to their outcomes", async () => {
    expect(
      await outcome(
        async () => new Response("", { status: 429, headers: { "Retry-After": "120" } }),
      ),
    ).toEqual({ _tag: "Throttled", retryAfterMs: 120_000 });
    expect(await outcome(async () => new Response("", { status: 429 }))).toEqual({
      _tag: "Throttled",
      retryAfterMs: undefined,
    });
    expect(await outcome(async () => new Response("", { status: 401 }))).toEqual({
      _tag: "Cleared",
    });
    expect(await outcome(async () => new Response("", { status: 403 }))).toEqual({
      _tag: "Cleared",
    });
    expect(await outcome(async () => new Response("", { status: 500 }))).toEqual({
      _tag: "Failed",
    });
    expect(
      await outcome(() =>
        Promise.reject(new DOMException("The operation timed out.", "TimeoutError")),
      ),
    ).toEqual({ _tag: "Failed" });
    // A response without the account-wide windows reports no usage.
    expect(await outcome(async () => Response.json({ extra_usage: {} }))).toEqual({
      _tag: "Cleared",
    });
  });

  it("clears usage for an expired token without a request", async () => {
    const api = fakeFetch(async () => Response.json({ five_hour: { utilization: 1 } }));
    const read = await plan(
      await loginStore({ accessToken: "mock-access", expiresAt: NOW_MS + 30_000 }),
      api.fetchImpl,
    );
    expect(await Effect.runPromise(read!.fetch)).toEqual({ _tag: "Cleared" });
    expect(api.requests).toHaveLength(0);
  });

  it("has no read without a login", async () => {
    const api = fakeFetch(async () => Response.json({}));
    const directory = await mkdtemp(NodePath.join(NodeOS.tmpdir(), "ryco-claude-usage-"));
    temporaryDirectories.push(directory);
    const missing = {
      credentialsPath: NodePath.join(directory, "missing.json"),
      keychain: undefined,
    };
    expect(await plan(missing, api.fetchImpl)).toBeUndefined();
    expect(await plan(await loginStore({}), api.fetchImpl)).toBeUndefined();
    expect(api.requests).toHaveLength(0);
  });

  it("keys the read on the store and the login, never on the token itself", async () => {
    const api = fakeFetch(async () => Response.json({}));
    const store = await loginStore();
    const key = (await plan(store, api.fetchImpl))?.accountKey;
    expect((await plan({ ...store }, api.fetchImpl))?.accountKey).toBe(key);
    expect(key).not.toContain("mock-refresh");
    expect(key).not.toContain("mock-access");

    await writeFile(
      store.credentialsPath,
      JSON.stringify({ claudeAiOauth: { accessToken: "mock-access", refreshToken: "other" } }),
    );
    expect((await plan(store, api.fetchImpl))?.accountKey).not.toBe(key);
    expect((await plan(await loginStore(), api.fetchImpl))?.accountKey).not.toBe(key);
  });
});
