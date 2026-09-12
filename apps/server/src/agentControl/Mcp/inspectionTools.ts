import {
  AGENT_CONTROL_CAPABILITIES,
  OrchestrationThreadActivity,
  AgentControlReadProjectInput,
  AgentControlInspectThreadInput,
  AgentControlWaitThreadsInput,
  AgentControlSearchThreadsInput,
  AgentControlReadDiffInput,
  AgentControlReadThreadFileInput,
} from "@ryco/contracts";
import { deriveThreadSubagents } from "@ryco/client-runtime/state/session";
import { redactDiagnosticText } from "@ryco/shared/diagnosticRedaction";
import { Effect, Option, Schema } from "effect";
import type {
  AgentControlMcpToolDeps,
  AgentControlMcpTools,
  AgentControlMcpToolDescriptor,
} from "./tools.ts";
import type { WorkspaceFileSystemShape } from "../../workspace/Services/WorkspaceFileSystem.ts";
import type { CheckpointDiffQueryShape } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import { redactAgentControlSecrets } from "../ProviderInjection.ts";

const descriptors: ReadonlyArray<AgentControlMcpToolDescriptor> = [
  {
    name: "ryco_search_threads",
    description:
      "Search conversation content across Ryco threads, optionally scoped to one project or thread. Returns matching message snippets and thread identifiers.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", maxLength: 1000 },
        projectId: { type: "string" },
        threadId: { type: "string" },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      },
      required: ["query"],
      additionalProperties: false,
    },
  },
  {
    name: "ryco_read_thread_diff",
    description:
      "Read the review panel's checkpoint diff through a specified turn count. Obtain turn counts from ryco_inspect_thread with section review. Large patches are truncated.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        toTurnCount: { type: "integer", minimum: 0 },
        ignoreWhitespace: { type: "boolean" },
      },
      required: ["threadId", "toTurnCount"],
      additionalProperties: false,
    },
  },
  {
    name: "ryco_read_thread_file",
    description:
      "Read a text file relative to a thread's authorized workspace or worktree. Uses the same file service as the Files panel; paths escaping the workspace are rejected. Large files are truncated.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        relativePath: { type: "string", maxLength: 4096 },
      },
      required: ["threadId", "relativePath"],
      additionalProperties: false,
    },
  },
  {
    name: "ryco_read_project",
    description:
      "Read a project's current preferences and revision: default model, system prompt, scripts and preferred remote. Use updatedAt as expectedUpdatedAt when updating. Workspace paths and credentials are omitted.",
    inputSchema: {
      type: "object",
      properties: { projectId: { type: "string" } },
      required: ["projectId"],
      additionalProperties: false,
    },
  },
  {
    name: "ryco_inspect_thread",
    description:
      "Inspect a thread's right-panel content: info (model, goal, worktree and pending-input state), agents (native subagents and their messages), activities (tool results), plans, review checkpoints, or retained terminal output. History is bounded; pass nextCursor for older history. Agent coverage reports when earlier lifecycle events are omitted.",
    inputSchema: {
      type: "object",
      properties: {
        threadId: { type: "string" },
        section: {
          type: "string",
          enum: ["info", "agents", "activities", "plans", "review", "terminals"],
        },
        limit: { type: "integer", minimum: 1, maximum: 100 },
        cursor: { type: "string" },
      },
      required: ["threadId", "section"],
      additionalProperties: false,
    },
  },
  {
    name: "ryco_wait_threads",
    description:
      "Wait for any of up to eight threads to finish or require attention. Returns current state and recent messages. timeoutMs: 0 gives an immediate snapshot. Running background subagents keep a thread active. Use this after creation or sending a message; operation completion only means the request was dispatched.",
    inputSchema: {
      type: "object",
      properties: {
        threadIds: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 8 },
        timeoutMs: { type: "integer", minimum: 0, maximum: 45000 },
      },
      required: ["threadIds"],
      additionalProperties: false,
    },
  },
];

// Bound both arbitrary activity payloads and the aggregate response. Never stringify
// an unbounded payload first, and never return raw connection/session credentials.
function sanitize(value: unknown, budget = { chars: 120_000, nodes: 5000 }, depth = 0): unknown {
  if (budget.chars <= 0 || --budget.nodes <= 0 || depth > 12) return "[truncated]";
  if (typeof value === "string") {
    const text = redactDiagnosticText(
      String(redactAgentControlSecrets(value.slice(0, Math.min(12_000, budget.chars)))),
    );
    budget.chars -= text.length;
    return text.length < value.length ? `${text} [truncated or redacted]` : text;
  }
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value))
    return value.slice(0, 100).map((item) => sanitize(item, budget, depth + 1));
  return Object.fromEntries(
    Object.entries(value)
      .slice(0, 100)
      .map(([key, item]) => [
        key,
        /^(?:authorization|headers|env|environment|credential|password|secret|accessToken|refreshToken|cookie|proof|ticket)$/i.test(
          key,
        )
          ? "[redacted]"
          : sanitize(item, budget, depth + 1),
      ]),
  );
}

export function withInspectionTools(
  base: AgentControlMcpTools,
  deps: AgentControlMcpToolDeps & {
    terminals?: TerminalManagerShape;
    diffs?: CheckpointDiffQueryShape;
    files?: WorkspaceFileSystemShape;
  },
): AgentControlMcpTools {
  const owns = (name: string) => descriptors.some((tool) => tool.name === name);
  return {
    ...base,
    descriptors: [...base.descriptors, ...descriptors],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        const enabled = yield* deps.policy.isEnabled;
        return enabled && session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.read)
          ? [...tools, ...descriptors]
          : tools;
      }),
    hasTool: (name) => owns(name) || base.hasTool(name),
    callTool: (session, name, args) => {
      if (!owns(name)) return base.callTool(session, name, args);
      return Effect.gen(function* () {
        yield* deps.policy.authorize({
          principal: {
            kind: "provider-session",
            threadId: session.threadId,
            providerInstanceId: session.providerInstanceId,
            runtimeSessionId: session.runtimeSessionId,
          },
          grantedCapabilities: session.grantedCapabilities,
          requiredCapability: AGENT_CONTROL_CAPABILITIES.read,
          operation: `mcp:${name}`,
        });
        const result = yield* Effect.gen(function* () {
          if (name === "ryco_search_threads") {
            const input = yield* Schema.decodeUnknownEffect(AgentControlSearchThreadsInput)(args);
            return yield* deps.projections.searchThreadMessages({
              ...input,
              limit: input.limit ?? 20,
            });
          }
          if (name === "ryco_read_thread_diff") {
            const input = yield* Schema.decodeUnknownEffect(AgentControlReadDiffInput)(args);
            if (!deps.diffs) return yield* Effect.fail(new Error("Review service unavailable."));
            return yield* deps.diffs.getFullThreadDiff(input);
          }
          if (name === "ryco_read_thread_file") {
            const input = yield* Schema.decodeUnknownEffect(AgentControlReadThreadFileInput)(args);
            if (!deps.files || !deps.workspaceAccess)
              return yield* Effect.fail(new Error("File service unavailable."));
            const thread = yield* deps.projections.getThreadShellById(input.threadId);
            if (Option.isNone(thread)) return yield* Effect.fail(new Error("Thread not found."));
            const project = yield* deps.projections.getProjectShellById(thread.value.projectId);
            if (Option.isNone(project)) return yield* Effect.fail(new Error("Project not found."));
            const cwd = yield* deps.workspaceAccess.assertExistingPath({
              path: thread.value.worktreePath ?? project.value.workspaceRoot,
              operation: "Agent Control file read",
            });
            return yield* deps.files.readFile({ cwd, relativePath: input.relativePath });
          }
          if (name === "ryco_read_project") {
            const input = yield* Schema.decodeUnknownEffect(AgentControlReadProjectInput)(args);
            const project = yield* deps.projections.getProjectShellById(input.projectId);
            if (Option.isNone(project)) return yield* Effect.fail(new Error("Project not found."));
            const p = project.value;
            return {
              projectId: p.id,
              title: p.title,
              updatedAt: p.updatedAt,
              defaultModelSelection: p.defaultModelSelection,
              customSystemPrompt: p.customSystemPrompt,
              scripts: p.scripts,
              preferredRemoteName: p.preferredRemoteName,
            };
          }
          if (name === "ryco_wait_threads") {
            const input = yield* Schema.decodeUnknownEffect(AgentControlWaitThreadsInput)(args);
            const deadline = Date.now() + Math.min(input.timeoutMs ?? 30_000, 45_000);
            const ids = [...new Set(input.threadIds)];
            while (true) {
              yield* deps.policy.requireEnabled(`mcp:${name}`);
              const states = yield* Effect.forEach(
                ids,
                (id) => deps.projections.getThreadShellById(id),
                { concurrency: 4 },
              );
              const ready = states.some(
                (state) =>
                  Option.isNone(state) ||
                  state.value.hasPendingApprovals ||
                  state.value.hasPendingUserInput ||
                  (state.value.session?.status !== "running" &&
                    state.value.session?.status !== "starting" &&
                    !state.value.backgroundLiveness &&
                    state.value.latestTurn?.state !== "running"),
              );
              if (ready || Date.now() >= deadline) {
                const threads = yield* Effect.forEach(
                  ids,
                  (threadId) =>
                    base.callTool(session, "ryco_read_thread", { threadId, messageLimit: 5 }),
                  { concurrency: 4 },
                );
                return {
                  timedOut: !ready,
                  threads: threads.map((result, index) =>
                    result.isError
                      ? { threadId: ids[index], error: result.content }
                      : { threadId: ids[index], result: result.structuredContent },
                  ),
                };
              }
              yield* Effect.sleep(Math.min(500, Math.max(1, deadline - Date.now())));
            }
          }
          const input = yield* Schema.decodeUnknownEffect(AgentControlInspectThreadInput)(args);
          const shell = yield* deps.projections.getThreadShellById(input.threadId);
          if (Option.isNone(shell)) return yield* Effect.fail(new Error("Thread not found."));
          const thread = shell.value;
          if (input.section === "info")
            return {
              threadId: thread.id,
              projectId: thread.projectId,
              title: thread.title,
              modelSelection: thread.modelSelection,
              runtimeMode: thread.runtimeMode,
              interactionMode: thread.interactionMode,
              tokenMode: thread.tokenMode,
              envMode: thread.worktreeId ? "worktree" : "local",
              worktreeId: thread.worktreeId,
              branch: thread.branch,
              latestTurn: thread.latestTurn,
              goal: thread.goal,
              status: thread.session?.status ?? "idle",
              hasPendingApprovals: thread.hasPendingApprovals,
              hasPendingUserInput: thread.hasPendingUserInput,
              backgroundLiveness: thread.backgroundLiveness,
              archivedAt: thread.archivedAt,
              updatedAt: thread.updatedAt,
            };
          if (input.section === "terminals") {
            if (!deps.terminals)
              return yield* Effect.fail(new Error("Terminal inspection unavailable."));
            const terminals = yield* deps.terminals.listSessions;
            return {
              terminals: terminals
                .filter((t) => t.threadId === input.threadId)
                .slice(0, 10)
                .map((t) => ({
                  terminalId: t.terminalId,
                  status: t.status,
                  history: t.history.slice(-12_000),
                  truncated: t.history.length > 12_000,
                  exitCode: t.exitCode,
                  updatedAt: t.updatedAt,
                })),
            };
          }
          const collection =
            input.section === "plans"
              ? "proposedPlans"
              : input.section === "review"
                ? "checkpoints"
                : "activities";
          const limit = input.limit ?? 50;
          if (!deps.projections.getThreadWindow || !deps.projections.getThreadHistoryPage)
            return yield* Effect.fail(new Error("History unavailable."));
          const page = input.cursor
            ? yield* deps.projections.getThreadHistoryPage({
                threadId: input.threadId,
                collection,
                mode: { kind: "before", cursor: input.cursor },
                limit,
              })
            : yield* deps.projections
                .getThreadWindow({
                  threadId: input.threadId,
                  limits: {
                    messages: 1,
                    proposedPlans: collection === "proposedPlans" ? limit : 1,
                    checkpoints: collection === "checkpoints" ? limit : 1,
                    activities: collection === "activities" ? limit : 1,
                  },
                })
                .pipe(
                  Effect.map((window) => ({
                    collection,
                    items: window.thread[collection],
                    page: window.history[collection],
                  })),
                );
          const items =
            input.section === "agents"
              ? deriveThreadSubagents(
                  // The selected collection is always activities for agent inspection.
                  Schema.decodeUnknownSync(Schema.Array(OrchestrationThreadActivity))(page.items),
                  {
                    sessionLive: thread.session?.status === "running",
                    parentTurnState: thread.latestTurn?.state ?? null,
                  },
                )
              : page.items;
          return {
            section: input.section,
            items,
            hasMoreBefore: page.page.hasMoreBefore,
            nextCursor: page.page.hasMoreBefore ? page.page.oldestCursor : null,
            partial: page.page.hasMoreBefore || input.cursor !== undefined,
          };
        });
        const safe = sanitize(result);
        return {
          content: [{ type: "text" as const, text: JSON.stringify(safe) }],
          structuredContent: safe,
        };
      }).pipe(
        Effect.catch(() =>
          Effect.succeed({
            content: [
              {
                type: "text" as const,
                text: "Inspection failed: check the identifier, arguments, history cursor and Agent Control permissions.",
              },
            ],
            isError: true,
          }),
        ),
      );
    },
  };
}
