import {
  AGENT_CONTROL_CAPABILITIES,
  AgentControlReadProjectInput,
  AgentControlInspectThreadInput,
  AgentControlWaitThreadsInput,
  AgentControlSearchThreadsInput,
  AgentControlReadDiffInput,
  AgentControlReadThreadFileInput,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import type {
  AgentControlMcpToolDeps,
  AgentControlMcpTools,
  AgentControlMcpToolDescriptor,
} from "./tools.ts";
import type { WorkspaceFileSystemShape } from "../../workspace/Services/WorkspaceFileSystem.ts";
import type { CheckpointDiffQueryShape } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import type { TerminalManagerShape } from "../../terminal/Services/Manager.ts";
import {
  allThreadsVisible,
  failTool,
  inspectThread,
  readThreadDiff,
  readThreadFile,
  sanitizeInspection,
  toProjectPreferences,
  waitThreads,
} from "./threadReads.ts";

/** Inspection catalog entries; the external catalog reuses them by name. */
export const INSPECTION_TOOL_DESCRIPTORS: ReadonlyArray<AgentControlMcpToolDescriptor> = [
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
      "Read a project's current preferences and revision: system prompt, scripts and preferred remote. Use updatedAt as expectedUpdatedAt when updating. Workspace paths and credentials are omitted.",
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
const descriptors = INSPECTION_TOOL_DESCRIPTORS;

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
            return yield* readThreadDiff(deps, input);
          }
          if (name === "ryco_read_thread_file") {
            const input = yield* Schema.decodeUnknownEffect(AgentControlReadThreadFileInput)(args);
            return yield* readThreadFile(deps, input);
          }
          if (name === "ryco_read_project") {
            const input = yield* Schema.decodeUnknownEffect(AgentControlReadProjectInput)(args);
            const project = yield* deps.projections.getProjectShellById(input.projectId);
            if (Option.isNone(project)) return yield* failTool("Project not found.");
            return toProjectPreferences(project.value);
          }
          if (name === "ryco_wait_threads") {
            const input = yield* Schema.decodeUnknownEffect(AgentControlWaitThreadsInput)(args);
            return yield* waitThreads(
              deps.projections,
              input,
              deps.policy.requireEnabled(`mcp:${name}`).pipe(Effect.as(allThreadsVisible)),
            );
          }
          const input = yield* Schema.decodeUnknownEffect(AgentControlInspectThreadInput)(args);
          return yield* inspectThread(deps, input);
        });
        const safe = sanitizeInspection(result);
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
