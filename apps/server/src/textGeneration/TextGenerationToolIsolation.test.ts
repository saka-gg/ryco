import { delimiter } from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  ClaudeSettings,
  CodexSettings,
  CopilotSettings,
  type ModelSelection,
  ProviderInstanceId,
} from "@ryco/contracts";
import { Effect, FileSystem, Layer, Schema } from "effect";
import { expect } from "vite-plus/test";

import { ServerConfig } from "../config.ts";
import { makeThreadPriorityTestInput } from "../threadPriority/threadPriorityTestFixtures.ts";
import { makeClaudeTextGeneration } from "./ClaudeTextGeneration.ts";
import { makeCodexTextGeneration } from "./CodexTextGeneration.ts";
import { makeCopilotTextGeneration } from "./CopilotTextGeneration.ts";
import { type TextGenerationShape } from "./TextGeneration.ts";

// Commit messages, pull request text and inbox ranking carry repository or forge text in their
// prompts, and Ryco commits, publishes or acts on what comes back, so these calls run without
// tools.

const testLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "ryco-text-tools-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

type CliKind = "codex" | "claude";
type CapturedCall = { readonly args: ReadonlyArray<string>; readonly cwd: string };

const commitOutput = { subject: "Add a greeting", body: "- say hello" };
const pullRequestOutput = { title: "Add a greeting", body: "## Summary\n- say hello" };
const rankingOutput = {
  rankings: [
    { candidateId: "candidate-0001", tier: "now", confidence: "high", reason: "Needs a reply" },
  ],
};

/** A fake CLI that records its arguments and working directory, then answers. */
const makeRecordingCli = (kind: CliKind, output: unknown) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.makeTempDirectoryScoped({ prefix: "ryco-text-tools-cli-" });
    const binary = `${root}/${kind}`;
    const capture = `${root}/calls.jsonl`;
    yield* fs.writeFileString(
      binary,
      [
        `#!${process.execPath}`,
        'const fs = require("node:fs");',
        "const args = process.argv.slice(2);",
        `fs.appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");`,
        kind === "codex"
          ? `fs.writeFileSync(args[args.indexOf("--output-last-message") + 1], ${JSON.stringify(JSON.stringify(output))});`
          : `process.stdout.write(${JSON.stringify(JSON.stringify({ structured_output: output }))});`,
      ].join("\n"),
    );
    yield* fs.chmod(binary, 0o755);
    const calls = fs.readFileString(capture).pipe(
      Effect.map((text) =>
        text
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line) as CapturedCall),
      ),
    );
    return { root, binary, calls };
  });

const configValues = (args: ReadonlyArray<string>) =>
  args.flatMap((arg, index) => (args[index - 1] === "--config" ? [arg] : []));

const generateCommit = (textGeneration: TextGenerationShape, modelSelection: ModelSelection) =>
  textGeneration.generateCommitMessage({
    cwd: process.cwd(),
    branch: "feature/greeting",
    stagedSummary: "M README.md",
    stagedPatch: "diff --git a/README.md b/README.md\n+hello",
    modelSelection,
  });

const generatePullRequest = (textGeneration: TextGenerationShape, modelSelection: ModelSelection) =>
  textGeneration.generatePrContent({
    cwd: process.cwd(),
    baseBranch: "main",
    headBranch: "feature/greeting",
    commitSummary: "Add a greeting",
    diffSummary: "1 file changed",
    diffPatch: "diff --git a/README.md b/README.md\n+hello",
    modelSelection,
  });

/** Every tool-disabling entry, listed here so that dropping one fails a test. */
const CODEX_TOOL_FREE_CONFIG = [
  'web_search="disabled"',
  "mcp_servers={}",
  "features.shell_tool=false",
  "features.view_image=false",
  "features.search_tool=false",
  "features.tool_search=false",
  "features.tool_suggest=false",
  "features.unified_exec=false",
  "features.apply_patch_freeform=false",
  "features.apps=false",
  "features.plugins=false",
  "features.memory_tool=false",
  "features.js_repl=false",
  "features.multi_agent=false",
  "features.goals=false",
  "features.sleep_tool=false",
];

/** Codex keeps the user's config, auth, rules and project docs, but every tool is off. */
const expectCodexToolFree = (call: CapturedCall) => {
  expect(call.cwd).toBe(process.cwd());
  expect(call.args).not.toContain("--ignore-user-config");
  expect(call.args).not.toContain("--ignore-rules");
  const config = configValues(call.args);
  expect(config).toEqual(expect.arrayContaining(CODEX_TOOL_FREE_CONFIG));
  expect(config).not.toContain("project_doc_max_bytes=0");
  expect(call.args[call.args.indexOf("-s") + 1]).toBe("read-only");
};

/** Claude keeps the user's settings (and CLAUDE.md), without tools or MCP servers. */
const expectClaudeToolFree = (call: CapturedCall) => {
  expect(call.cwd).toBe(process.cwd());
  expect(call.args[call.args.indexOf("--tools") + 1]).toBe("");
  expect(call.args).toContain("--strict-mcp-config");
  expect(call.args[call.args.indexOf("--mcp-config") + 1]).toBe('{"mcpServers":{}}');
  expect(call.args).not.toContain("--dangerously-skip-permissions");
  expect(call.args).not.toContain("--setting-sources");
};

const codexSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4-mini",
};
const claudeSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-sonnet-4-6",
};

it.layer(testLayer)("text generation without tools", (it) => {
  it.effect("Codex writes commit messages and pull request text without tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commitCli = yield* makeRecordingCli("codex", commitOutput);
        const commitText = yield* makeCodexTextGeneration(
          Schema.decodeSync(CodexSettings)({ binaryPath: commitCli.binary }),
        );
        expect((yield* generateCommit(commitText, codexSelection)).subject).toBe("Add a greeting");

        const pullRequestCli = yield* makeRecordingCli("codex", pullRequestOutput);
        const pullRequestText = yield* makeCodexTextGeneration(
          Schema.decodeSync(CodexSettings)({ binaryPath: pullRequestCli.binary }),
        );
        expect((yield* generatePullRequest(pullRequestText, codexSelection)).title).toBe(
          "Add a greeting",
        );

        for (const call of [...(yield* commitCli.calls), ...(yield* pullRequestCli.calls)]) {
          expectCodexToolFree(call);
        }
      }),
    ),
  );

  it.effect("Claude writes commit messages and pull request text without tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commitCli = yield* makeRecordingCli("claude", commitOutput);
        const commitText = yield* makeClaudeTextGeneration(
          Schema.decodeSync(ClaudeSettings)({ binaryPath: commitCli.binary }),
        );
        expect((yield* generateCommit(commitText, claudeSelection)).subject).toBe("Add a greeting");

        const pullRequestCli = yield* makeRecordingCli("claude", pullRequestOutput);
        const pullRequestText = yield* makeClaudeTextGeneration(
          Schema.decodeSync(ClaudeSettings)({ binaryPath: pullRequestCli.binary }),
        );
        expect((yield* generatePullRequest(pullRequestText, claudeSelection)).title).toBe(
          "Add a greeting",
        );

        for (const call of [...(yield* commitCli.calls), ...(yield* pullRequestCli.calls)]) {
          expectClaudeToolFree(call);
        }
      }),
    ),
  );

  it.effect("GitHub Copilot hands commit messages to Codex without tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codexCli = yield* makeRecordingCli("codex", commitOutput);
        // Copilot's Codex fallback runs `codex` from PATH.
        const textGeneration = yield* makeCopilotTextGeneration(
          Schema.decodeSync(CopilotSettings)({}),
          { ...process.env, PATH: `${codexCli.root}${delimiter}${process.env.PATH ?? ""}` },
        );
        yield* generateCommit(textGeneration, {
          instanceId: ProviderInstanceId.make("copilot"),
          model: "gpt-5.4-mini",
        });

        const calls = yield* codexCli.calls;
        expect(calls).toHaveLength(1);
        expectCodexToolFree(calls[0]!);
      }),
    ),
  );

  it.effect("Codex and Claude rank inbox threads without tools", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const codexCli = yield* makeRecordingCli("codex", rankingOutput);
        const codexText = yield* makeCodexTextGeneration(
          Schema.decodeSync(CodexSettings)({ binaryPath: codexCli.binary }),
        );
        const codexRanking = yield* codexText.rankInboxThreads(
          makeThreadPriorityTestInput(codexSelection.instanceId, codexSelection.model),
        );
        expect(codexRanking.rankings).toMatchObject([{ threadId: "thread-priority-test" }]);

        const claudeCli = yield* makeRecordingCli("claude", rankingOutput);
        const claudeText = yield* makeClaudeTextGeneration(
          Schema.decodeSync(ClaudeSettings)({ binaryPath: claudeCli.binary }),
        );
        yield* claudeText.rankInboxThreads(
          makeThreadPriorityTestInput(claudeSelection.instanceId, claudeSelection.model),
        );

        for (const call of yield* codexCli.calls) expectCodexToolFree(call);
        for (const call of yield* claudeCli.calls) expectClaudeToolFree(call);
      }),
    ),
  );
});
