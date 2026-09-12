import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  AGENT_CONTROL_CAPABILITIES,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
} from "@ryco/contracts";
import { Effect, Layer, Context, Option, PubSub } from "effect";
import { expect, it } from "vitest";
import { AgentControlPolicy } from "../Services/AgentControlPolicy.ts";
import { AgentControlPolicyLive } from "../Layers/AgentControlPolicy.ts";
import { AgentControlSessionRegistry } from "../Services/AgentControlSessionRegistry.ts";
import { AgentControlSessionRegistryLive } from "../Layers/AgentControlSessionRegistry.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { makeAgentControlMcpListener } from "./listener.ts";
import { makeAgentControlMcpTools, type AgentControlMcpToolDeps } from "./tools.ts";
import {
  buildAgentControlThreadConfig,
  CODEX_AGENT_CONTROL_SERVER_NAME,
} from "../../provider/Layers/CodexSessionRuntime.ts";

// Explicit opt-in: uses an installed Codex binary, but starts no model turn and
// writes no provider config. The ephemeral provider thread uses a temporary cwd.
it.runIf(process.env.RYCO_TEST_CODEX_MCP === "1")(
  "installed Codex discovers private write tools before its first turn",
  async () => {
    const cwd = await mkdtemp(join(tmpdir(), "ryco-codex-mcp-"));
    try {
      await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const context = yield* Layer.build(
              AgentControlSessionRegistryLive.pipe(
                Layer.provideMerge(AgentControlPolicyLive),
                Layer.provideMerge(
                  ServerSettingsService.layerTest({ agentControl: { enabled: true } }),
                ),
              ),
            );
            const registry = Context.get(context, AgentControlSessionRegistry);
            const policy = Context.get(context, AgentControlPolicy);
            const events = yield* PubSub.unbounded();
            const tools = makeAgentControlMcpTools({
              policy,
              getTurnAuthority: registry.getTurnAuthority,
              getProviders: Effect.succeed([]),
              proposals: { getProposal: () => Effect.succeed(Option.none()) },
              proposalEvents: { subscribe: PubSub.subscribe(events) },
              projections: {},
            } as unknown as AgentControlMcpToolDeps);
            const listener = yield* makeAgentControlMcpListener({ registry, tools });
            yield* registry.publishEndpoint({ url: listener.url });
            const lease = Option.getOrThrow(
              yield* registry.issueLease({
                threadId: ThreadId.make("codex-smoke"),
                providerInstanceId: ProviderInstanceId.make("codex"),
                runtimeSessionId: RuntimeSessionId.make("codex-smoke-runtime"),
                injectionMode: "codex-http",
                capabilities: Object.values(AGENT_CONTROL_CAPABILITIES),
              }),
            );
            yield* Effect.promise(async () => {
              const child = spawn("codex", ["app-server"], {
                cwd,
                stdio: ["pipe", "pipe", "pipe"],
              });
              child.stderr.resume();
              let sequence = 0;
              let buffer = "";
              const pending = new Map<
                number,
                { resolve: (value: unknown) => void; reject: (error: Error) => void }
              >();
              child.stdout.on("data", (chunk) => {
                buffer += chunk.toString();
                let end: number;
                while ((end = buffer.indexOf("\n")) >= 0) {
                  const line = buffer.slice(0, end);
                  buffer = buffer.slice(end + 1);
                  try {
                    const message = JSON.parse(line);
                    const request = pending.get(message.id);
                    if (!request) continue;
                    pending.delete(message.id);
                    if (message.error) request.reject(new Error("Codex protocol request failed."));
                    else request.resolve(message.result);
                  } catch {
                    /* Only protocol lines are relevant. */
                  }
                }
              });
              const request = (method: string, params: unknown): Promise<unknown> =>
                new Promise((resolve, reject) => {
                  const id = ++sequence;
                  pending.set(id, { resolve, reject });
                  child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
                });
              const timer = setTimeout(() => {
                for (const p of pending.values()) p.reject(new Error("Codex MCP probe timed out."));
                child.kill();
              }, 30_000);
              try {
                await request("initialize", {
                  clientInfo: { name: "ryco_mcp_smoke", version: "1.0.0" },
                  capabilities: { experimentalApi: true },
                });
                child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized" }) + "\n");
                const opened = (await request("thread/start", {
                  cwd,
                  ephemeral: true,
                  config: buildAgentControlThreadConfig({
                    serverName: CODEX_AGENT_CONTROL_SERVER_NAME,
                    endpointUrl: listener.url,
                    authorization: lease.credential,
                    instructions: "Ryco MCP protocol test.",
                  }),
                })) as { thread: { id: string } };
                const status = (await request("mcpServerStatus/list", {
                  threadId: opened.thread.id,
                })) as { data: Array<{ name: string; tools: Record<string, unknown> }> };
                const server = status.data.find(
                  (entry: { name: string }) => entry.name === CODEX_AGENT_CONTROL_SERVER_NAME,
                );
                expect(server).toBeDefined();
                expect(Object.keys(server!.tools)).toContain("ryco_create_threads");
                expect(Object.keys(server!.tools)).toContain("ryco_send_message");
                expect(Object.keys(server!.tools)).toContain("ryco_update_thread");
              } finally {
                clearTimeout(timer);
                child.kill();
              }
            });
          }),
        ),
      );
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  },
  45_000,
);
