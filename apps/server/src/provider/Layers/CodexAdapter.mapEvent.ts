/**
 * Codex provider events to canonical runtime events: payload readers, item lifecycle and
 * collab-agent mapping, and the method-keyed mapper table.
 */
import {
  isToolLifecycleItemType,
  UserInputQuestion,
  type CanonicalItemType,
  type CanonicalRequestType,
  ProviderDriverKind,
  type ProviderEvent,
  type ProviderRuntimeEvent,
  type ProviderRequestKind,
  type ThreadTokenUsageSnapshot,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeSubagentId,
  RuntimeRequestId,
  RuntimeTaskId,
  type RuntimeTaskUsage,
  ProviderApprovalDecision,
  ThreadId,
  EventId,
  ThreadGoal as ThreadGoalSchema,
  type ThreadGoal,
} from "@ryco/contracts";
import { Schema } from "effect";
import * as EffectCodexSchema from "effect-codex-app-server/schema";
import {
  resolveHtmlRenderToolPresentation,
  withoutHtmlRenderMarkup,
} from "@ryco/shared/htmlRenderToolPresentation";
import { isFatalCodexStderrMessage } from "../codexStderr.ts";

export const PROVIDER = ProviderDriverKind.make("codex");

export function normalizeCodexThreadGoal(goal: {
  readonly objective: string;
  readonly status: ThreadGoal["status"];
  readonly tokenBudget?: number | null;
  readonly tokensUsed: number;
  readonly timeUsedSeconds: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}): ThreadGoal | null {
  try {
    return Schema.decodeUnknownSync(ThreadGoalSchema)({
      objective: goal.objective,
      status: goal.status,
      tokenBudget: goal.tokenBudget ?? null,
      tokensUsed: goal.tokensUsed,
      timeUsedSeconds: goal.timeUsedSeconds,
      createdAt: new Date(goal.createdAt * 1_000).toISOString(),
      updatedAt: new Date(goal.updatedAt * 1_000).toISOString(),
    });
  } catch {
    return null;
  }
}

export type CodexLifecycleItem =
  | EffectCodexSchema.V2ItemStartedNotification["item"]
  | EffectCodexSchema.V2ItemCompletedNotification["item"];

export type CodexToolUserInputQuestion =
  | EffectCodexSchema.ServerRequest__ToolRequestUserInputQuestion
  | EffectCodexSchema.ToolRequestUserInputParams__ToolRequestUserInputQuestion;

export const ApprovalDecisionPayload = Schema.Struct({
  decision: ProviderApprovalDecision,
});

export function readPayload<A>(
  schema: Schema.Schema<A>,
  payload: ProviderEvent["payload"],
): A | undefined {
  return Schema.is(schema)(payload) ? payload : undefined;
}

export function trimText(value: string | undefined | null): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

export function normalizeCodexTokenUsage(
  usage: EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification["tokenUsage"],
  sessionId: string,
): ThreadTokenUsageSnapshot | undefined {
  const totalProcessedTokens = usage.total.totalTokens;
  const usedTokens = usage.last.totalTokens;
  if (usedTokens === undefined || usedTokens < 0) {
    return undefined;
  }

  const maxTokens = usage.modelContextWindow ?? undefined;
  const inputTokens = usage.last.inputTokens;
  const cachedInputTokens = usage.last.cachedInputTokens;
  const outputTokens = usage.last.outputTokens;
  const reasoningOutputTokens = usage.last.reasoningOutputTokens;

  return {
    processedUsage: {
      scope: "session",
      sessionId,
      inputTokens: usage.total.inputTokens,
      cachedInputTokens: usage.total.cachedInputTokens,
      outputTokens: usage.total.outputTokens,
      reasoningOutputTokens: usage.total.reasoningOutputTokens,
      totalTokens: usage.total.totalTokens,
    },
    usedTokens,
    ...(totalProcessedTokens !== undefined && totalProcessedTokens > usedTokens
      ? { totalProcessedTokens }
      : {}),
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
    ...(usedTokens !== undefined ? { lastUsedTokens: usedTokens } : {}),
    ...(inputTokens !== undefined ? { lastInputTokens: inputTokens } : {}),
    ...(cachedInputTokens !== undefined ? { lastCachedInputTokens: cachedInputTokens } : {}),
    ...(outputTokens !== undefined ? { lastOutputTokens: outputTokens } : {}),
    ...(reasoningOutputTokens !== undefined
      ? { lastReasoningOutputTokens: reasoningOutputTokens }
      : {}),
    compactsAutomatically: true,
    // `sendTurn` runs `/compact` as `thread/compact/start`. Clients offer Compact now only on
    // usage that says so: an older node sends the command to the model.
    compactsOnRequest: true,
  };
}

export function toTurnStatus(
  value: EffectCodexSchema.V2TurnCompletedNotification["turn"]["status"] | "cancelled",
): "completed" | "failed" | "cancelled" | "interrupted" {
  switch (value) {
    case "completed":
    case "failed":
    case "cancelled":
    case "interrupted":
      return value;
    default:
      return "completed";
  }
}

/**
 * Fallback for a `turn/completed` that strict decoding rejects (for example a
 * `codexErrorInfo` literal newer than the pinned schema). Dropping it would leave the
 * turn running and its Agent Control authority bound.
 */
export function readTurnCompletedStructurally(
  payload: unknown,
):
  | { readonly status: ReturnType<typeof toTurnStatus>; readonly errorMessage?: string }
  | undefined {
  const turn =
    payload !== null && typeof payload === "object"
      ? (payload as { readonly turn?: unknown }).turn
      : undefined;
  if (turn === null || typeof turn !== "object") return undefined;
  const { status, error } = turn as { readonly status?: unknown; readonly error?: unknown };
  const errorRecord =
    error !== null && typeof error === "object" ? (error as { readonly message?: unknown }) : null;
  const errorMessage = trimText(
    typeof errorRecord?.message === "string" ? errorRecord.message : undefined,
  );
  const known =
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted";
  return {
    status: known ? status : errorRecord !== null ? "failed" : "completed",
    ...(errorMessage ? { errorMessage } : {}),
  };
}

export function normalizeItemType(raw: string | undefined | null): string {
  const type = trimText(raw);
  if (!type) return "item";
  return type
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function toCanonicalItemType(raw: string | undefined | null): CanonicalItemType {
  const type = normalizeItemType(raw);
  if (type.includes("user")) return "user_message";
  if (type.includes("agent message") || type.includes("assistant")) return "assistant_message";
  if (type.includes("reasoning") || type.includes("thought")) return "reasoning";
  if (type.includes("plan") || type.includes("todo")) return "plan";
  if (type.includes("command")) return "command_execution";
  if (type.includes("file change") || type.includes("patch") || type.includes("edit"))
    return "file_change";
  if (type.includes("mcp")) return "mcp_tool_call";
  if (type.includes("dynamic tool")) return "dynamic_tool_call";
  if (type.includes("collab")) return "collab_agent_tool_call";
  if (type.includes("web search")) return "web_search";
  if (type.includes("image")) return "image_view";
  if (type.includes("review entered")) return "review_entered";
  if (type.includes("review exited")) return "review_exited";
  if (type.includes("compact")) return "context_compaction";
  if (type.includes("error")) return "error";
  return "unknown";
}

export function itemTitle(itemType: CanonicalItemType): string | undefined {
  switch (itemType) {
    case "assistant_message":
      return "Assistant message";
    case "user_message":
      return "User message";
    case "reasoning":
      return "Reasoning";
    case "plan":
      return "Plan";
    case "command_execution":
      return "Ran command";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "dynamic_tool_call":
      return "Tool call";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "error":
      return "Error";
    default:
      return undefined;
  }
}

export function itemDetail(item: CodexLifecycleItem): string | undefined {
  const candidates = [
    "command" in item ? item.command : undefined,
    "title" in item ? item.title : undefined,
    "summary" in item ? item.summary : undefined,
    "text" in item ? item.text : undefined,
    "path" in item ? item.path : undefined,
    "prompt" in item ? item.prompt : undefined,
  ];
  for (const candidate of candidates) {
    const trimmed = typeof candidate === "string" ? trimText(candidate) : undefined;
    if (!trimmed) continue;
    return trimmed;
  }
  return undefined;
}

export function toRequestTypeFromMethod(method: string): CanonicalRequestType {
  switch (method) {
    case "item/commandExecution/requestApproval":
      return "command_execution_approval";
    case "item/fileRead/requestApproval":
      return "file_read_approval";
    case "item/fileChange/requestApproval":
      return "file_change_approval";
    case "applyPatchApproval":
      return "apply_patch_approval";
    case "execCommandApproval":
      return "exec_command_approval";
    case "item/tool/requestUserInput":
      return "tool_user_input";
    case "item/tool/call":
      return "dynamic_tool_call";
    case "account/chatgptAuthTokens/refresh":
      return "auth_tokens_refresh";
    default:
      return "unknown";
  }
}

export function toRequestTypeFromKind(kind: ProviderRequestKind | undefined): CanonicalRequestType {
  switch (kind) {
    case "command":
      return "command_execution_approval";
    case "file-read":
      return "file_read_approval";
    case "file-change":
      return "file_change_approval";
    default:
      return "unknown";
  }
}

export function toCanonicalUserInputAnswers(
  answers: EffectCodexSchema.ToolRequestUserInputResponse["answers"],
): ProviderUserInputAnswers {
  return Object.fromEntries(
    Object.entries(answers).map(([questionId, value]) => {
      const normalizedAnswers = value.answers.length === 1 ? value.answers[0]! : [...value.answers];
      return [questionId, normalizedAnswers] as const;
    }),
  );
}

export function toUserInputQuestions(questions: ReadonlyArray<CodexToolUserInputQuestion>) {
  const parsedQuestions = questions
    .map((question) => {
      const options =
        question.options
          ?.map((option) => {
            const label = trimText(option.label);
            const description = trimText(option.description);
            if (!label || !description) {
              return undefined;
            }
            return { label, description };
          })
          .filter((option) => option !== undefined) ?? [];

      const id = trimText(question.id);
      const header = trimText(question.header);
      const prompt = trimText(question.question);
      if (!id || !header || !prompt || options.length === 0) {
        return undefined;
      }
      return {
        id,
        header,
        question: prompt,
        options,
        multiSelect: false,
      };
    })
    .filter((question) => question !== undefined);

  return parsedQuestions.length > 0 ? parsedQuestions : undefined;
}

export function toThreadState(
  status: EffectCodexSchema.V2ThreadStatusChangedNotification["status"],
): "active" | "idle" | "archived" | "closed" | "compacted" | "error" {
  switch (status.type) {
    case "idle":
      return "idle";
    case "systemError":
      return "error";
    default:
      return "active";
  }
}

export function contentStreamKindFromMethod(
  method: string,
):
  | "assistant_text"
  | "reasoning_text"
  | "reasoning_summary_text"
  | "plan_text"
  | "command_output"
  | "file_change_output" {
  switch (method) {
    case "item/agentMessage/delta":
      return "assistant_text";
    case "item/reasoning/textDelta":
      return "reasoning_text";
    case "item/reasoning/summaryTextDelta":
      return "reasoning_summary_text";
    case "item/commandExecution/outputDelta":
      return "command_output";
    case "item/fileChange/outputDelta":
      return "file_change_output";
    default:
      return "assistant_text";
  }
}

export function asRuntimeItemId(itemId: ProviderEvent["itemId"] & string): RuntimeItemId {
  return RuntimeItemId.make(itemId);
}

export function asRuntimeRequestId(requestId: string): RuntimeRequestId {
  return RuntimeRequestId.make(requestId);
}

export function eventRawSource(
  event: ProviderEvent,
): NonNullable<ProviderRuntimeEvent["raw"]>["source"] {
  return event.kind === "request" ? "codex.app-server.request" : "codex.app-server.notification";
}

export function providerRefsFromEvent(
  event: ProviderEvent,
): ProviderRuntimeEvent["providerRefs"] | undefined {
  const refs: Record<string, string> = {};
  if (event.turnId) refs.providerTurnId = event.turnId;
  if (event.itemId) refs.providerItemId = event.itemId;
  if (event.requestId) refs.providerRequestId = event.requestId;

  return Object.keys(refs).length > 0 ? (refs as ProviderRuntimeEvent["providerRefs"]) : undefined;
}

export function runtimeEventBase(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): Omit<ProviderRuntimeEvent, "type" | "payload"> {
  const refs = providerRefsFromEvent(event);
  return {
    eventId: event.id,
    provider: event.provider,
    threadId: canonicalThreadId,
    createdAt: event.createdAt,
    ...(event.turnId ? { turnId: event.turnId } : {}),
    ...(event.itemId ? { itemId: asRuntimeItemId(event.itemId) } : {}),
    ...(event.requestId ? { requestId: asRuntimeRequestId(event.requestId) } : {}),
    ...(refs ? { providerRefs: refs } : {}),
    raw: {
      source: eventRawSource(event),
      method: event.method,
      payload: event.payload ?? {},
    },
  };
}

/**
 * A call to one of Ryco's HTML tools: shown by page title or viewport, and
 * carried without the page markup its arguments hold.
 */
export function htmlRenderToolItem(
  payload: { readonly item: CodexLifecycleItem } & object,
): { readonly title: string; readonly detail?: string; readonly payload: unknown } | undefined {
  const { item } = payload;
  if (item.type !== "mcpToolCall") return undefined;
  const presentation = resolveHtmlRenderToolPresentation({
    toolName: item.tool,
    serverName: item.server,
    input: item.arguments,
  });
  if (!presentation) return undefined;
  return {
    ...presentation,
    payload: { ...payload, item: { ...item, arguments: withoutHtmlRenderMarkup(item.arguments) } },
  };
}

/**
 * The canonical `receiverThreadIds` of a native `collabAgentToolCall` item: the subagent threads
 * it addressed, trimmed, omitted when there are none. Takes the raw item too (a child thread's
 * items reach the adapter untyped).
 */
export function collabReceiverThreadIds(
  item: unknown,
): { readonly receiverThreadIds: ReadonlyArray<string> } | undefined {
  if (typeof item !== "object" || item === null) return undefined;
  const { type, receiverThreadIds } = item as { type?: unknown; receiverThreadIds?: unknown };
  if (type !== "collabAgentToolCall" || !Array.isArray(receiverThreadIds)) return undefined;
  const ids = receiverThreadIds.flatMap((entry) => {
    const threadId = typeof entry === "string" ? trimText(entry) : undefined;
    return threadId ? [threadId] : [];
  });
  return ids.length > 0 ? { receiverThreadIds: ids } : undefined;
}

export function mapItemLifecycle(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
  lifecycle: "item.started" | "item.updated" | "item.completed",
): ProviderRuntimeEvent | undefined {
  const payload =
    readPayload(EffectCodexSchema.V2ItemStartedNotification, event.payload) ??
    readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
  const item = payload?.item;
  if (!item) {
    return undefined;
  }
  const itemType = toCanonicalItemType(item.type);
  if (itemType === "unknown" && lifecycle !== "item.updated") {
    return undefined;
  }

  const htmlRender = htmlRenderToolItem(payload);
  const title = htmlRender?.title ?? itemTitle(itemType);
  const detail = htmlRender ? htmlRender.detail : itemDetail(item);
  const status =
    lifecycle === "item.started"
      ? "inProgress"
      : lifecycle === "item.completed"
        ? "completed"
        : undefined;

  return {
    ...runtimeEventBase(event, canonicalThreadId),
    type: lifecycle,
    payload: {
      itemType,
      ...(status ? { status } : {}),
      ...(title ? { title } : {}),
      ...(detail ? { detail } : {}),
      ...collabReceiverThreadIds(item),
      ...(htmlRender
        ? { data: htmlRender.payload }
        : event.payload !== undefined
          ? { data: event.payload }
          : {}),
    },
  };
}

/**
 * Maps the session runtime's synthetic `collabAgent/*` events (native
 * multi-agent v2 child-thread signals) into the shared task.* lifecycle.
 * Agent identity = child thread id; nickname is the display title, role is
 * agentRole (fallback: last agentPath segment, then "general-purpose").
 * A completed child turn is idle (resumable), not terminal. timelineBypass
 * keeps these rows out of the parent chat.
 */
export function mapCollabAgentEvent(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  const payload =
    typeof event.payload === "object" && event.payload !== null
      ? (event.payload as Record<string, unknown>)
      : undefined;
  const agentThreadId = typeof payload?.agentThreadId === "string" ? payload.agentThreadId : "";
  if (!payload || agentThreadId.length === 0) {
    return [];
  }
  const base = runtimeEventBase(event, canonicalThreadId);
  const taskId = RuntimeTaskId.make(agentThreadId);
  const agentPath = typeof payload.agentPath === "string" ? payload.agentPath : undefined;
  const pathLeaf = agentPath?.split("/").findLast((segment) => segment.length > 0);
  const nickname = typeof payload.nickname === "string" ? payload.nickname : undefined;
  const role =
    (typeof payload.role === "string" ? payload.role : undefined) ?? pathLeaf ?? "general-purpose";
  // A bare thread id is not a name. Omitting the title lets the client fold
  // keep the real one from task.started instead of clobbering it (progress
  // rows would otherwise rename a child to its UUID).
  const knownName = nickname ?? pathLeaf;
  const title = knownName ?? agentThreadId;
  // Identity repeated on every status patch so rows are self-describing when
  // the start row ages out of activity retention.
  const statusLinkage = {
    role,
    ...(knownName ? { title: knownName } : {}),
    ...(agentPath ? { agentPath } : {}),
    timelineBypass: true,
  } as const;

  switch (event.method) {
    case "collabAgent/started":
      return [
        {
          ...base,
          type: "task.started",
          payload: {
            taskId,
            description: title,
            title,
            role,
            ...(agentPath ? { agentPath } : {}),
            ...(typeof payload.parentThreadId === "string"
              ? { parentAgentId: payload.parentThreadId }
              : {}),
            timelineBypass: true,
          },
        },
      ];
    case "collabAgent/activity": {
      const activityKind = typeof payload.activityKind === "string" ? payload.activityKind : "";
      if (activityKind === "interrupted") {
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "interrupted", ...statusLinkage },
          },
        ];
      }
      if (activityKind === "started") {
        // Children often register via subAgentActivity alone (no
        // thread/started with a spawn source), so this is the one shot at a
        // task.started with a real name — agentPath leaf beats a bare
        // thread-id title.
        return [
          {
            ...base,
            type: "task.started",
            payload: {
              taskId,
              description: title,
              title,
              role,
              ...(agentPath ? { agentPath } : {}),
              timelineBypass: true,
            },
          },
        ];
      }
      // interacted → the child is (again) actively driven.
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "running", ...statusLinkage },
        },
      ];
    }
    case "collabAgent/turnStarted":
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "running", ...statusLinkage },
        },
      ];
    case "collabAgent/turnCompleted": {
      // Idle, not terminal: the identity is resumable via sendInput/resume.
      const turn =
        typeof payload.turn === "object" && payload.turn !== null
          ? (payload.turn as Record<string, unknown>)
          : undefined;
      const turnStatus = typeof turn?.status === "string" ? turn.status : undefined;
      const status =
        turnStatus === "failed"
          ? ("failed" as const)
          : turnStatus === "interrupted"
            ? ("interrupted" as const)
            : ("idle" as const);
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status, ...statusLinkage },
        },
      ];
    }
    case "collabAgent/statusChanged": {
      const status =
        typeof payload.status === "object" && payload.status !== null
          ? (payload.status as Record<string, unknown>)
          : undefined;
      const statusType = typeof status?.type === "string" ? status.type : undefined;
      if (statusType === "systemError") {
        // Silently dropping this once left children stuck running forever.
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "failed", ...statusLinkage },
          },
        ];
      }
      if (statusType === "active") {
        const flags = Array.isArray(status?.activeFlags) ? status.activeFlags : [];
        const waiting = flags.some(
          (flag) => flag === "waitingOnApproval" || flag === "waitingOnUserInput",
        );
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: waiting ? "waiting" : "running", ...statusLinkage },
          },
        ];
      }
      if (statusType === "idle" || statusType === "notLoaded") {
        return [
          {
            ...base,
            type: "task.updated",
            payload: { taskId, status: "idle", ...statusLinkage },
          },
        ];
      }
      return [];
    }
    case "collabAgent/tokenUsage": {
      // Cumulative per child thread: always the `total` breakdown, never
      // `last` (which shrinks on follow-ups). Client folds max-merge.
      const tokenUsage =
        typeof payload.tokenUsage === "object" && payload.tokenUsage !== null
          ? (payload.tokenUsage as Record<string, unknown>)
          : undefined;
      const total =
        typeof tokenUsage?.total === "object" && tokenUsage.total !== null
          ? (tokenUsage.total as Record<string, unknown>)
          : undefined;
      const count = (value: unknown): number | undefined =>
        typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
      // Same validation as every other field: RuntimeTaskUsage.totalTokens
      // is NonNegativeInt, so NaN/Infinity/negative/fractional wire values
      // must miss — a fraction would fail schema validation at ingestion.
      const totalTokens = count(total?.totalTokens);
      if (totalTokens === undefined) {
        return [];
      }
      const typedUsage: RuntimeTaskUsage = {
        totalTokens,
        ...(count(total?.inputTokens) !== undefined
          ? { inputTokens: count(total?.inputTokens) }
          : {}),
        ...(count(total?.cachedInputTokens) !== undefined
          ? { cachedInputTokens: count(total?.cachedInputTokens) }
          : {}),
        ...(count(total?.outputTokens) !== undefined
          ? { outputTokens: count(total?.outputTokens) }
          : {}),
        ...(count(total?.reasoningOutputTokens) !== undefined
          ? { reasoningOutputTokens: count(total?.reasoningOutputTokens) }
          : {}),
      };
      return [
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description: title,
            ...(knownName ? { title: knownName } : {}),
            typedUsage,
            timelineBypass: true,
          },
        },
      ];
    }
    case "collabAgent/item": {
      const item =
        typeof payload.item === "object" && payload.item !== null
          ? (payload.item as Record<string, unknown>)
          : undefined;
      const itemTypeRaw = typeof item?.type === "string" ? item.type : undefined;
      if (!itemTypeRaw) return [];
      // A loose summary from the raw item: the child stream is untyped at
      // this boundary (synthetic event payload), so read best-effort fields
      // rather than force a schema decode.
      const looseSummary =
        (typeof item?.command === "string" ? item.command : undefined) ??
        (typeof item?.title === "string" ? item.title : undefined) ??
        (typeof item?.query === "string" ? item.query : undefined);
      const canonical = toCanonicalItemType(itemTypeRaw);
      const summary = looseSummary ?? canonical.replaceAll("_", " ");
      // Child message snapshots are authoritative at completion. Preserve their
      // full text in the child transcript rather than a generic progress label.
      if (
        canonical === "assistant_message" &&
        payload.lifecycle === "item/completed" &&
        typeof item?.text === "string" &&
        typeof item.id === "string"
      ) {
        return [
          {
            ...base,
            type: "subagent.message.delta",
            payload: {
              subagentId: RuntimeSubagentId.make(agentThreadId),
              providerThreadId: agentThreadId,
              providerMessageId: item.id,
              delta: item.text,
              role: "assistant",
            },
          },
        ];
      }

      const toolEvents: ProviderRuntimeEvent[] = [];
      if (isToolLifecycleItemType(canonical) && typeof item?.id === "string") {
        const completed =
          payload.lifecycle === "item/completed" ||
          item.status === "completed" ||
          item.status === "failed";
        toolEvents.push({
          ...base,
          eventId: EventId.make(`${base.eventId}:tool`),
          itemId: RuntimeItemId.make(`${agentThreadId}:${item.id}`),
          type: completed ? "item.completed" : "item.updated",
          payload: {
            itemType: canonical,
            status: item.status === "failed" ? "failed" : completed ? "completed" : "inProgress",
            title: summary,
            agentId: agentThreadId,
            ...collabReceiverThreadIds(item),
            data: { item },
          },
        });
      }
      return [
        ...toolEvents,
        {
          ...base,
          type: "task.progress",
          payload: {
            taskId,
            description: title,
            ...(knownName ? { title: knownName } : {}),
            summary,
            timelineBypass: true,
          },
        },
      ];
    }
    case "collabAgent/closed":
      return [
        {
          ...base,
          type: "task.updated",
          payload: { taskId, status: "interrupted", ...statusLinkage },
        },
      ];
    default:
      return [];
  }
}

type CodexEventMapper = (
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
) => ReadonlyArray<ProviderRuntimeEvent>;

/** `session/exited` and `session/closed`: the session ended (`closed` is a graceful exit). */
const mapSessionEnded: CodexEventMapper = (event, canonicalThreadId) => {
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "session.exited",
      payload: {
        ...(event.message ? { reason: event.message } : {}),
        ...(event.method === "session/closed" ? { exitKind: "graceful" } : {}),
      },
    },
  ];
};

/** Thread status, archive, close and compaction notifications: the thread's new state. */
const mapThreadStateChanged: CodexEventMapper = (event, canonicalThreadId) => {
  const payload =
    event.method === "thread/status/changed"
      ? readPayload(EffectCodexSchema.V2ThreadStatusChangedNotification, event.payload)
      : undefined;
  return [
    {
      type: "thread.state.changed",
      ...runtimeEventBase(event, canonicalThreadId),
      payload: {
        state:
          event.method === "thread/archived"
            ? "archived"
            : event.method === "thread/closed"
              ? "closed"
              : event.method === "thread/compacted"
                ? "compacted"
                : payload
                  ? toThreadState(payload.status)
                  : "active",
        ...(event.payload !== undefined ? { detail: event.payload } : {}),
      },
    },
  ];
};

/** A reasoning summary part or a terminal interaction: an update of the item in progress. */
const mapItemProgressUpdated: CodexEventMapper = (event, canonicalThreadId) => {
  return [
    {
      ...runtimeEventBase(event, canonicalThreadId),
      type: "item.updated",
      payload: {
        itemType:
          event.method === "item/reasoning/summaryPartAdded" ? "reasoning" : "command_execution",
        ...(event.payload !== undefined ? { data: event.payload } : {}),
      },
    },
  ];
};

/**
 * The runtime events of every other Codex method, keyed by method. `mapToRuntimeEvents` maps
 * collab-agent, error, optional-question and request events first; the methods below are all
 * distinct, so their order does not matter. Unknown methods map to no events.
 */
const CODEX_EVENT_MAPPERS: ReadonlyMap<string, CodexEventMapper> = new Map(
  Object.entries({
    "item/requestApproval/decision": (event, canonicalThreadId) => {
      if (!event.requestId) return [];
      const payload = readPayload(ApprovalDecisionPayload, event.payload);
      const requestType =
        event.requestKind !== undefined
          ? toRequestTypeFromKind(event.requestKind)
          : toRequestTypeFromMethod(event.method);
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "request.resolved",
          payload: {
            requestType,
            ...(payload ? { decision: payload.decision } : {}),
            ...(event.payload !== undefined ? { resolution: event.payload } : {}),
          },
        },
      ];
    },
    "session/connecting": (event, canonicalThreadId) => {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "session.state.changed",
          payload: {
            state: "starting",
            ...(event.message ? { reason: event.message } : {}),
          },
        },
      ];
    },
    "session/ready": (event, canonicalThreadId) => {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "session.state.changed",
          payload: {
            state: "ready",
            ...(event.message ? { reason: event.message } : {}),
          },
        },
      ];
    },
    "session/started": (event, canonicalThreadId) => {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "session.started",
          payload: {
            ...(event.message ? { message: event.message } : {}),
            ...(event.payload !== undefined ? { resume: event.payload } : {}),
          },
        },
      ];
    },
    "session/exited": mapSessionEnded,
    "session/closed": mapSessionEnded,
    "thread/started": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2ThreadStartedNotification, event.payload);
      if (!payload) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "thread.started",
          payload: {
            providerThreadId: payload.thread.id,
          },
        },
      ];
    },
    "thread/status/changed": mapThreadStateChanged,
    "thread/archived": mapThreadStateChanged,
    "thread/unarchived": mapThreadStateChanged,
    "thread/closed": mapThreadStateChanged,
    "thread/compacted": mapThreadStateChanged,
    "thread/name/updated": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2ThreadNameUpdatedNotification, event.payload);
      return [
        {
          type: "thread.metadata.updated",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            ...(trimText(payload?.threadName) ? { name: trimText(payload?.threadName) } : {}),
            ...(payload
              ? {
                  metadata: {
                    threadId: payload.threadId,
                    ...(payload.threadName !== undefined && payload.threadName !== null
                      ? { threadName: payload.threadName }
                      : {}),
                  },
                }
              : {}),
          },
        },
      ];
    },
    "thread/tokenUsage/updated": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ThreadTokenUsageUpdatedNotification,
        event.payload,
      );
      const normalizedUsage = payload
        ? normalizeCodexTokenUsage(payload.tokenUsage, payload.threadId)
        : undefined;
      if (!normalizedUsage) {
        return [];
      }
      return [
        {
          type: "thread.token-usage.updated",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            usage: normalizedUsage,
          },
        },
      ];
    },
    "thread/goal/updated": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2ThreadGoalUpdatedNotification, event.payload);
      const goal = payload ? normalizeCodexThreadGoal(payload.goal) : null;
      if (!goal) {
        return [];
      }
      return [
        {
          type: "thread.goal.updated",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: { goal },
        },
      ];
    },
    "thread/goal/cleared": (event, canonicalThreadId) => {
      if (!readPayload(EffectCodexSchema.V2ThreadGoalClearedNotification, event.payload)) {
        return [];
      }
      return [
        {
          type: "thread.goal.cleared",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {},
        },
      ];
    },
    "turn/started": (event, canonicalThreadId) => {
      const turnId = event.turnId;
      if (!turnId) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          turnId,
          type: "turn.started",
          payload: {},
        },
      ];
    },
    "turn/completed": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2TurnCompletedNotification, event.payload);
      const completed = payload
        ? {
            status: toTurnStatus(payload.turn.status),
            errorMessage: trimText(payload.turn.error?.message),
          }
        : readTurnCompletedStructurally(event.payload);
      if (!completed) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.completed",
          payload: {
            state: completed.status,
            ...(completed.errorMessage ? { errorMessage: completed.errorMessage } : {}),
          },
        },
      ];
    },
    "turn/aborted": (event, canonicalThreadId) => {
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.aborted",
          payload: {
            reason: event.message ?? "Turn aborted",
          },
        },
      ];
    },
    "turn/plan/updated": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2TurnPlanUpdatedNotification, event.payload);
      if (!payload) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.plan.updated",
          payload: {
            ...(trimText(payload.explanation)
              ? { explanation: trimText(payload.explanation) }
              : {}),
            plan: payload.plan.map((step) => ({
              step: trimText(step.step) ?? "step",
              status:
                step.status === "completed" || step.status === "inProgress"
                  ? step.status
                  : "pending",
            })),
          },
        },
      ];
    },
    "turn/diff/updated": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2TurnDiffUpdatedNotification, event.payload);
      if (!payload) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.diff.updated",
          payload: {
            unifiedDiff: payload.diff,
          },
        },
      ];
    },
    "item/started": (event, canonicalThreadId) => {
      const started = mapItemLifecycle(event, canonicalThreadId, "item.started");
      return started ? [started] : [];
    },
    "item/completed": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2ItemCompletedNotification, event.payload);
      const item = payload?.item;
      if (!item) {
        return [];
      }
      const itemType = toCanonicalItemType(item.type);
      if (itemType === "plan") {
        const detail = itemDetail(item);
        if (!detail) {
          return [];
        }
        return [
          {
            ...runtimeEventBase(event, canonicalThreadId),
            type: "turn.proposed.completed",
            payload: {
              planMarkdown: detail,
            },
          },
        ];
      }
      const completed = mapItemLifecycle(event, canonicalThreadId, "item.completed");
      return completed ? [completed] : [];
    },
    "item/reasoning/summaryPartAdded": mapItemProgressUpdated,
    "item/commandExecution/terminalInteraction": mapItemProgressUpdated,
    "item/plan/delta": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2PlanDeltaNotification, event.payload);
      const delta = event.textDelta ?? payload?.delta;
      if (!delta || delta.length === 0) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "turn.proposed.delta",
          payload: {
            delta,
          },
        },
      ];
    },
    "item/agentMessage/delta": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2AgentMessageDeltaNotification, event.payload);
      const delta = event.textDelta ?? payload?.delta;
      if (!delta || delta.length === 0) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "content.delta",
          payload: {
            streamKind: contentStreamKindFromMethod(event.method),
            delta,
          },
        },
      ];
    },
    "item/commandExecution/outputDelta": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2CommandExecutionOutputDeltaNotification,
        event.payload,
      );
      const delta = event.textDelta ?? payload?.delta;
      if (!delta || delta.length === 0) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "content.delta",
          payload: {
            streamKind: "command_output",
            delta,
          },
        },
      ];
    },
    "item/fileChange/outputDelta": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2FileChangeOutputDeltaNotification,
        event.payload,
      );
      const delta = event.textDelta ?? payload?.delta;
      if (!delta || delta.length === 0) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "content.delta",
          payload: {
            streamKind: "file_change_output",
            delta,
          },
        },
      ];
    },
    "item/reasoning/summaryTextDelta": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ReasoningSummaryTextDeltaNotification,
        event.payload,
      );
      const delta = event.textDelta ?? payload?.delta;
      if (!delta || delta.length === 0) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "content.delta",
          payload: {
            streamKind: "reasoning_summary_text",
            delta,
            ...(payload ? { summaryIndex: payload.summaryIndex } : {}),
          },
        },
      ];
    },
    "item/reasoning/textDelta": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ReasoningTextDeltaNotification,
        event.payload,
      );
      const delta = event.textDelta ?? payload?.delta;
      if (!delta || delta.length === 0) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "content.delta",
          payload: {
            streamKind: "reasoning_text",
            delta,
            ...(payload ? { contentIndex: payload.contentIndex } : {}),
          },
        },
      ];
    },
    "item/mcpToolCall/progress": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2McpToolCallProgressNotification,
        event.payload,
      );
      if (!payload) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "tool.progress",
          payload: {
            summary: payload.message,
          },
        },
      ];
    },
    "serverRequest/resolved": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ServerRequestResolvedNotification,
        event.payload,
      );
      if (!payload) {
        return [];
      }
      const requestType = toRequestTypeFromKind(event.requestKind);
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "request.resolved",
          payload: {
            requestType,
            ...(event.payload !== undefined ? { resolution: event.payload } : {}),
          },
        },
      ];
    },
    "mcpServer/elicitation/request/answered": (event, canonicalThreadId) => {
      const payload = readPayload(
        Schema.Struct({
          answers: Schema.Record(Schema.String, Schema.Unknown),
          cancelled: Schema.optional(Schema.Boolean),
        }),
        event.payload,
      );
      return payload && event.requestId
        ? [
            {
              ...runtimeEventBase(event, canonicalThreadId),
              type: "user-input.resolved",
              payload: {
                answers: payload.answers,
                ...(payload.cancelled ? { cancelled: true } : {}),
              },
            },
          ]
        : [];
    },
    "item/tool/requestUserInput/answered": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.ToolRequestUserInputResponse, event.payload);
      if (!payload) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.resolved",
          payload: {
            answers: toCanonicalUserInputAnswers(payload.answers),
          },
        },
      ];
    },
    "model/rerouted": (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2ModelReroutedNotification, event.payload);
      if (!payload) {
        return [];
      }
      return [
        {
          type: "model.rerouted",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            fromModel: payload.fromModel,
            toModel: payload.toModel,
            reason: payload.reason,
          },
        },
      ];
    },
    deprecationNotice: (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2DeprecationNoticeNotification, event.payload);
      if (!payload) {
        return [];
      }
      return [
        {
          type: "deprecation.notice",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            summary: payload.summary,
            ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
          },
        },
      ];
    },
    configWarning: (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2ConfigWarningNotification, event.payload);
      if (!payload) {
        return [];
      }
      return [
        {
          type: "config.warning",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            summary: payload.summary,
            ...(trimText(payload.details) ? { details: trimText(payload.details) } : {}),
            ...(trimText(payload.path) ? { path: trimText(payload.path) } : {}),
            ...(payload.range !== undefined && payload.range !== null
              ? { range: payload.range }
              : {}),
          },
        },
      ];
    },
    "account/updated": (event, canonicalThreadId) => {
      if (!readPayload(EffectCodexSchema.V2AccountUpdatedNotification, event.payload)) {
        return [];
      }
      return [
        {
          type: "account.updated",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            account: event.payload ?? {},
          },
        },
      ];
    },
    "account/rateLimits/updated": (event, canonicalThreadId) => {
      if (!readPayload(EffectCodexSchema.V2AccountRateLimitsUpdatedNotification, event.payload)) {
        return [];
      }
      return [
        {
          type: "account.rate-limits.updated",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            rateLimits: event.payload ?? {},
          },
        },
      ];
    },
    "mcpServer/oauthLogin/completed": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2McpServerOauthLoginCompletedNotification,
        event.payload,
      );
      if (!payload) {
        return [];
      }
      return [
        {
          type: "mcp.oauth.completed",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            success: payload.success,
            name: payload.name,
            ...(trimText(payload.error) ? { error: trimText(payload.error) } : {}),
          },
        },
      ];
    },
    "thread/realtime/started": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ThreadRealtimeStartedNotification,
        event.payload,
      );
      if (!payload) {
        return [];
      }
      return [
        {
          type: "thread.realtime.started",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            realtimeSessionId: payload.realtimeSessionId ?? undefined,
          },
        },
      ];
    },
    "thread/realtime/itemAdded": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ThreadRealtimeItemAddedNotification,
        event.payload,
      );
      if (!payload) {
        return [];
      }
      return [
        {
          type: "thread.realtime.item-added",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            item: payload.item,
          },
        },
      ];
    },
    "thread/realtime/outputAudio/delta": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ThreadRealtimeOutputAudioDeltaNotification,
        event.payload,
      );
      if (!payload) {
        return [];
      }
      return [
        {
          type: "thread.realtime.audio.delta",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            audio: payload.audio,
          },
        },
      ];
    },
    "thread/realtime/error": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ThreadRealtimeErrorNotification,
        event.payload,
      );
      const message = payload?.message ?? event.message ?? "Realtime error";
      return [
        {
          type: "thread.realtime.error",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            message,
          },
        },
      ];
    },
    "thread/realtime/closed": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2ThreadRealtimeClosedNotification,
        event.payload,
      );
      return [
        {
          type: "thread.realtime.closed",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            reason: payload?.reason ?? event.message,
          },
        },
      ];
    },
    error: (event, canonicalThreadId) => {
      const payload = readPayload(EffectCodexSchema.V2ErrorNotification, event.payload);
      const message = payload?.error.message ?? event.message ?? "Provider runtime error";
      const willRetry = payload?.willRetry === true;
      return [
        {
          type: willRetry ? "runtime.warning" : "runtime.error",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            message,
            ...(!willRetry ? { class: "provider_error" as const } : {}),
            ...(event.payload !== undefined ? { detail: event.payload } : {}),
          },
        },
      ];
    },
    "process/stderr": (event, canonicalThreadId) => {
      const message = event.message ?? "Codex process stderr";
      const isFatal = isFatalCodexStderrMessage(message);
      return [
        isFatal
          ? {
              type: "runtime.error",
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message,
                class: "provider_error" as const,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            }
          : {
              type: "runtime.warning",
              ...runtimeEventBase(event, canonicalThreadId),
              payload: {
                message,
                ...(event.payload !== undefined ? { detail: event.payload } : {}),
              },
            },
      ];
    },
    "windows/worldWritableWarning": (event, canonicalThreadId) => {
      if (
        !readPayload(EffectCodexSchema.V2WindowsWorldWritableWarningNotification, event.payload)
      ) {
        return [];
      }
      return [
        {
          type: "runtime.warning",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            message: event.message ?? "Windows world-writable warning",
            ...(event.payload !== undefined ? { detail: event.payload } : {}),
          },
        },
      ];
    },
    "windowsSandbox/setupCompleted": (event, canonicalThreadId) => {
      const payload = readPayload(
        EffectCodexSchema.V2WindowsSandboxSetupCompletedNotification,
        event.payload,
      );
      if (!payload) {
        return [];
      }
      const successMessage = event.message ?? "Windows sandbox setup completed";
      const failureMessage = event.message ?? "Windows sandbox setup failed";

      return [
        {
          type: "session.state.changed",
          ...runtimeEventBase(event, canonicalThreadId),
          payload: {
            state: payload.success === false ? "error" : "ready",
            reason: payload.success === false ? failureMessage : successMessage,
            ...(event.payload !== undefined ? { detail: event.payload } : {}),
          },
        },
        ...(payload.success === false
          ? [
              {
                type: "runtime.warning" as const,
                ...runtimeEventBase(event, canonicalThreadId),
                payload: {
                  message: failureMessage,
                  ...(event.payload !== undefined ? { detail: event.payload } : {}),
                },
              },
            ]
          : []),
      ];
    },
  } satisfies Record<string, CodexEventMapper>),
);

export function mapToRuntimeEvents(
  event: ProviderEvent,
  canonicalThreadId: ThreadId,
): ReadonlyArray<ProviderRuntimeEvent> {
  if (event.kind === "notification" && event.method.startsWith("collabAgent/")) {
    return mapCollabAgentEvent(event, canonicalThreadId);
  }
  if (event.kind === "error") {
    if (!event.message) {
      return [];
    }
    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "runtime.error",
        payload: {
          message: event.message,
          class: "provider_error",
          ...(event.payload !== undefined ? { detail: event.payload } : {}),
        },
      },
    ];
  }

  if (event.kind === "notification" && event.method === "item/agentMessage/optionalQuestions") {
    const payload = readPayload(
      Schema.Struct({ questions: Schema.Array(UserInputQuestion) }),
      event.payload,
    );
    return payload && event.requestId && event.turnId && event.itemId
      ? [
          {
            ...runtimeEventBase(event, canonicalThreadId),
            type: "user-input.requested",
            payload: { questions: payload.questions, nonBlocking: true },
          },
        ]
      : [];
  }

  if (event.kind === "request") {
    if (event.method === "mcpServer/elicitation/request") {
      // The runtime already turned the elicitation into questions (`codexMcpElicitation.ts`).
      const payload = readPayload(
        Schema.Struct({ questions: Schema.Array(UserInputQuestion) }),
        event.payload,
      );
      return payload && payload.questions.length > 0 && event.requestId
        ? [
            {
              ...runtimeEventBase(event, canonicalThreadId),
              type: "user-input.requested",
              payload: { questions: payload.questions },
            },
          ]
        : [];
    }
    if (event.method === "item/tool/requestUserInput") {
      const payload =
        readPayload(EffectCodexSchema.ServerRequest__ToolRequestUserInputParams, event.payload) ??
        readPayload(EffectCodexSchema.ToolRequestUserInputParams, event.payload);
      const questions = payload ? toUserInputQuestions(payload.questions) : undefined;
      if (!questions) {
        return [];
      }
      return [
        {
          ...runtimeEventBase(event, canonicalThreadId),
          type: "user-input.requested",
          payload: {
            questions,
          },
        },
      ];
    }

    const detail = (() => {
      switch (event.method) {
        case "item/commandExecution/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__CommandExecutionRequestApprovalParams,
            event.payload,
          );
          return payload?.command ?? payload?.reason ?? undefined;
        }
        case "item/fileChange/requestApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__FileChangeRequestApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "applyPatchApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ApplyPatchApprovalParams,
            event.payload,
          );
          return payload?.reason ?? undefined;
        }
        case "execCommandApproval": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__ExecCommandApprovalParams,
            event.payload,
          );
          return payload?.reason ?? payload?.command.join(" ");
        }
        case "item/tool/call": {
          const payload = readPayload(
            EffectCodexSchema.ServerRequest__DynamicToolCallParams,
            event.payload,
          );
          return payload?.tool ?? undefined;
        }
        default:
          return undefined;
      }
    })();

    return [
      {
        ...runtimeEventBase(event, canonicalThreadId),
        type: "request.opened",
        payload: {
          requestType: toRequestTypeFromMethod(event.method),
          ...(detail ? { detail } : {}),
          ...(event.payload !== undefined ? { args: event.payload } : {}),
        },
      },
    ];
  }

  return CODEX_EVENT_MAPPERS.get(event.method)?.(event, canonicalThreadId) ?? [];
}

/**
 * Build a Codex provider adapter bound to a specific `CodexSettings` payload.
 *
 * The adapter is a captured closure over `codexConfig` — the `binaryPath` and
 * `homePath` are read from that payload, not from `ServerSettingsService`.
 * This is what makes multi-instance routing possible: each `ProviderInstance`
 * in the registry owns its own closure with its own config, so two Codex
 * instances with different `homePath`s cannot step on each other.
 */
