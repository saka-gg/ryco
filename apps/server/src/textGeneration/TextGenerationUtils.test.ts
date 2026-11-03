import { describe, expect, it } from "vitest";

import { cliFailureDetail } from "./TextGenerationUtils.ts";

const prompt = [
  "You write concise git commit messages.",
  "Branch: main",
  "Staged patch:",
  "diff --git a/src/app.ts b/src/app.ts",
  "-  return `Hello, ${name}!`;",
  "+  return `Hi there, ${name}!`;",
].join("\n");

describe("cliFailureDetail", () => {
  it("drops the echoed prompt and keeps the last error lines", () => {
    const stderr = [
      "OpenAI Codex v0.160.0",
      "--------",
      "workdir: /data/workspace/scratch",
      "model: gpt-5.6-luna",
      "--------",
      "user",
      ...prompt.split("\n"),
      "2026-10-28T04:05:14.860254Z ERROR codex_api::endpoint: failed to connect to websocket: HTTP error: 401 Unauthorized",
      "ERROR: Reconnecting... 5/5",
      "\u001b[31mERROR:\u001b[0m unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    ].join("\n");

    const detail = cliFailureDetail("codex", { stdout: "", stderr, exitCode: 1, prompt });

    expect(detail).toBe(
      "Codex CLI command failed: ERROR: Reconnecting... 5/5 ERROR: unexpected status 401 Unauthorized: Missing bearer or basic authentication in header",
    );
    for (const line of prompt.split("\n")) expect(detail).not.toContain(line);
  });

  it("falls back to stdout, then to the exit code", () => {
    expect(
      cliFailureDetail("claude", { stdout: "Not logged in", stderr: "", exitCode: 1, prompt }),
    ).toBe("Claude CLI command failed: Not logged in");
    expect(
      cliFailureDetail("claude", { stdout: prompt, stderr: "  \n", exitCode: 2, prompt }),
    ).toBe("Claude CLI command failed with code 2.");
  });

  it("bounds a long detail", () => {
    const detail = cliFailureDetail("codex", {
      stdout: "",
      stderr: `error: ${"x".repeat(2_000)}`,
      exitCode: 1,
      prompt,
    });
    expect(detail.length).toBeLessThan(450);
    expect(detail.endsWith("…")).toBe(true);
  });
});
