import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RuntimeConnection } from "@github/copilot-sdk";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  type AgentProcessPriorityShape,
  makeAgentProcessPriority,
} from "../agentProcessPriority.ts";
import {
  DEFAULT_BINARY_PATH,
  makeCopilotClientOptions,
  normalizeUsage,
  resolveCopilotCliPath,
  withCopilotAgentPriority,
} from "./CopilotAdapter.types.ts";

// Probes, session starts and text generation must not search PATH synchronously: a stalled mount
// on PATH would block the event loop.
vi.mock("@ryco/shared/shell", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@ryco/shared/shell")>()),
  resolveCommandPath: () => {
    throw new Error("synchronous PATH search");
  },
}));

describe("resolveCopilotCliPath", () => {
  it("resolves the default copilot command from PATH", async () => {
    const root = mkdtempSync(join(tmpdir(), "copilot-cli-path-"));
    const binDir = join(root, "bin");
    const copilotPath = join(binDir, "copilot");

    try {
      mkdirSync(binDir, { recursive: true });
      writeFileSync(copilotPath, "#!/bin/sh\n", { encoding: "utf8", mode: 0o755 });

      expect(
        await resolveCopilotCliPath({ binaryPath: DEFAULT_BINARY_PATH }, { PATH: binDir }),
      ).toBe(copilotPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps the default command name when copilot is not on PATH", async () => {
    expect(await resolveCopilotCliPath({ binaryPath: DEFAULT_BINARY_PATH }, { PATH: "" })).toBe(
      DEFAULT_BINARY_PATH,
    );
  });
});

describe("makeCopilotClientOptions", () => {
  it("maps Ryco's binary, environment, and cwd settings to the Copilot v1 transport", async () => {
    const environment = { PATH: "/usr/bin", COPILOT_TOKEN: "token" };

    expect(
      await makeCopilotClientOptions(
        { binaryPath: "/opt/copilot/bin/copilot" },
        environment,
        "/repo",
      ),
    ).toEqual({
      connection: {
        kind: "stdio",
        path: "/opt/copilot/bin/copilot",
      },
      workingDirectory: "/repo",
      env: environment,
      logLevel: "error",
    });
  });
});

describe("normalizeUsage", () => {
  it("treats cached reads as a discounted subset of input tokens", () => {
    const usage = normalizeUsage({
      type: "assistant.usage",
      timestamp: "2026-06-10T00:00:00.000Z",
      data: {
        inputTokens: 100,
        cacheReadTokens: 25,
        outputTokens: 10,
        reasoningTokens: 5,
      },
    } as never);

    expect(usage).toMatchObject({
      usedTokens: 135,
      totalProcessedTokens: 135,
      inputTokens: 125,
      cachedInputTokens: 25,
      outputTokens: 10,
      reasoningOutputTokens: 5,
      lastInputTokens: 125,
      lastCachedInputTokens: 25,
      lastOutputTokens: 10,
      lastReasoningOutputTokens: 5,
    });
  });
});

describe("withCopilotAgentPriority", () => {
  const facts = (platform: NodeJS.Platform) =>
    makeAgentProcessPriority({
      enabled: Effect.succeed(true),
      platform,
      niceExecutable: () => "/usr/bin/nice",
      commandResolves: async () => true,
      lowerChild: () => "lowered",
    });
  const stdioOptions = (connection: Parameters<typeof RuntimeConnection.forStdio>[0]) => ({
    connection: RuntimeConnection.forStdio(connection),
    workingDirectory: "/tmp",
    env: { PATH: "/opt/bin" },
    logLevel: "error" as const,
  });
  const apply = (
    priority: AgentProcessPriorityShape | undefined,
    options: ReturnType<typeof stdioOptions> | { readonly connection: RuntimeConnection },
  ) => Effect.runPromise(withCopilotAgentPriority(priority, options));

  it("runs a native Copilot CLI through nice, ahead of the SDK's own arguments", async () => {
    const options = stdioOptions({ path: "/opt/bin/copilot" });
    const lowered = await apply(facts("linux"), options);
    expect(lowered.connection).toMatchObject({
      kind: "stdio",
      path: "/usr/bin/nice",
      args: ["-n", "5", "/opt/bin/copilot"],
    });
    expect(lowered.workingDirectory).toBe("/tmp");
    expect(lowered.env).toBe(options.env);
  });

  it("leaves every case it cannot lower unchanged", async () => {
    const native = stdioOptions({ path: "/opt/bin/copilot" });
    expect(await apply(undefined, native)).toBe(native);
    expect(await apply(facts("win32"), native)).toBe(native);
    const js = stdioOptions({ path: "/opt/copilot/index.js" });
    expect(await apply(facts("linux"), js)).toBe(js);
    const withArgs = stdioOptions({ path: "/opt/bin/copilot", args: ["--verbose"] });
    expect(await apply(facts("linux"), withArgs)).toBe(withArgs);
    const bundled = stdioOptions({});
    expect(await apply(facts("linux"), bundled)).toBe(bundled);
    const tcp = { connection: RuntimeConnection.forTcp({ path: "/opt/bin/copilot" }) };
    expect(await apply(facts("linux"), tcp)).toBe(tcp);
  });
});
