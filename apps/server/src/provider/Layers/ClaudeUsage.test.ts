import { describe, expect, it } from "vite-plus/test";

import { parseClaudeUsageRateLimits, resolveClaudeLoginStore } from "./ClaudeUsage.ts";

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
    });
  });

  it("returns undefined when no primary usage tiers are present", () => {
    expect(
      parseClaudeUsageRateLimits(
        {
          seven_day_sonnet: { utilization: 12 },
          extra_usage: { is_enabled: true },
        },
        null,
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
