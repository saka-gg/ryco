#!/usr/bin/env bun
/**
 * Device routing eval runner. Not part of CI: it calls a model.
 *
 *   bun evals/device-routing/run.ts [--case ID[,ID]] [--model claude-haiku-5-5]
 *     [--max-turns N] [--claude-path /path/to/claude] [--list]
 *
 * Each case runs one Claude Agent SDK `query()` in its own scripted world
 * (`world.ts`): Ryco's real device tool gateway over a fake iPhone, a temp
 * repo with the case's files as cwd, and a PreToolUse hook that answers every
 * Bash call with a simulated result so nothing runs on this machine. The SDK
 * uses the existing Claude Code login (or the ANTHROPIC_* environment).
 *
 * Results go to evals/device-routing/out/<timestamp>/ as results.json,
 * transcripts/<case>.json and summary.txt.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import * as path from "node:path";

// The SDK is a server dependency: load the server's copy (the version Ryco runs), never one a
// parent directory's node_modules might hold.
import type * as ClaudeAgentSdk from "../../apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";
import type {
  HookCallback,
  Options,
  SDKMessage,
} from "../../apps/server/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts";

import { ACME_APP, CASES, type EvalCase } from "./cases.ts";
import { gradeTranscript, type Grade, type RecordedToolCall, type Transcript } from "./grading.ts";
import { simulateShell, simulatedCommand, type ShellRecord } from "./shell.ts";
import { createWorld } from "./world.ts";

const HERE = import.meta.dirname;
const serverRequire = createRequire(new URL("../../apps/server/package.json", import.meta.url));
const { query } = (await import(
  serverRequire.resolve("@anthropic-ai/claude-agent-sdk")
)) as typeof ClaudeAgentSdk;
const DEFAULT_MODEL = "claude-haiku-5-5";
const DEFAULT_MAX_TURNS = 14;
const CASE_TIMEOUT_MS = 5 * 60_000;

interface Args {
  readonly cases: readonly string[];
  readonly model: string;
  readonly maxTurns: number | null;
  readonly claudePath: string | null;
  readonly list: boolean;
}

function parseArgs(argv: readonly string[]): Args {
  const cases: string[] = [];
  let model = DEFAULT_MODEL;
  let maxTurns: number | null = null;
  let claudePath: string | null = null;
  let list = false;
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i];
    const value = () => {
      const next = argv[++i];
      if (next === undefined) throw new Error(`${flag} needs a value`);
      return next;
    };
    if (flag === "--case" || flag === "--cases") cases.push(...value().split(","));
    else if (flag === "--model") model = value();
    else if (flag === "--max-turns") maxTurns = Number(value());
    else if (flag === "--claude-path") claudePath = value();
    else if (flag === "--list") list = true;
    else throw new Error(`Unknown flag ${flag}`);
  }
  return { cases, model, maxTurns, claudePath, list };
}

/** The routing block Ryco appends to real sessions, when the server has it. */
async function loadRoutingInstructions(): Promise<{ text: string | null; source: string }> {
  try {
    const module =
      (await import("../../apps/server/src/providerTools/deviceToolRouting.ts")) as Record<
        string,
        unknown
      >;
    if (typeof module.DEVICE_ROUTING_INSTRUCTIONS === "string") {
      return { text: module.DEVICE_ROUTING_INSTRUCTIONS, source: "deviceToolRouting.ts" };
    }
    return { text: null, source: "deviceToolRouting.ts has no DEVICE_ROUTING_INSTRUCTIONS" };
  } catch {
    return { text: null, source: "none (deviceToolRouting.ts not found)" };
  }
}

/** The parent session's variables, without the ones that would make Claude Code think it is nested. */
function childEnvironment(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (key === "CLAUDECODE" || key === "CLAUDE_PID" || key === "CLAUDE_EFFORT") continue;
    if (key.startsWith("CLAUDE_CODE_") && key !== "CLAUDE_CODE_OAUTH_TOKEN") continue;
    if (key.startsWith("RYCO_")) continue;
    env[key] = value;
  }
  env.CLAUDE_AGENT_SDK_CLIENT_APP = "ryco-device-routing-eval/1";
  return env;
}

const inside = (file: unknown, cwd: string) =>
  typeof file === "string" && path.resolve(cwd, file).startsWith(`${cwd}${path.sep}`);

interface CaseResult {
  readonly id: string;
  readonly checks: string;
  readonly grade: Grade;
  readonly turns: number;
  readonly subtype: string;
  readonly costUsd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly cacheReadTokens: number;
  readonly cacheWriteTokens: number;
  readonly durationMs: number;
  readonly deviceTools: readonly string[];
  readonly refusalSource: string | null;
  readonly error?: string | undefined;
}

async function runCase(
  evalCase: EvalCase,
  args: Args,
  routing: string | null,
  outDir: string,
): Promise<CaseResult> {
  const world = await createWorld(evalCase, ACME_APP);
  const calls = new Map<string, RecordedToolCall & { result?: string; isError?: boolean }>();
  const order: string[] = [];
  const texts: string[] = [];
  const shell: ShellRecord[] = [];
  const denials: string[] = [];
  const messages: SDKMessage[] = [];
  let finalText = "";
  let subtype = "none";
  let turns = 0;
  let costUsd = 0;
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  let deviceTools: string[] = [];
  let error: string | undefined;
  const started = Date.now();

  const record = (id: string, name: string, input: Record<string, unknown>, agentId?: string) => {
    const existing = calls.get(id);
    if (existing) {
      if (agentId !== undefined && existing.agentId === undefined)
        calls.set(id, { ...existing, agentId });
      return;
    }
    calls.set(id, { id, name, input, ...(agentId === undefined ? {} : { agentId }) });
    order.push(id);
  };

  const deny = (reason: string) => {
    denials.push(reason);
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: reason,
      },
    };
  };
  const allow = (updatedInput?: Record<string, unknown>) => ({
    hookSpecificOutput: {
      hookEventName: "PreToolUse" as const,
      permissionDecision: "allow" as const,
      ...(updatedInput === undefined ? {} : { updatedInput }),
    },
  });

  // Every tool call, the main thread's and every subagent's, passes here first.
  const preToolUse: HookCallback = async (input) => {
    if (input.hook_event_name !== "PreToolUse") return {};
    const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
    record(input.tool_use_id, input.tool_name, toolInput, input.agent_id);
    const cwd = world.cwd;
    switch (input.tool_name) {
      case "Bash": {
        const command = typeof toolInput.command === "string" ? toolInput.command : "";
        const simulated = simulateShell(command, cwd, evalCase.shell ?? []);
        shell.push(simulated);
        if (simulated.mode === "read-only")
          return allow({ ...toolInput, run_in_background: false });
        return allow({
          ...toolInput,
          command: simulatedCommand(simulated),
          run_in_background: false,
        });
      }
      case "Read":
      case "Write":
      case "Edit":
      case "NotebookEdit": {
        const file = toolInput.file_path ?? toolInput.notebook_path;
        return inside(file, cwd) ? allow() : deny("That path is outside this workspace.");
      }
      case "Glob":
      case "Grep": {
        const target = toolInput.path;
        return target === undefined || inside(target, cwd) || target === cwd
          ? allow()
          : deny("That path is outside this workspace.");
      }
      case "WebFetch":
      case "WebSearch":
        return deny("Network access is off in this workspace.");
      default:
        return allow();
    }
  };
  const postToolUse: HookCallback = async (input) => {
    if (input.hook_event_name === "PostToolUse") {
      const call = calls.get(input.tool_use_id);
      if (call && call.result === undefined)
        calls.set(input.tool_use_id, { ...call, result: stringify(input.tool_response) });
    } else if (input.hook_event_name === "PostToolUseFailure") {
      const call = calls.get(input.tool_use_id);
      if (call) calls.set(input.tool_use_id, { ...call, result: input.error, isError: true });
    }
    return {};
  };

  const subagentStart: HookCallback = async () => ({
    hookSpecificOutput: { hookEventName: "SubagentStart", additionalContext: routing ?? "" },
  });

  const abortController = new AbortController();
  const timer = setTimeout(() => abortController.abort(), CASE_TIMEOUT_MS);
  const options: Options = {
    cwd: world.cwd,
    model: args.model,
    maxTurns: args.maxTurns ?? evalCase.maxTurns ?? DEFAULT_MAX_TURNS,
    settingSources: [],
    strictMcpConfig: true,
    // Ryco's own sessions keep the dynamic sections; moving them (cwd, git status) into the first
    // user message makes the prompt identical across cases, so later cases read the cached
    // prefix instead of writing their own (most of a case's cost).
    systemPrompt: {
      type: "preset",
      preset: "claude_code",
      excludeDynamicSections: true,
      ...(routing ? { append: routing } : {}),
    },
    mcpServers: { ryco_device: world.mcpServer },
    permissionMode: "default",
    hooks: {
      PreToolUse: [{ hooks: [preToolUse] }],
      PostToolUse: [{ hooks: [postToolUse] }],
      PostToolUseFailure: [{ hooks: [postToolUse] }],
      // As ClaudeAdapter does: native subagents start with their own system prompt, so the
      // routing block goes with them as SubagentStart context.
      ...(routing ? { SubagentStart: [{ hooks: [subagentStart] }] } : {}),
    },
    // The hook already decided; anything that still asks is refused and noted.
    canUseTool: async (toolName) => {
      denials.push(`canUseTool asked for ${toolName}`);
      return { behavior: "deny", message: "Not permitted in this workspace." };
    },
    env: childEnvironment(),
    abortController,
    ...(args.claudePath ? { pathToClaudeCodeExecutable: args.claudePath } : {}),
  };

  try {
    for await (const message of query({ prompt: evalCase.prompt, options })) {
      messages.push(message);
      if (message.type === "system" && message.subtype === "init") {
        deviceTools = message.tools.filter((tool) => tool.includes("ryco_device"));
      } else if (message.type === "assistant") {
        const parent = message.parent_tool_use_id ?? undefined;
        for (const block of message.message.content) {
          if (block.type === "text") texts.push(block.text);
          else if (block.type === "tool_use") {
            record(
              block.id,
              block.name,
              (block.input ?? {}) as Record<string, unknown>,
              parent === undefined ? undefined : `parent:${parent}`,
            );
          }
        }
      } else if (message.type === "user") {
        const content = message.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if (typeof block !== "object" || block === null || block.type !== "tool_result")
              continue;
            const call = calls.get(block.tool_use_id);
            if (!call) continue;
            calls.set(block.tool_use_id, {
              ...call,
              result: stringify(block.content),
              isError: block.is_error === true,
            });
          }
        }
      } else if (message.type === "result") {
        subtype = message.subtype;
        turns = message.num_turns;
        costUsd = message.total_cost_usd;
        if (message.subtype === "success") finalText = message.result;
        for (const usage of Object.values(message.modelUsage ?? {})) {
          tokens.input += usage.inputTokens ?? 0;
          tokens.output += usage.outputTokens ?? 0;
          tokens.cacheRead += usage.cacheReadInputTokens ?? 0;
          tokens.cacheWrite += usage.cacheCreationInputTokens ?? 0;
        }
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? caught.message : String(caught);
  } finally {
    clearTimeout(timer);
  }
  if (finalText.length === 0) finalText = texts.at(-1) ?? "";

  const transcript: Transcript = {
    calls: order.map((id) => calls.get(id)!),
    finalText,
    texts,
    tapped: [...world.backend.tapped],
  };
  const grade = gradeTranscript(evalCase.expect, transcript);
  const rpcLog = [...world.rpcLog];
  await world.close();

  await writeFile(
    path.join(outDir, "transcripts", `${evalCase.id}.json`),
    JSON.stringify(
      { case: evalCase, grade, transcript, shell, denials, rpcLog, error, messages },
      null,
      2,
    ),
  );
  return {
    id: evalCase.id,
    checks: evalCase.checks,
    grade:
      error === undefined
        ? grade
        : { pass: false, checks: [...grade.checks, { name: "run", pass: false, detail: error }] },
    turns,
    subtype,
    costUsd,
    inputTokens: tokens.input,
    outputTokens: tokens.output,
    cacheReadTokens: tokens.cacheRead,
    cacheWriteTokens: tokens.cacheWrite,
    durationMs: Date.now() - started,
    deviceTools,
    refusalSource: world.refusalSource,
    ...(error === undefined ? {} : { error }),
  };
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) =>
        typeof part === "object" && part !== null && "text" in part
          ? String((part as { text: unknown }).text)
          : typeof part === "object" && part !== null && "type" in part
            ? `[${String((part as { type: unknown }).type)}]`
            : JSON.stringify(part),
      )
      .join("\n");
  }
  return JSON.stringify(value) ?? "";
}

function table(results: readonly CaseResult[]): string {
  const rows = results.map((result) => {
    const failed = result.grade.checks.filter((check) => !check.pass);
    return [
      result.id,
      result.grade.pass ? "PASS" : "FAIL",
      String(result.turns),
      String(result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens),
      String(result.outputTokens),
      `$${result.costUsd.toFixed(4)}`,
      failed.map((check) => `${check.name}${check.detail ? ` (${check.detail})` : ""}`).join("; "),
    ];
  });
  const header = ["case", "result", "turns", "in tok", "out tok", "cost", "failed checks"];
  const widths = header.map((title, column) =>
    Math.max(title.length, ...rows.map((row) => (column === 6 ? 0 : row[column]!.length))),
  );
  const line = (cells: readonly string[]) =>
    cells.map((cell, column) => (column === 6 ? cell : cell.padEnd(widths[column]!))).join("  ");
  return [line(header), ...rows.map(line)].join("\n");
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) {
    for (const evalCase of CASES) console.log(`${evalCase.id.padEnd(9)} ${evalCase.checks}`);
    return;
  }
  const selected =
    args.cases.length === 0 ? CASES : CASES.filter((evalCase) => args.cases.includes(evalCase.id));
  const unknown = args.cases.filter((id) => !CASES.some((evalCase) => evalCase.id === id));
  if (unknown.length > 0) throw new Error(`Unknown case(s): ${unknown.join(", ")}`);

  const routing = await loadRoutingInstructions();
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-");
  const outDir = path.join(HERE, "out", stamp);
  await mkdir(path.join(outDir, "transcripts"), { recursive: true });
  console.log(`model ${args.model}; routing block: ${routing.source}; out ${outDir}`);

  const results: CaseResult[] = [];
  // One at a time: cases share process-wide gateway state and stay cheap.
  for (const evalCase of selected) {
    process.stdout.write(`${evalCase.id} … `);
    const result = await runCase(evalCase, args, routing.text, outDir);
    results.push(result);
    console.log(
      `${result.grade.pass ? "PASS" : "FAIL"} (${result.turns} turns, $${result.costUsd.toFixed(4)})`,
    );
  }

  const totals = {
    passed: results.filter((result) => result.grade.pass).length,
    cases: results.length,
    costUsd: results.reduce((sum, result) => sum + result.costUsd, 0),
    inputTokens: results.reduce(
      (sum, result) => sum + result.inputTokens + result.cacheReadTokens + result.cacheWriteTokens,
      0,
    ),
    outputTokens: results.reduce((sum, result) => sum + result.outputTokens, 0),
  };
  const summary = `${table(results)}\n\n${totals.passed}/${totals.cases} passed · ${totals.inputTokens} input tokens (incl. cache) · ${totals.outputTokens} output tokens · $${totals.costUsd.toFixed(4)}\nmodel ${args.model} · routing block: ${routing.source} · device tools: ${results[0]?.deviceTools.join(", ") || "none"}\n`;
  await writeFile(
    path.join(outDir, "results.json"),
    JSON.stringify({ model: args.model, routing: routing.source, totals, results }, null, 2),
  );
  await writeFile(path.join(outDir, "summary.txt"), summary);
  console.log(`\n${summary}`);
  if (totals.passed < totals.cases) process.exitCode = 1;
}

await main();
