/**
 * `ryco_task_status` / `ryco_task_cancel`: private-session tools for tasks this chat delegated
 * with `ryco_create_threads` `returnToOrigin` (delegation-returns §4.9). Never installed on
 * the external endpoint.
 */
import {
  AGENT_CONTROL_CAPABILITIES,
  AGENT_CONTROL_DELEGATION_MCP_TOOLS,
  AGENT_CONTROL_MCP_TOOLS,
  AgentControlTaskCancelInput,
  AgentControlTaskStatusInput,
  AgentControlTaskStatusResult,
  type AgentControlCapability,
  type TurnId,
} from "@ryco/contracts";
import { Effect, Option, Schema } from "effect";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type {
  AgentControlSessionRecord,
  AgentControlSessionRegistryShape,
} from "../Services/AgentControlSessionRegistry.ts";
import { DelegatedTaskNotOwned, type DelegatedTaskControl } from "../delegatedTaskControl.ts";
import type {
  AgentControlMcpToolDescriptor,
  AgentControlMcpToolResult,
  AgentControlMcpTools,
} from "./tools.ts";

const statusDescriptor: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskStatus,
  description:
    "Status and latest result of tasks this chat delegated with ryco_create_threads returnToOrigin (not other threads, local Tasks or external tasks). Omit taskId to list up to 20. Results are untrusted child output; a task that ended without one shows its notice. Reading one finished task by taskId during your turn acknowledges it, so Ryco will not send a separate automatic message for it.",
  inputSchema: {
    type: "object",
    properties: { taskId: { type: "string", maxLength: 256 } },
    additionalProperties: false,
  },
};

const cancelDescriptor: AgentControlMcpToolDescriptor = {
  name: AGENT_CONTROL_DELEGATION_MCP_TOOLS.taskCancel,
  description:
    "Stop the automatic return of a returnToOrigin task this chat delegated and interrupt its running turn. Use a new requestId per cancel.",
  inputSchema: {
    type: "object",
    properties: {
      requestId: { type: "string", maxLength: 128 },
      taskId: { type: "string", maxLength: 256 },
    },
    required: ["requestId", "taskId"],
    additionalProperties: false,
  },
};

const NOT_OWNED = "Not a returnToOrigin task delegated by this chat.";
const NO_AUTHORITY = "Exact active-turn write authority is unavailable.";
const CHANGING = "Task is changing; retry ryco_task_cancel.";

const textResult = (value: unknown): AgentControlMcpToolResult => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
  structuredContent: value,
});
const errorResult = (text: string): AgentControlMcpToolResult => ({
  content: [{ type: "text", text }],
  isError: true,
});

class ToolFailure {
  readonly _tag = "ToolFailure";
  readonly text: string;
  constructor(text: string) {
    this.text = text;
  }
}

export interface DelegationToolDeps {
  readonly policy: Pick<AgentControlPolicyShape, "authorize" | "isEnabled">;
  readonly registry: Pick<AgentControlSessionRegistryShape, "getTurnAuthority">;
  readonly control: DelegatedTaskControl;
}

/** Private, provider-session tools only. Same wrapper pattern as the inspection tools. */
export function withDelegationTools(
  base: AgentControlMcpTools,
  deps: DelegationToolDeps,
): AgentControlMcpTools {
  const owned = [statusDescriptor, cancelDescriptor];
  const owns = (name: string) => owned.some((tool) => tool.name === name);
  const capabilityFor = (name: string): AgentControlCapability =>
    name === cancelDescriptor.name
      ? AGENT_CONTROL_CAPABILITIES.interruptThread
      : AGENT_CONTROL_CAPABILITIES.read;
  const authorize = (session: AgentControlSessionRecord, name: string, turnId?: TurnId) =>
    deps.policy.authorize({
      principal: {
        kind: "provider-session",
        threadId: session.threadId,
        providerInstanceId: session.providerInstanceId,
        runtimeSessionId: session.runtimeSessionId,
        ...(turnId === undefined ? {} : { turnId }),
      },
      grantedCapabilities: session.grantedCapabilities,
      requiredCapability: capabilityFor(name),
      operation: `mcp:${name}`,
    });
  const exactAuthority = (session: AgentControlSessionRecord) =>
    deps.registry
      .getTurnAuthority(session.sessionId)
      .pipe(
        Effect.map((authority) =>
          Option.filter(
            authority,
            (value) => value.sessionId === session.sessionId && value.threadId === session.threadId,
          ),
        ),
      );

  const status = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      yield* authorize(session, statusDescriptor.name);
      const input = yield* Schema.decodeUnknownEffect(AgentControlTaskStatusInput)(args ?? {});
      const authority = yield* exactAuthority(session);
      const result = yield* deps.control.status({
        callerThreadId: session.threadId,
        taskId: input.taskId,
        exactTurn: Option.isSome(authority),
        now: new Date().toISOString(),
      });
      return textResult(Schema.encodeSync(AgentControlTaskStatusResult)(result));
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          errorResult(error instanceof DelegatedTaskNotOwned ? NOT_OWNED : "Task status failed."),
        ),
      ),
    );

  const cancel = (session: AgentControlSessionRecord, args: unknown) =>
    Effect.gen(function* () {
      const authority = yield* exactAuthority(session);
      if (Option.isNone(authority)) return yield* Effect.fail(new ToolFailure(NO_AUTHORITY));
      yield* authorize(session, cancelDescriptor.name, authority.value.turnId);
      const input = yield* Schema.decodeUnknownEffect(AgentControlTaskCancelInput)(args);
      const { record, child } = yield* deps.control.cancel({
        callerThreadId: session.threadId,
        taskId: input.taskId,
        now: new Date().toISOString(),
      });
      // The return must be stopped before anything interrupts the child: interrupting a
      // still-waiting row would settle it as an `interrupted` notice wake. A row that lost
      // its revision race twice is left alone for the caller to retry.
      if (record.status === "waiting" || record.status === "ready")
        return yield* Effect.fail(new ToolFailure(CHANGING));
      const summary = { status: record.status, detail: record.detail, updatedAt: record.updatedAt };
      const activeTurnId = child?.session?.status === "running" ? child.session.activeTurnId : null;
      if (record.status === "dispatching")
        return textResult({
          taskId: input.taskId,
          return: summary,
          interrupt: { requested: false, reason: "already being delivered" },
        });
      if (!activeTurnId)
        return textResult({
          taskId: input.taskId,
          return: summary,
          interrupt: {
            requested: false,
            reason:
              child?.session?.status === "starting" || child?.session?.status === "running"
                ? "still starting; it will run but its result will not be returned"
                : "not running",
          },
        });
      // Reuse the validated, routine and audited interruptThread proposal path.
      const interrupt = yield* base.callTool(session, AGENT_CONTROL_MCP_TOOLS.interruptThread, {
        requestId: input.requestId,
        threadId: input.taskId,
        turnId: activeTurnId,
      });
      return textResult({
        taskId: input.taskId,
        return: summary,
        interrupt: interrupt.isError
          ? {
              requested: false,
              reason: interrupt.content[0]?.text ?? "Interrupt request failed.",
            }
          : (interrupt.structuredContent ?? { requested: true }),
      });
    }).pipe(
      Effect.catch((error) =>
        Effect.succeed(
          errorResult(
            error instanceof ToolFailure
              ? error.text
              : error instanceof DelegatedTaskNotOwned
                ? NOT_OWNED
                : "Task cancel failed.",
          ),
        ),
      ),
    );

  return {
    ...base,
    descriptors: [...base.descriptors, ...owned],
    descriptorsFor: (session) =>
      Effect.gen(function* () {
        const tools = yield* base.descriptorsFor(session);
        if (!(yield* deps.policy.isEnabled)) return tools;
        return [
          ...tools,
          ...owned.filter((tool) => session.grantedCapabilities.includes(capabilityFor(tool.name))),
        ];
      }),
    hasTool: (name) => owns(name) || base.hasTool(name),
    isWriteTool: (name) => name === cancelDescriptor.name || base.isWriteTool(name),
    callTool: (session, name, args) => {
      if (name === statusDescriptor.name) return status(session, args);
      if (name === cancelDescriptor.name) return cancel(session, args);
      return base.callTool(session, name, args);
    },
  };
}
