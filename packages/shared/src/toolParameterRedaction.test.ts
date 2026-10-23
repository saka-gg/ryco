import { describe, expect, it } from "vite-plus/test";
import {
  isToolParameterCredentialKey,
  redactToolParameterCredentials,
} from "./toolParameterRedaction.ts";

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const entry of Object.values(value)) deepFreeze(entry);
    Object.freeze(value);
  }
  return value;
}

describe("tool parameter credential keys", () => {
  it.each([
    "token",
    "apiKey",
    "api_key",
    "api-key",
    "apiKeys",
    "OPENAI_API_KEY",
    "STRIPE_KEY",
    "GITHUB_TOKEN",
    "Authorization",
    "Proxy-Authorization",
    "X-Api-Key",
    "X-Auth-Token",
    "PRIVATE-TOKEN",
    "Cookie",
    "Set-Cookie",
    "cookies",
    "password",
    "newPassword",
    "password_confirmation",
    "passwd",
    "passWord",
    "PassWd",
    "passphrase",
    "secret",
    "secrets",
    "clientSecret",
    "client_secret",
    "accessToken",
    "refresh_token",
    "id_token",
    "privateKey",
    "aws_secret_access_key",
    "accessTokens",
    "refresh_tokens",
    "id_tokens",
    "oauth_tokens",
    "privateKeys",
    "access_keys",
    "secretKeys",
    "bearer",
    "bearerToken",
    "credentials",
    "auth",
  ])("treats %s as a credential", (key) => {
    expect(isToolParameterCredentialKey(key)).toBe(true);
  });

  it.each([
    "session",
    "sessionId",
    "email",
    "ticket",
    "jira_ticket",
    "proof",
    "pageToken",
    "nextPageToken",
    "NextToken",
    "continuation_token",
    "max_tokens",
    "maxTokens",
    "input_tokens",
    "valid_tokens",
    "tokens",
    "token_count",
    "tokenizer",
    "key",
    "cache_key",
    "keyboard",
    "public_key",
    "PWD",
    "author",
    "oauth",
    "path",
    "command",
    "description",
  ])("keeps %s as an ordinary parameter", (key) => {
    expect(isToolParameterCredentialKey(key)).toBe(false);
  });
});

describe("tool parameter credential redaction", () => {
  it("hides credentials in nested objects and arrays", () => {
    expect(
      redactToolParameterCredentials({
        repo: "ryco",
        token: "ghp_live",
        options: { clientSecret: "live-secret", dryRun: true, deeper: { api_key: "k" } },
        servers: [
          { name: "a", accessToken: "t1" },
          { name: "b", accessToken: "t2" },
        ],
        max_tokens: 5,
      }),
    ).toEqual({
      repo: "ryco",
      token: "[redacted]",
      options: { clientSecret: "[redacted]", dryRun: true, deeper: { api_key: "[redacted]" } },
      servers: [
        { name: "a", accessToken: "[redacted]" },
        { name: "b", accessToken: "[redacted]" },
      ],
      max_tokens: 5,
    });
  });

  it("hides header values in header maps and name/value pairs", () => {
    expect(
      redactToolParameterCredentials({
        url: "https://api.example.com",
        headers: {
          Authorization: "Bearer live-secret",
          "X-Api-Key": "live-key",
          Cookie: "a=1; b=2",
          Accept: "application/json",
        },
        headerList: [
          { name: "Authorization", value: "Basic live-secret" },
          { key: "x-api-key", value: "live-key" },
          { name: "Accept", value: "application/json" },
        ],
      }),
    ).toEqual({
      url: "https://api.example.com",
      headers: {
        Authorization: "[redacted]",
        "X-Api-Key": "[redacted]",
        Cookie: "[redacted]",
        Accept: "application/json",
      },
      headerList: [
        { name: "Authorization", value: "[redacted]" },
        { key: "x-api-key", value: "[redacted]" },
        { name: "Accept", value: "application/json" },
      ],
    });
  });

  it("hides a credential-named value whole, whatever its shape", () => {
    expect(
      redactToolParameterCredentials({
        credentials: { username: "alice", password: "live-secret" },
        secrets: ["a", "b"],
        password: 123456,
      }),
    ).toEqual({ credentials: "[redacted]", secrets: "[redacted]", password: "[redacted]" });
  });

  it("keeps flags and empty values, which hold no credential", () => {
    const input = { use_token: true, password: "", token: null, refresh_token: undefined };
    expect(redactToolParameterCredentials(input)).toBe(input);
  });

  it("hides credentials in structured parameter strings", () => {
    expect(
      redactToolParameterCredentials({
        headers: '{"Authorization":"Bearer live-secret","Accept":"application/json"}',
        options: '[{"name":"deploy","apiKey":"live-key"}]',
        config: '{ "dryRun": true }',
        body: JSON.stringify({ payload: JSON.stringify({ password: "live-secret" }) }),
      }),
    ).toEqual({
      headers: '{"Authorization":"[redacted]","Accept":"application/json"}',
      options: '[{"name":"deploy","apiKey":"[redacted]"}]',
      config: '{ "dryRun": true }',
      body: JSON.stringify({ payload: JSON.stringify({ password: "[redacted]" }) }),
    });
  });

  it("keeps the layout of a pretty-printed structured string", () => {
    const content = '\n{\n\t"name": "app",\n\t"auth": {\n\t\t"token": "live-secret"\n\t}\n}\n';
    expect(redactToolParameterCredentials({ content })).toEqual({
      content: '\n{\n\t"name": "app",\n\t"auth": "[redacted]"\n}\n',
    });
  });

  it("leaves commands and other strings as they are", () => {
    const input = {
      command: "curl -H 'Authorization: Bearer live-secret' https://api.example.com",
      cmd: ["curl", "-H", "Authorization: Bearer live-secret"],
      description: "token=live-secret",
      notJson: '{"token": "live-secret"',
    };
    expect(redactToolParameterCredentials(input)).toBe(input);
    expect(redactToolParameterCredentials('{"command":"echo","token":"live-secret"}')).toBe(
      '{"command":"echo","token":"[redacted]"}',
    );
    expect(redactToolParameterCredentials("Bash: export TOKEN=live-secret")).toBe(
      "Bash: export TOKEN=live-secret",
    );
  });

  it("returns new values and never mutates its argument", () => {
    const input = deepFreeze({
      toolName: "mcp__http__fetch",
      input: {
        url: "https://api.example.com",
        headers: { Authorization: "Bearer live-secret" },
        body: '{"apiKey":"live-key"}',
      },
    });
    const snapshot = structuredClone(input);

    const redacted = redactToolParameterCredentials(input);

    expect(input).toEqual(snapshot);
    expect(JSON.stringify(redacted)).not.toMatch(/live-secret|live-key/u);
    expect(redactToolParameterCredentials(redacted)).toEqual(redacted);
  });

  it("keeps a __proto__ key as data", () => {
    const input = JSON.parse('{"__proto__":{"token":"live-secret"},"name":"x"}') as object;
    const redacted = redactToolParameterCredentials(input) as Record<string, unknown>;

    expect(Object.getPrototypeOf(redacted)).toBe(Object.prototype);
    expect(Object.keys(redacted)).toEqual(["__proto__", "name"]);
    expect(JSON.stringify(redacted)).toBe('{"__proto__":{"token":"[redacted]"},"name":"x"}');
  });

  it("hides what nests deeper than its bound instead of overflowing", () => {
    let input: Record<string, unknown> = { token: "live-secret" };
    for (let depth = 0; depth < 10_000; depth += 1) input = { nested: input };

    expect(JSON.stringify(redactToolParameterCredentials(input))).not.toContain("live-secret");
  });
});
