import {
  CliProxyHubId,
  CliProxyReadHubsResult,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderInstanceConfig,
  type ProviderInstanceConfigMap,
} from "@ryco/contracts";
import { Exit, Schema } from "effect";
import { describe, expect, it } from "vite-plus/test";

import {
  describeManagementFailure,
  hubAuthAddress,
  managementAuthOutcome,
  maskApiKey,
  parseAntigravityQuota,
  parseApiCallResult,
  parseApiKeyUsage,
  parseCodexUsage,
  parseHubAccounts,
  routedInstanceIds,
} from "./cliProxyParsing.ts";

describe("routedInstanceIds", () => {
  const instance = (
    driver: string,
    ...baseUrls: ReadonlyArray<string>
  ): ProviderInstanceConfig => ({
    driver: ProviderDriverKind.make(driver),
    ...(baseUrls.length > 0
      ? {
          environment: baseUrls.map((value) => ({
            name: "ANTHROPIC_BASE_URL",
            value,
            sensitive: false,
          })),
        }
      : {}),
  });
  const instances = (entries: Record<string, ProviderInstanceConfig>): ProviderInstanceConfigMap =>
    Object.fromEntries(
      Object.entries(entries).map(([id, config]) => [ProviderInstanceId.make(id), config]),
    );

  it("matches Claude instances pointing at the hub through any loopback alias", () => {
    const configured = instances({
      loopback: instance("claudeAgent", "http://127.0.0.1:8317"),
      localhost: instance("claudeAgent", "http://localhost:8317/v1/"),
      ipv6: instance("claudeAgent", "http://[::1]:8317"),
      wildcard: instance("claudeAgent", "http://0.0.0.0:8317"),
      otherPort: instance("claudeAgent", "http://localhost:8318"),
      openrouter: instance("claudeAgent", "https://openrouter.ai/api"),
      plain: instance("claudeAgent"),
      codex: instance("codex", "http://localhost:8317"),
    });
    expect(routedInstanceIds("http://localhost:8317", configured)).toEqual([
      "loopback",
      "localhost",
      "ipv6",
      "wildcard",
    ]);
  });

  it("keeps remote hosts and path prefixes distinct and uses the last definition", () => {
    const configured = instances({
      remote: instance("claudeAgent", "https://hub.example.ts.net/proxy/v1"),
      otherPath: instance("claudeAgent", "https://hub.example.ts.net/other"),
      redefined: instance(
        "claudeAgent",
        "https://hub.example.ts.net/proxy",
        "https://openrouter.ai/api",
      ),
    });
    expect(routedInstanceIds("https://hub.example.ts.net/proxy", configured)).toEqual(["remote"]);
    expect(routedInstanceIds("not a url", configured)).toEqual([]);
  });
});

describe("parseHubAccounts", () => {
  it("keeps subscription accounts and drops API-key credentials", () => {
    const records = parseHubAccounts({
      observed_at: "2026-10-11T10:00:00Z",
      files: [
        {
          id: "claude-a.json",
          auth_index: "0123456789abcdef",
          name: "claude-a.json",
          provider: "claude",
          label: "a@example.com",
          email: "a@example.com",
          status: "active",
          status_message: "",
          disabled: false,
          unavailable: false,
          success: 12,
          failed: 1,
          recent_requests: [{ time: "09:50-10:00", success: 2, failed: 0 }],
          next_retry_after: "0001-01-01T00:00:00Z",
          cooldowns: [
            {
              scope: "model",
              model_key: "claude-opus",
              reason: "rate_limited",
              retry_at: "2026-10-11T10:05:00Z",
              remaining_seconds: 300,
              http_status: 429,
            },
          ],
        },
        {
          auth_index: "fedcba9876543210",
          provider: "codex",
          email: "b@example.com",
          status: "active",
          id_token: { chatgpt_account_id: "acct_123", plan_type: "Plus" },
        },
        {
          auth_index: "aaaaaaaaaaaaaaaa",
          provider: "claude",
          account_type: "api_key",
          account: "sk-ant-secret-value",
        },
        { auth_index: "0123456789abcdef", provider: "claude" },
        { provider: "claude" },
      ],
    });

    expect(records).toHaveLength(2);
    expect(records[0]).toEqual({
      account: {
        authIndex: "0123456789abcdef",
        provider: "claude",
        name: "claude-a.json",
        email: "a@example.com",
        status: "active",
        disabled: false,
        unavailable: false,
        cooldowns: [
          {
            scope: "model",
            model: "claude-opus",
            reason: "rate_limited",
            retryAt: "2026-10-11T10:05:00.000Z",
            httpStatus: 429,
          },
        ],
        requests: {
          success: 12,
          failed: 1,
          recent: [{ label: "09:50-10:00", success: 2, failed: 0 }],
        },
      },
    });
    expect(records[1]).toMatchObject({
      account: { authIndex: "fedcba9876543210", provider: "codex", name: "fedcba9876543210" },
      chatgptAccountId: "acct_123",
      tokenPlanType: "plus",
    });
    expect(JSON.stringify(records)).not.toContain("sk-ant-secret-value");
  });

  it("takes the latest quota observation as the last use and ignores Go zero times", () => {
    const [observed, unobserved] = parseHubAccounts({
      files: [
        {
          auth_index: "1111111111111111",
          provider: "claude",
          quota: { observed_at: "2026-10-11T09:58:00Z", signals: {} },
          model_quotas: {
            "claude-opus": { observed_at: "2026-10-11T09:59:30Z", signals: {} },
            "claude-haiku": { observed_at: "0001-01-01T00:00:00Z", signals: {} },
          },
        },
        {
          auth_index: "2222222222222222",
          provider: "claude",
          quota: { observed_at: "0001-01-01T00:00:00Z", signals: {} },
        },
      ],
    });
    expect(observed?.account.lastUsedAt).toBe("2026-10-11T09:59:30.000Z");
    expect(unobserved?.account).not.toHaveProperty("lastUsedAt");
  });

  it("keeps long hub text encodable when the cut lands on whitespace", () => {
    // Character 500 is a space, then a newline: a plain cut would end in whitespace.
    for (const separator of [" ", "\n"]) {
      const message = `${"x".repeat(499)}${separator}${"tail ".repeat(40)}`;
      const [record] = parseHubAccounts({
        files: [
          {
            auth_index: "ag",
            provider: "antigravity",
            status: "error",
            status_message: message,
            cooldowns: [{ scope: "model", reason: message }],
          },
        ],
      });
      expect(record?.account.statusMessage).toBe("x".repeat(499));
      const encoded = Schema.encodeUnknownExit(CliProxyReadHubsResult)({
        hubs: [
          {
            hubId: CliProxyHubId.make("home"),
            label: "Home",
            url: "http://127.0.0.1:8317",
            checkedAt: "2026-10-11T12:00:00.000Z",
            status: "error",
            error: describeManagementFailure(500, JSON.stringify({ error: message })),
            accounts: [{ ...record!.account, quota: { status: "unsupported", windows: [] } }],
            apiKeys: [],
            routedInstanceIds: [],
          },
        ],
      });
      expect(Exit.isSuccess(encoded)).toBe(true);
    }
  });

  it("returns nothing for responses without a file list", () => {
    expect(parseHubAccounts({ error: "nope" })).toEqual([]);
    expect(parseHubAccounts(null)).toEqual([]);
  });
});

describe("parseApiKeyUsage", () => {
  it("masks upstream keys and sorts by provider then traffic", () => {
    const usage = parseApiKeyUsage({
      claude: {
        "https://api.anthropic.com|sk-ant-api03-abcdefghijkl1234": {
          success: 3,
          failed: 1,
          recent_requests: [],
        },
        "|sk-ant-api03-zzzzzzzzzzzz9876": { success: 40, failed: 0, recent_requests: [] },
      },
      openrouter: { "https://openrouter.ai/api/v1|short": { success: 1, failed: 0 } },
    });
    expect(usage).toEqual([
      { provider: "claude", keyHint: "…9876", requests: { success: 40, failed: 0, recent: [] } },
      {
        provider: "claude",
        baseUrl: "https://api.anthropic.com",
        keyHint: "…1234",
        requests: { success: 3, failed: 1, recent: [] },
      },
      {
        provider: "openrouter",
        baseUrl: "https://openrouter.ai/api/v1",
        keyHint: "…",
        requests: { success: 1, failed: 0, recent: [] },
      },
    ]);
    expect(JSON.stringify(usage)).not.toContain("sk-ant");
  });

  it("only reveals a suffix of long keys", () => {
    expect(maskApiKey("sk-1234567890ab")).toBe("…90ab");
    expect(maskApiKey("tiny-key")).toBe("…");
  });
});

describe("parseApiCallResult", () => {
  it("reads the passthrough envelope", () => {
    expect(parseApiCallResult({ status_code: 200, header: {}, body: "{}" })).toEqual({
      statusCode: 200,
      body: "{}",
    });
    expect(parseApiCallResult({ error: "invalid body" })).toBeNull();
  });
});

describe("parseCodexUsage", () => {
  const nowMs = Date.parse("2026-10-11T10:00:00Z");

  it("maps primary/secondary and additional limits with their durations", () => {
    const parsed = parseCodexUsage(
      {
        plan_type: "Pro",
        credits: { has_credits: true, unlimited: false, balance: "12.5" },
        rate_limit: {
          allowed: true,
          limit_reached: false,
          primary_window: {
            used_percent: 20,
            limit_window_seconds: 18_000,
            reset_at: 1_791_000_000,
          },
          secondary_window: {
            used_percent: 5,
            limit_window_seconds: 604_800,
            reset_after_seconds: 3600,
          },
        },
        additional_rate_limits: [
          {
            limit_name: "GPT-5.3-Codex-Spark",
            rate_limit: { primary_window: { used_percent: 1, limit_window_seconds: 18_000 } },
          },
        ],
      },
      nowMs,
    );
    expect(parsed).toEqual({
      planType: "pro",
      credits: { unlimited: false, balance: "12.5" },
      windows: [
        { id: "primary", usedPercent: 20, resetsAt: 1_791_000_000, windowDurationMins: 300 },
        {
          id: "secondary",
          usedPercent: 5,
          resetsAt: nowMs / 1000 + 3600,
          windowDurationMins: 10_080,
        },
        {
          id: "gpt-5-3-codex-spark-primary",
          scope: "GPT-5.3-Codex-Spark",
          usedPercent: 1,
          windowDurationMins: 300,
        },
      ],
    });
  });

  it("treats a reached limit without a percent as fully used", () => {
    expect(
      parseCodexUsage(
        { rate_limit: { limit_reached: true, primary_window: { limit_window_seconds: 18_000 } } },
        nowMs,
      )?.windows,
    ).toEqual([{ id: "primary", usedPercent: 100, windowDurationMins: 300 }]);
  });
});

describe("parseAntigravityQuota", () => {
  it("turns remaining fractions into used percent per bucket", () => {
    expect(
      parseAntigravityQuota({
        groups: [
          {
            displayName: "Gemini Pro",
            buckets: [
              {
                bucketId: "pro-5h",
                window: "5h",
                remainingFraction: 0.75,
                resetTime: "2026-10-11T12:00:00Z",
              },
              { displayName: "Daily requests", remainingFraction: "40%" },
              { bucketId: "broken" },
            ],
          },
        ],
      }),
    ).toEqual({
      windows: [
        {
          id: "pro-5h",
          scope: "Gemini Pro",
          usedPercent: 25,
          resetsAt: Date.parse("2026-10-11T12:00:00Z") / 1000,
          windowDurationMins: 300,
        },
        { id: "gemini-pro-bucket-2", scope: "Gemini Pro · Daily requests", usedPercent: 60 },
      ],
    });
    expect(parseAntigravityQuota({})).toBeNull();
  });
});

describe("describeManagementFailure", () => {
  it("explains Cloudflare login redirects and HTML refusals without echoing the page", () => {
    expect(
      describeManagementFailure(302, "", "https://team.cloudflareaccess.com/cdn-cgi/access/login"),
    ).toContain("Service Auth policy");
    expect(describeManagementFailure(403, "<html>Cloudflare Access denied</html>")).toContain(
      "Client ID and Client Secret",
    );
    expect(describeManagementFailure(301, "", "https://other.example")).toContain(
      "does not forward credentials",
    );
  });
  it("explains the common management API failures", () => {
    expect(describeManagementFailure(401, '{"error":"invalid management key"}')).toBe(
      "The hub rejected the management key.",
    );
    expect(describeManagementFailure(403, '{"error":"remote management disabled"}')).toContain(
      "Remote management is disabled",
    );
    expect(describeManagementFailure(404, "")).toContain("no management API");
    expect(describeManagementFailure(500, '{"error":"boom"}')).toBe(
      "The hub returned HTTP 500: boom",
    );
  });
});

describe("managementAuthOutcome", () => {
  it("counts only what the hub's IP ban counts or reports", () => {
    expect(managementAuthOutcome(401, '{"error":"invalid management key"}')).toBe("rejected");
    expect(managementAuthOutcome(401, "<html>Cloudflare Access denied</html>")).toBeUndefined();
    expect(managementAuthOutcome(401, '{"error":"Unauthorized"}')).toBeUndefined();
    expect(
      managementAuthOutcome(
        403,
        '{"error":"IP banned due to too many failed attempts. Try again in 29m58s"}',
      ),
    ).toBe("banned");
    expect(managementAuthOutcome(403, '{"error":"remote management disabled"}')).toBeUndefined();
    expect(managementAuthOutcome(403, '{"error":"remote management key not set"}')).toBeUndefined();
    expect(managementAuthOutcome(500, "{}")).toBeUndefined();
  });
});

describe("hubAuthAddress", () => {
  it("names one counter per host, whatever the path or loopback alias", () => {
    expect(hubAuthAddress("http://127.0.0.1:8317")).toBe("localhost:8317");
    expect(hubAuthAddress("http://[::1]:8317/proxy")).toBe("localhost:8317");
    expect(hubAuthAddress("https://hub.example/a")).toBe(hubAuthAddress("https://hub.example/b"));
  });
});
