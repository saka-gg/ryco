/**
 * Optional check of how the pinned Claude Code CLI compacts, which the compaction policy relies on.
 * Enable with:
 *   RYCO_CLAUDE_NATIVE_PROBE=1 bun run --cwd apps/server test -- src/provider/claudeCompactionCliProbe.test.ts
 * It runs the CLI bundled with the pinned Agent SDK; RYCO_CLAUDE_PROBE_EXECUTABLE (an absolute
 * path) checks another `claude` binary instead.
 *
 * No inference: every session gets a temporary HOME and CLAUDE_CONFIG_DIR (so it never reads
 * ~/.claude, and its keychain item name is unique to that directory), no setting sources, tools,
 * MCP servers or hooks, a fake API key, and a loopback API endpoint that rejects every request and
 * records only its path. Context usage is read with `detail: "summary"`, which makes no
 * token-count calls.
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  query,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";

import {
  CLAUDE_NATIVE_COMPACTION_COMMAND,
  claudeInitAdvertisesNativeCompaction,
} from "./claudeNativeCompaction.ts";
import { claudeEchoedPromptUuids } from "./claudeSteering.ts";
import { CONTEXT_COMPACTION_TRIGGER_RATIO } from "./contextCompactionPolicy.ts";

const PROBE_MODEL = "claude-opus-5-5";

describe.runIf(process.env.RYCO_CLAUDE_NATIVE_PROBE === "1")("Claude Code compaction probe", () => {
  let root = "";
  let server: Server | undefined;
  let endpoint = "";
  const requestPaths: string[] = [];
  /** Settle when each CLI process exits: it writes its config until then. */
  const processExits: Promise<void>[] = [];

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "ryco-claude-compaction-probe-"));
    server = createServer((request, response) => {
      requestPaths.push(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
      request.resume();
      response.writeHead(403).end();
    });
    await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("No loopback port");
    endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    try {
      await Promise.all(processExits);
      // Asserted here so it covers every session the probe started.
      expect(requestPaths.filter((path) => path.includes("/messages"))).toEqual([]);
    } finally {
      if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
      if (root) await rm(root, { recursive: true, force: true });
    }
  });

  /** A session whose prompt stream yields only what `send` pushes. */
  const startSession = (settings: Record<string, unknown> = {}) => {
    const pending: SDKUserMessage[] = [];
    let wake: (() => void) | undefined;
    let closed = false;
    const prompt = (async function* (): AsyncGenerator<SDKUserMessage> {
      while (true) {
        const next = pending.shift();
        if (next) {
          yield next;
          continue;
        }
        if (closed) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
    })();
    const executable = process.env.RYCO_CLAUDE_PROBE_EXECUTABLE;
    const runtime: Query = query({
      prompt,
      options: {
        cwd: root,
        model: PROBE_MODEL,
        ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
        env: {
          HOME: root,
          CLAUDE_CONFIG_DIR: join(root, ".claude"),
          TMPDIR: root,
          PATH: process.env.PATH ?? "",
          ANTHROPIC_API_KEY: "ryco-probe-not-a-real-key",
          ANTHROPIC_BASE_URL: endpoint,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
          DISABLE_AUTOUPDATER: "1",
        },
        settingSources: [],
        tools: [],
        mcpServers: {},
        strictMcpConfig: true,
        persistSession: false,
        settings: { disableAllHooks: true, ...settings },
        spawnClaudeCodeProcess: (options) => {
          const child = spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            signal: options.signal,
            stdio: ["pipe", "pipe", "ignore"],
          });
          processExits.push(new Promise((resolve) => child.once("close", () => resolve())));
          return child;
        },
      },
    });
    return {
      runtime,
      send: (message: SDKUserMessage) => {
        pending.push(message);
        wake?.();
      },
      close: () => {
        closed = true;
        wake?.();
        runtime.close();
      },
    };
  };

  const readWindow = async (runtime: Query) => {
    const usage = await runtime.getContextUsage({ detail: "summary" });
    return { maxTokens: usage.maxTokens, autoCompactThreshold: usage.autoCompactThreshold };
  };

  // Why the policy sends `/compact` itself. Should the live change ever apply, re-audit that.
  it("applies an auto-compact window given at start-up, not one applied live", async () => {
    const live = startSession();
    let before: Awaited<ReturnType<typeof readWindow>>;
    let windowTokens: number;
    try {
      before = await readWindow(live.runtime);
      windowTokens = Math.floor(before.maxTokens * CONTEXT_COMPACTION_TRIGGER_RATIO);
      // Exactly what the compaction policy used to send at its threshold.
      await live.runtime.applyFlagSettings({
        autoCompactEnabled: true,
        autoCompactWindow: windowTokens,
      });
      expect(await readWindow(live.runtime)).toEqual(before);
      await new Promise((resolve) => setTimeout(resolve, 500));
      expect(await readWindow(live.runtime)).toEqual(before);
    } finally {
      live.close();
    }

    // The same window given at start-up applies, so the reading above can see a change.
    const spawned = startSession({ autoCompactEnabled: true, autoCompactWindow: windowTokens });
    try {
      const applied = await readWindow(spawned.runtime);
      expect(applied.maxTokens).toBe(windowTokens);
      expect(applied.autoCompactThreshold).toBeLessThan(before.autoCompactThreshold ?? Infinity);
    } finally {
      spawned.close();
    }
  });

  it("advertises /compact and answers its prompt even when nothing was compacted", async () => {
    const session = startSession();
    try {
      const promptUuid = crypto.randomUUID();
      session.send({
        type: "user",
        message: { role: "user", content: CLAUDE_NATIVE_COMPACTION_COMMAND },
        parent_tool_use_id: null,
        uuid: promptUuid,
        session_id: "",
      });
      const frames: SDKMessage[] = [];
      for await (const frame of session.runtime) {
        frames.push(frame);
        if (frame.type === "result") break;
      }
      const init = frames.find((frame) => frame.type === "system" && frame.subtype === "init");
      expect(init && claudeInitAdvertisesNativeCompaction(init)).toBe(true);
      const result = frames.at(-1);
      expect(result?.type).toBe("result");
      expect(claudeEchoedPromptUuids(result!)).toEqual([promptUuid]);
      // An empty conversation has nothing to compact: a successful result, yet no boundary.
      expect(result).toMatchObject({ subtype: "success", is_error: false });
      expect(
        frames.some((frame) => frame.type === "system" && frame.subtype === "compact_boundary"),
      ).toBe(false);
    } finally {
      session.close();
    }
  });
});
