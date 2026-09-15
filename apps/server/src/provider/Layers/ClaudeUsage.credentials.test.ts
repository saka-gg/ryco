import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as NodeServices from "@effect/platform-node/NodeServices";

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
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => "/mock/default",
}));
import { probeClaudeUsageRateLimits } from "./ClaudeUsage.ts";

const credentials = (token: string, expired = false) =>
  JSON.stringify({
    claudeAiOauth: {
      accessToken: token,
      refreshToken: "mock-refresh",
      expiresAt: expired ? 1 : Date.now() + 3_600_000,
    },
  });
const probe = (homePath: string) =>
  Effect.runPromise(
    probeClaudeUsageRateLimits({
      enabled: true,
      binaryPath: "claude",
      customModels: [],
      launchArgs: "",
      homePath,
    }).pipe(Effect.provide(NodeServices.layer)),
  );

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
    mocks.fetch.mockResolvedValue(new Response(JSON.stringify({ five_hour: { utilization: 42 } })));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetAllMocks();
  });

  it("uses only the separate home's file even when a global Keychain account exists", async () => {
    expect((await probe("/mock/separate"))?.primary?.usedPercent).toBe(42);
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.readFile).toHaveBeenCalledWith("/mock/separate/.claude/.credentials.json", "utf8");
    expect(mocks.fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer mock-separate");
  });
  it("does not fall back to the default account when a separate home is missing credentials", async () => {
    mocks.readFile.mockRejectedValue(new Error("missing"));
    expect(await probe("/mock/separate")).toBeUndefined();
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
  it("preserves default-home Keychain selection", async () => {
    await probe("");
    expect(mocks.readFile).not.toHaveBeenCalled();
    expect(mocks.fetch.mock.calls[0]?.[1].headers.Authorization).toBe("Bearer mock-default");
  });
  it("persists a separate-home refresh only to that home's file", async () => {
    mocks.readFile.mockResolvedValue(credentials("mock-separate", true));
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "mock-renewed", expires_in: 3600 })),
    );
    await probe("/mock/separate");
    expect(mocks.execFile).not.toHaveBeenCalled();
    expect(mocks.writeFile.mock.calls[0]?.[0]).toBe("/mock/separate/.claude/.credentials.json");
    expect(mocks.fetch.mock.calls[1]?.[1].headers.Authorization).toBe("Bearer mock-renewed");
  });
  it("does not copy a refreshed Keychain account into a file", async () => {
    mocks.execFile.mockImplementation((_file, args, _options, callback) =>
      callback(null, args[0] === "find-generic-password" ? credentials("mock-default", true) : ""),
    );
    mocks.fetch.mockResolvedValueOnce(
      new Response(JSON.stringify({ access_token: "mock-renewed", expires_in: 3600 })),
    );
    await probe("");
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.execFile).toHaveBeenCalledTimes(3);
  });
});
