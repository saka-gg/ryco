import { join } from "node:path";
import {
  AGENT_CONTROL_CAPABILITIES,
  ThreadId,
  type ComputerUseBridgeConfig,
} from "@ryco/contracts";
import { Effect, Option } from "effect";
import { ComputerManager } from "../../computer/ComputerManager.ts";
import { CuaComputerBackend } from "../../computer/CuaComputerBackend.ts";
import {
  computerTurnPlan,
  computerTurnPlanForAuthority,
  onComputerTurnRetired,
  type ComputerTurnPlan,
} from "../../computer/computerTurnLifecycle.ts";
import { makeAgentGatewayComputerTools } from "../../computer/tools/computerTools.ts";
import { makeAgentGatewayComputerBrowserTools } from "../../computer/tools/computerBrowserTools.ts";
import { GatewayToolError, type ToolContext } from "../../computer/tools/toolRuntime.ts";
import type { AgentControlMcpTools, AgentControlMcpToolResult } from "./tools.ts";
import type { AgentControlPolicyShape } from "../Services/AgentControlPolicy.ts";
import type { AgentControlSessionRegistryShape } from "../Services/AgentControlSessionRegistry.ts";
import type { ProjectionSnapshotQueryShape } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

export function withComputerBetaTools(
  base: AgentControlMcpTools,
  deps: {
    config: ComputerUseBridgeConfig;
    stateDir: string;
    registry: AgentControlSessionRegistryShape;
    policy: AgentControlPolicyShape;
    projections: ProjectionSnapshotQueryShape;
  },
): { tools: AgentControlMcpTools; dispose(): Promise<void> } {
  if (!deps.config.native) return { tools: base, dispose: async () => {} };
  const endpoint = new URL(deps.config.url);
  if (
    endpoint.protocol !== "http:" ||
    endpoint.hostname !== "127.0.0.1" ||
    endpoint.pathname !== "/control" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.search ||
    endpoint.hash
  )
    throw new Error("Invalid private Computer bridge.");
  endpoint.pathname = "/beta";
  const post = async (input: unknown, signal?: AbortSignal): Promise<Record<string, unknown>> => {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${deps.config.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input),
      signal: signal ?? AbortSignal.timeout(120_000),
      redirect: "error",
    });
    if (!response.ok)
      throw new Error(
        "Computer task expired, permission was revoked, or desktop is unavailable. Send a new request after checking setup.",
      );
    return (await response.json()) as Record<string, unknown>;
  };
  const backend = new CuaComputerBackend(deps.config.native);
  const manager = new ComputerManager({
    backend,
    auditLogPath: join(deps.stateDir, "computer-audit.jsonl"),
  });
  const active = new Map<string, { turnId: string; plan: ComputerTurnPlan }>();
  const end = (threadId: string, turnId: string) => {
    if (active.get(threadId)?.turnId !== turnId) return;
    active.delete(threadId);
    void manager.releaseDesktopControl(threadId, turnId).catch(() => undefined);
    void post({ operation: "end", threadId, turnId }).catch(() => undefined);
  };
  let previewPending = false;
  let disposed = false;
  let sequence = 0;
  const previewTimer = setInterval(() => {
    if (disposed || previewPending || active.size === 0) return;
    previewPending = true;
    void (async () => {
      const state = await post({ operation: "state" });
      const visible = new Set(
        Array.isArray(state.visibleThreads)
          ? state.visibleThreads.filter(
              (id): id is string => typeof id === "string" && active.has(id),
            )
          : [],
      );
      if (visible.size === 0 || disposed) return;
      const startedAt = Date.now();
      const preview = await backend.readPreview(visible);
      if (!preview || disposed || active.get(preview.task.threadId)?.turnId !== preview.task.turnId)
        return;
      await post({
        operation: "frame",
        threadId: preview.task.threadId,
        turnId: preview.task.turnId,
        targetId: preview.targetId,
        startedAt,
        sequence: ++sequence,
        mimeType: preview.bytes[0] === 0xff ? "image/jpeg" : "image/png",
        data: Buffer.from(preview.bytes).toString("base64"),
      });
    })()
      .catch(() => undefined)
      .finally(() => {
        previewPending = false;
      });
  }, 1000);
  previewTimer.unref();
  const removeRetirement = onComputerTurnRetired(end);
  const eventQueue: Array<{
    threadId: string;
    turnId: string;
    event: import("@ryco/contracts").ComputerEvent;
  }> = [];
  let publishingEvents = false;
  const publishEvents = async () => {
    if (publishingEvents || disposed) return;
    publishingEvents = true;
    try {
      while (eventQueue.length) {
        if (disposed) break;
        const item = eventQueue.shift()!;
        if (active.get(item.threadId)?.turnId !== item.turnId) continue;
        await post({ operation: "event", ...item }).catch(() => undefined);
      }
    } finally {
      publishingEvents = false;
    }
  };
  const removeEvents = manager.onEvent((event) => {
    const threadId =
      event.type === "computer.thread-state"
        ? event.state.threadId
        : "threadId" in event
          ? event.threadId
          : undefined;
    if (!threadId) return;
    const task = active.get(threadId);
    if (!task) return;
    if (eventQueue.length >= 128) eventQueue.shift();
    eventQueue.push({ threadId, turnId: task.turnId, event });
    void publishEvents();
  });
  const authorizeAction = async (
    name: string,
    _args: Record<string, unknown>,
    context: ToolContext,
    signal: AbortSignal,
  ) => {
    const task = active.get(context.callerThreadId);
    if (!task || task.turnId !== context.callerTurnId) return false;
    const clipboard = name.includes("clipboard");
    if (!clipboard && task.plan.runtimeMode === "full-access") return true;
    const response = await post(
      {
        operation: "consent",
        threadId: context.callerThreadId,
        turnId: context.callerTurnId,
        clipboard,
      },
      signal,
    );
    await Effect.runPromise(context.assertCallerTurnActive());
    return response.approved === true;
  };
  const resolveForegroundAuthorization = async (context: ToolContext) => ({
    userRequestedVisibleUse: active.get(context.callerThreadId)?.plan.foregroundAuthorized === true,
  });
  const browserTools = makeAgentGatewayComputerBrowserTools({
    manager,
    authorizeAction,
    resolveForegroundAuthorization,
    resolveWorkspaceRoot: (context) =>
      deps.projections.getThreadCheckpointContext(ThreadId.make(context.callerThreadId)).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (value) => value.worktreePath ?? value.workspaceRoot,
          }),
        ),
        Effect.catch(() => Effect.succeed(null)),
      ),
  });
  const entries = [
    ...makeAgentGatewayComputerTools({
      manager,
      authorizeAction,
      resolveForegroundAuthorization,
      relatedTools: browserTools,
    }),
    ...browserTools,
  ];
  const byName = new Map(entries.map((entry) => [entry.definition.name, entry]));
  const descriptors = entries
    .filter((entry) => !entry.discoveryOnly)
    .map((entry) => entry.definition);
  const failure = (message: string): AgentControlMcpToolResult => ({
    isError: true,
    content: [{ type: "text", text: message }],
  });
  return {
    tools: {
      ...base,
      descriptors: [...base.descriptors, ...descriptors],
      descriptorsFor: (session) =>
        base
          .descriptorsFor(session)
          .pipe(
            Effect.map((existing) => [
              ...existing,
              ...(computerTurnPlan(session.threadId) &&
              session.grantedCapabilities.includes(AGENT_CONTROL_CAPABILITIES.controlComputer)
                ? descriptors
                : []),
            ]),
          ),
      hasTool: (name) => byName.has(name) || base.hasTool(name),
      isWriteTool: (name) => byName.has(name) || base.isWriteTool(name),
      callTool: (session, name, args) => {
        const entry = byName.get(name);
        if (!entry) return base.callTool(session, name, args);
        return Effect.gen(function* () {
          const authority = yield* deps.registry.getTurnAuthority(session.sessionId);
          const plan = Option.isSome(authority)
            ? computerTurnPlanForAuthority(session.threadId, authority.value.turnId)
            : undefined;
          if (Option.isNone(authority) || authority.value.threadId !== session.threadId || !plan)
            return failure(
              "Computer Use is not enabled for this exact turn. Start a task with /computer-use.",
            );
          const turnId = authority.value.turnId;
          yield* deps.policy.authorize({
            principal: {
              kind: "provider-session",
              threadId: session.threadId,
              runtimeSessionId: session.runtimeSessionId,
              providerInstanceId: session.providerInstanceId,
              turnId,
            },
            requiredCapability: AGENT_CONTROL_CAPABILITIES.controlComputer,
            grantedCapabilities: session.grantedCapabilities,
            operation: `mcp:${name}`,
          });
          const assertCallerTurnActive = () =>
            deps.registry
              .getTurnAuthority(session.sessionId)
              .pipe(
                Effect.flatMap((current) =>
                  Option.isSome(current) &&
                  current.value.turnId === turnId &&
                  computerTurnPlan(session.threadId) === plan
                    ? Effect.void
                    : Effect.fail(
                        new GatewayToolError("turn_retired", "This Computer turn has ended."),
                      ),
                ),
              );
          active.set(session.threadId, { turnId, plan });
          yield* Effect.tryPromise((signal) =>
            post(
              { operation: "begin", threadId: session.threadId, turnId, intent: plan.intent },
              signal,
            ),
          ).pipe(Effect.onError(() => Effect.sync(() => end(session.threadId, turnId))));
          yield* assertCallerTurnActive().pipe(
            Effect.onError(() => Effect.sync(() => end(session.threadId, turnId))),
          );
          if (
            !(yield* Effect.tryPromise(() =>
              manager.admitControl(
                session.threadId,
                plan.intent.mode,
                0,
                plan.intent.mode === "request",
              ),
            ))
          )
            return failure("Computer control admission was revoked.");
          const context: ToolContext = {
            principal: {
              kind: "provider-session",
              sessionKey: session.sessionId,
              threadId: session.threadId,
              provider: "ryco",
              turnId,
            },
            callerThreadId: session.threadId,
            callerThreadLabel: plan.label,
            callerSessionKey: session.sessionId,
            callerProvider: "ryco",
            callerCapabilities: new Set(["computer:control"]),
            callerTurnId: turnId,
            assertCallerTurnActive,
            jsonRpcRequestId: 0,
          };
          return (yield* entry.handler(
            args && typeof args === "object" && !Array.isArray(args)
              ? (args as Record<string, unknown>)
              : {},
            context,
          )) as AgentControlMcpToolResult;
        }).pipe(
          Effect.catch(() =>
            Effect.succeed(
              failure(
                "Computer Use is unavailable or this task was stopped. Check desktop setup and send a new task.",
              ),
            ),
          ),
        );
      },
    },
    async dispose() {
      disposed = true;
      clearInterval(previewTimer);
      removeRetirement();
      removeEvents();
      for (const [threadId, task] of active) end(threadId, task.turnId);
      await manager.dispose();
    },
  };
}
