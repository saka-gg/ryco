import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ClaudeSettings } from "@ryco/contracts";
import { Duration, Effect, Schema } from "effect";

const mocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  writeFile: vi.fn(),
  mkdir: vi.fn(),
  execFile: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("node:fs/promises", async (original) => ({
  ...(await original<typeof import("node:fs/promises")>()),
  readFile: mocks.readFile,
  writeFile: mocks.writeFile,
  mkdir: mocks.mkdir,
}));
vi.mock("node:child_process", async (original) => ({
  ...(await original<typeof import("node:child_process")>()),
  execFile: mocks.execFile,
}));
import { checkClaudeProviderStatus } from "./ClaudeProvider.ts";
import {
  type ClaudeLoginAccount,
  makeCachedClaudeUsageProbe,
  probeClaudeUsageRateLimits,
  resolveClaudeLoginStore,
} from "./ClaudeUsage.ts";

const credentials = (token: string, expired = false) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: "mock-refresh",
      expiresAt: expired ? 1 : Date.now() + 3_600_000,
    },
  });
// The account Claude Code reports at initialization; by default, its claude.ai login in use.
const claudeAccount = (
  account: Partial<ClaudeLoginAccount> = { subscriptionType: "Claude Max" },
) => ({
  email: undefined,
  subscriptionType: account.subscriptionType,
  tokenSource: account.tokenSource,
  slashCommands: [],
});
const probe = (environment: NodeJS.ProcessEnv) => {
  const store = resolveClaudeLoginStore(
    { USER: "mock-user", ...environment },
    claudeAccount(),
    "/mock/default",
  );
  if (!store) throw new Error("Expected a local Claude login store.");
  return Effect.runPromise(probeClaudeUsageRateLimits(store, null));
};
// The test runtime's own binary stands in for the Claude CLI's version check.
const checkStatus = (environment: NodeJS.ProcessEnv, account = claudeAccount()) =>
  Effect.gen(function* () {
    return yield* checkClaudeProviderStatus(
      { ...Schema.decodeSync(ClaudeSettings)({}), binaryPath: process.execPath },
      () => Effect.succeed(account),
      environment,
      yield* makeCachedClaudeUsageProbe(Duration.minutes(1)),
    );
  }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);
const keychainCalls = () =>
  mocks.execFile.mock.calls.map(([, args]) => (args as ReadonlyArray<string>).join(" "));

describe("Claude usage credential isolation", () => {
  beforeEach(() => {
    vi.stubGlobal("process", { ...process, platform: "darwin" });
    vi.stubGlobal("fetch", mocks.fetch);
    mocks.execFile.mockImplementation((_file, args, _options, callback) =>
      callback(null, args[0] === "find-generic-password" ? credentials("mock-default") : ""),
    );
    mocks.readFile.mockResolvedValue(credentials("mock-separate"));
    mocks.writeFile.mockResolvedValue(undefined);
    mocks.mkdir.mockResolvedValue(undefined);
    mocks.fetch.mockImplementation(
      async () => new Response(JSON.stringify({ five_hour: { utilization: 42 } })),
    );
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("uses only the separate home's file even when a global Keychain account exists", async () => {
    expect((await probe({ HOME: "/mock/separate" }))?.primary?.usedPercent).toBe(42);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.readFile).toHaveBeenCalledWith("/mock/separate/.claude/.credentials.json", "utf8");
    expect(mocks.fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer mock-separate");
  });
  it("does not fall back to the default account when a separate home is missing credentials", async () => {
    mocks.readFile.mockRejectedValue(new Error("missing"));
    expect(await probe({ HOME: "/mock/separate" })).toBeUndefined();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("preserves default-home Keychain selection", async () => {
    await probe({ HOME: "/mock/default" });
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(keychainCalls()).toEqual([
      "find-generic-password -a mock-user -s Claude Code-credentials -w",
    ]);
    expect(mocks.fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer mock-default");
  });
  it("reads a configuration directory's own Keychain item, then its own file", async () => {
    mocks.execFile.mockImplementation((_file, _args, _options, callback) => callback(null, ""));
    await probe({ HOME: "/mock/default", CLAUDE_CONFIG_DIR: "/mock/config" });
    expect(keychainCalls()).toEqual([
      "find-generic-password -a mock-user -s Claude Code-credentials-64555ad4 -w",
    ]);
    expect(mocks.readFile).toHaveBeenCalledWith("/mock/config/.credentials.json", "utf8");
    expect(mocks.fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer mock-separate");
  });
  it("does not fall back to the OS home's account when the environment home has no credentials", async () => {
    mocks.readFile.mockRejectedValue(new Error("missing"));
    expect(await probe({ HOME: "/mock/environment" })).toBeUndefined();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("never refreshes an expired token or writes either credential store", async () => {
    mocks.readFile.mockResolvedValue(credentials("mock-separate", true));
    expect(await probe({ HOME: "/mock/separate" })).toBeUndefined();
    mocks.execFile.mockImplementation((_file, args, _options, callback) =>
      callback(null, args[0] === "find-generic-password" ? credentials("mock-default", true) : ""),
    );
    expect(await probe({ HOME: "/mock/default" })).toBeUndefined();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    // Only the Keychain read ran; nothing was deleted or added.
    expect(mocks.execFile).toHaveBeenCalledTimes(1);
    expect(mocks.execFile.mock.calls[0]?.[1]?.[0]).toBe("find-generic-password");
  });
  it("does not refresh and retry when the usage API rejects the token", async () => {
    mocks.fetch.mockResolvedValue(new Response("", { status: 429 }));
    expect(await probe({ HOME: "/mock/separate" })).toBeUndefined();
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.writeFile).not.toHaveBeenCalled();
  });

  it("serves cached usage only for the credential store it was read from", async () => {
    const separate = { credentialsPath: "/mock/separate/.credentials.json", keychain: undefined };
    const config = { credentialsPath: "/mock/config/.credentials.json", keychain: undefined };
    await Effect.gen(function* () {
      const probeUsage = yield* makeCachedClaudeUsageProbe(Duration.minutes(1));
      yield* probeUsage(separate, null);
      yield* probeUsage({ ...separate }, null);
      yield* probeUsage(config, null);
    }).pipe(Effect.runPromise);
    expect(mocks.readFile.mock.calls.map(([path]) => path)).toEqual([
      separate.credentialsPath,
      config.credentialsPath,
    ]);
  });
  it("never reads credentials for an instance routed through a proxy", async () => {
    const status = await checkStatus(
      {
        ANTHROPIC_BASE_URL: "http://127.0.0.1:8317",
        ANTHROPIC_AUTH_TOKEN: "proxy-token",
        ANTHROPIC_API_KEY: "",
      },
      claudeAccount({ tokenSource: "ANTHROPIC_AUTH_TOKEN" }),
    );
    expect(status.status).toBe("ready");
    expect(status.rateLimits).toBeUndefined();
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("reads only the store of the instance's own HOME and configuration directory", async () => {
    const status = await checkStatus({ HOME: "/mock/separate" });
    expect(status.rateLimits?.primary?.usedPercent).toBe(42);
    await checkStatus({ HOME: "/mock/separate", CLAUDE_CONFIG_DIR: "/mock/config" });
    expect(mocks.readFile.mock.calls.map(([path]) => path)).toEqual([
      "/mock/separate/.claude/.credentials.json",
      "/mock/config/.credentials.json",
    ]);
    expect(mocks.execFile).not.toHaveBeenCalled();
  });
});
