import { extractToolResultText, extractToolContentText } from "@ryco/shared/toolOutput";
import type * as EffectAcpSchema from "effect-acp/schema";
import { deriveToolActivityPresentation } from "@ryco/shared/toolActivity";
import {
  ProviderItemId,
  RuntimeSubagentId,
  type RuntimeSubagentStatus,
  type SubagentRef,
  type ThreadTokenUsageSnapshot,
  type ToolLifecycleItemType,
} from "@ryco/contracts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface AcpSessionMode {
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface AcpSessionModeState {
  readonly currentModeId: string;
  readonly availableModes: ReadonlyArray<AcpSessionMode>;
}

export interface AcpToolCallState {
  readonly toolCallId: string;
  readonly kind?: string;
  readonly title?: string;
  readonly status?: "pending" | "inProgress" | "completed" | "failed";
  readonly command?: string;
  readonly detail?: string;
  readonly subagent?: AcpSubagentSummaryState;
  readonly data: Record<string, unknown>;
}

export interface AcpSubagentSummaryState {
  readonly subagent: SubagentRef;
  readonly status?: RuntimeSubagentStatus;
  readonly summary?: string;
  readonly detail?: string;
}

export interface AcpPlanUpdate {
  readonly explanation?: string | null;
  readonly plan: ReadonlyArray<{
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
}

export interface AcpPermissionRequest {
  readonly kind: string | "unknown";
  readonly detail?: string;
  readonly toolCall?: AcpToolCallState;
}

export type AcpParsedSessionEvent =
  | {
      readonly _tag: "ModeChanged";
      readonly modeId: string;
    }
  | {
      readonly _tag: "AssistantItemStarted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "AssistantItemCompleted";
      readonly itemId: string;
    }
  | {
      readonly _tag: "PlanUpdated";
      readonly payload: AcpPlanUpdate;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ToolCallUpdated";
      readonly toolCall: AcpToolCallState;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ContentDelta";
      readonly itemId?: string;
      readonly text: string;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "ThoughtDelta";
      readonly text: string;
      readonly rawPayload: unknown;
    }
  | {
      readonly _tag: "UsageUpdated";
      readonly usage: ThreadTokenUsageSnapshot;
      readonly rawPayload: unknown;
    };

type AcpSessionSetupResponse =
  | EffectAcpSchema.LoadSessionResponse
  | EffectAcpSchema.NewSessionResponse
  | EffectAcpSchema.ResumeSessionResponse;

type AcpToolCallUpdate = Extract<
  EffectAcpSchema.SessionNotification["update"],
  { readonly sessionUpdate: "tool_call" | "tool_call_update" }
>;

export function extractModelConfigId(sessionResponse: AcpSessionSetupResponse): string | undefined {
  const configOptions = sessionResponse.configOptions;
  if (!configOptions) return undefined;
  for (const opt of configOptions) {
    if (opt.category === "model" && opt.id.trim().length > 0) {
      return opt.id.trim();
    }
  }
  return undefined;
}

export function findSessionConfigOption(
  configOptions: ReadonlyArray<EffectAcpSchema.SessionConfigOption> | null | undefined,
  configId: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  if (!configOptions) {
    return undefined;
  }
  const normalizedConfigId = configId.trim();
  if (!normalizedConfigId) {
    return undefined;
  }
  return configOptions.find((option) => option.id.trim() === normalizedConfigId);
}

export function collectSessionConfigOptionValues(
  configOption: EffectAcpSchema.SessionConfigOption,
): ReadonlyArray<string> {
  if (configOption.type !== "select") {
    return [];
  }
  return configOption.options.flatMap((entry) =>
    "value" in entry ? [entry.value] : entry.options.map((option) => option.value),
  );
}

export function parseSessionModeState(
  sessionResponse: AcpSessionSetupResponse,
): AcpSessionModeState | undefined {
  const modes = sessionResponse.modes;
  if (!modes) return undefined;
  const currentModeId = modes.currentModeId.trim();
  if (!currentModeId) {
    return undefined;
  }
  const availableModes = modes.availableModes
    .map((mode) => {
      const id = mode.id.trim();
      const name = mode.name.trim();
      if (!id || !name) {
        return undefined;
      }
      const description = mode.description?.trim() || undefined;
      return description !== undefined
        ? ({ id, name, description } satisfies AcpSessionMode)
        : ({ id, name } satisfies AcpSessionMode);
    })
    .filter((mode): mode is AcpSessionMode => mode !== undefined);
  if (availableModes.length === 0) {
    return undefined;
  }
  return {
    currentModeId,
    availableModes,
  };
}

function normalizePlanStepStatus(raw: unknown): "pending" | "inProgress" | "completed" {
  switch (raw) {
    case "completed":
      return "completed";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    default:
      return "pending";
  }
}

function normalizeToolCallStatus(
  raw: unknown,
  fallback?: "pending" | "inProgress" | "completed" | "failed",
): "pending" | "inProgress" | "completed" | "failed" | undefined {
  switch (raw) {
    case "pending":
      return "pending";
    case "in_progress":
    case "inProgress":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return fallback;
  }
}

function normalizeCommandValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const parts = value
    .map((entry) => (typeof entry === "string" && entry.trim().length > 0 ? entry.trim() : null))
    .filter((entry): entry is string => entry !== null);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function extractCommandFromTitle(title: string | undefined): string | undefined {
  if (!title) {
    return undefined;
  }
  const match = /`([^`]+)`/.exec(title);
  return match?.[1]?.trim() || undefined;
}

function extractToolCallCommand(rawInput: unknown, title: string | undefined): string | undefined {
  if (isRecord(rawInput)) {
    const directCommand = normalizeCommandValue(rawInput.command);
    if (directCommand) {
      return directCommand;
    }
    const executable = typeof rawInput.executable === "string" ? rawInput.executable.trim() : "";
    const args = normalizeCommandValue(rawInput.args);
    if (executable && args) {
      return `${executable} ${args}`;
    }
    if (executable) {
      return executable;
    }
  }
  return extractCommandFromTitle(title);
}

function extractTextContentFromToolCallContent(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): string | undefined {
  if (!content) return undefined;
  const chunks = content
    .map((entry) => {
      if (entry.type !== "content") {
        return undefined;
      }
      const nestedContent = entry.content;
      if (nestedContent.type !== "text") {
        return undefined;
      }
      return nestedContent.text.trim().length > 0 ? nestedContent.text.trim() : undefined;
    })
    .filter((entry): entry is string => entry !== undefined);
  return chunks.length > 0 ? chunks.join("\n") : undefined;
}

export interface AcpToolCallChange {
  readonly path: string;
  readonly diff?: string;
  readonly additions?: number;
  readonly deletions?: number;
}

/**
 * Above this many changed lines per side the LCS diff is skipped (quadratic
 * memory); counts stay exact via multiset comparison instead.
 */
const UNIFIED_DIFF_MIDDLE_LINE_CAP = 2_000;
/** LCS DP table cell budget for the changed middle region after prefix/suffix trim. */
const UNIFIED_DIFF_LCS_CELL_CAP = 400_000;

function splitDiffLines(text: string): string[] {
  const lines = text.split("\n");
  const last = lines[lines.length - 1];
  if (lines.length > 1 && last === "") {
    lines.pop();
  }
  return lines;
}

function countLineChanges(
  oldLines: ReadonlyArray<string>,
  newLines: ReadonlyArray<string>,
): { readonly additions: number; readonly deletions: number } {
  const oldCounts = new Map<string, number>();
  for (const line of oldLines) {
    oldCounts.set(line, (oldCounts.get(line) ?? 0) + 1);
  }
  let additions = 0;
  for (const line of newLines) {
    const remaining = oldCounts.get(line) ?? 0;
    if (remaining > 0) {
      oldCounts.set(line, remaining - 1);
    } else {
      additions += 1;
    }
  }
  let deletions = 0;
  for (const count of oldCounts.values()) {
    deletions += count;
  }
  return { additions, deletions };
}

function diffMiddleLines(
  middleOld: ReadonlyArray<string>,
  middleNew: ReadonlyArray<string>,
): Array<{ readonly marker: "-" | "+" | " "; readonly text: string }> {
  if (middleOld.length * middleNew.length > UNIFIED_DIFF_LCS_CELL_CAP) {
    return [
      ...middleOld.map((text) => ({ marker: "-" as const, text })),
      ...middleNew.map((text) => ({ marker: "+" as const, text })),
    ];
  }
  const rows = middleOld.length;
  const cols = middleNew.length;
  const table = new Uint32Array((rows + 1) * (cols + 1));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      const diagonal = table[(i + 1) * (cols + 1) + j + 1] ?? 0;
      const down = table[(i + 1) * (cols + 1) + j] ?? 0;
      const right = table[i * (cols + 1) + j + 1] ?? 0;
      const oldLine = middleOld[i];
      const newLine = middleNew[j];
      table[i * (cols + 1) + j] =
        oldLine !== undefined && newLine !== undefined && oldLine === newLine
          ? diagonal + 1
          : Math.max(down, right);
    }
  }
  const ops: Array<{ readonly marker: "-" | "+" | " "; readonly text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    const oldLine = middleOld[i];
    const newLine = middleNew[j];
    if (oldLine !== undefined && newLine !== undefined && oldLine === newLine) {
      ops.push({ marker: " ", text: oldLine });
      i += 1;
      j += 1;
    } else if (
      oldLine !== undefined &&
      (newLine === undefined ||
        (table[(i + 1) * (cols + 1) + j] ?? 0) >= (table[i * (cols + 1) + j + 1] ?? 0))
    ) {
      ops.push({ marker: "-", text: oldLine });
      i += 1;
    } else if (newLine !== undefined) {
      ops.push({ marker: "+", text: newLine });
      j += 1;
    } else {
      break;
    }
  }
  while (i < rows) {
    const oldLine = middleOld[i];
    if (oldLine !== undefined) {
      ops.push({ marker: "-", text: oldLine });
    }
    i += 1;
  }
  while (j < cols) {
    const newLine = middleNew[j];
    if (newLine !== undefined) {
      ops.push({ marker: "+", text: newLine });
    }
    j += 1;
  }
  return ops;
}

function buildLineUnifiedDiff(path: string, oldText: string, newText: string): string | undefined {
  const oldLines = splitDiffLines(oldText);
  const newLines = splitDiffLines(newText);
  if (
    oldLines.length > UNIFIED_DIFF_MIDDLE_LINE_CAP ||
    newLines.length > UNIFIED_DIFF_MIDDLE_LINE_CAP
  ) {
    return undefined;
  }
  let start = 0;
  while (
    start < oldLines.length &&
    start < newLines.length &&
    oldLines[start] === newLines[start]
  ) {
    start += 1;
  }
  let endOld = oldLines.length;
  let endNew = newLines.length;
  while (
    endOld > start &&
    endNew > start &&
    oldLines[endOld - 1] === newLines[endNew - 1] &&
    oldLines[endOld - 1] !== undefined
  ) {
    endOld -= 1;
    endNew -= 1;
  }
  const middleOld = oldLines.slice(start, endOld);
  const middleNew = newLines.slice(start, endNew);
  if (middleOld.length === 0 && middleNew.length === 0) {
    return undefined;
  }
  const ops = diffMiddleLines(middleOld, middleNew);
  const header =
    `--- a/${path}\n+++ b/${path}\n` +
    `@@ -${middleOld.length > 0 ? start + 1 : start},${middleOld.length} ` +
    `+${middleNew.length > 0 ? start + 1 : start},${middleNew.length} @@\n`;
  return header + ops.map((op) => `${op.marker}${op.text}`).join("\n");
}

/**
 * Normalizes ACP `type: "diff"` tool-call content into the shared
 * `changes[{path, diff, additions, deletions}]` shape the web fold already
 * consumes generically (same convention as Codex `fileChange` items).
 */
export function extractToolCallChanges(
  content: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined,
): Array<AcpToolCallChange> | undefined {
  if (!content) return undefined;
  const changes: Array<AcpToolCallChange> = [];
  for (const entry of content) {
    if (entry.type !== "diff" || !entry.path.trim()) {
      continue;
    }
    const path = entry.path.trim();
    const oldText = entry.oldText ?? "";
    const newText = entry.newText ?? "";
    const { additions, deletions } = countLineChanges(
      splitDiffLines(oldText),
      splitDiffLines(newText),
    );
    const diff =
      oldText.length > 0 || newText.length > 0
        ? buildLineUnifiedDiff(path, oldText, newText)
        : undefined;
    changes.push({
      path,
      ...(additions > 0 || deletions > 0 ? { additions, deletions } : {}),
      ...(diff !== undefined ? { diff } : {}),
    });
  }
  return changes.length > 0 ? changes : undefined;
}

function normalizeToolKind(kind: unknown): string | undefined {
  return typeof kind === "string" && kind.trim().length > 0 ? kind.trim() : undefined;
}

function firstToolCallLocationPath(
  locations: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined,
): string | undefined {
  for (const location of locations ?? []) {
    const path = typeof location.path === "string" ? location.path.trim() : "";
    if (path) {
      return path;
    }
  }
  return undefined;
}

function containsSubagentKeyword(value: string | undefined): boolean {
  return value !== undefined && /\b(sub[-\s]?agent|subtask|delegate|delegation)\b/i.test(value);
}

function hasExplicitSubagentType(data: Record<string, unknown> | undefined): boolean {
  const rawInput = isRecord(data?.rawInput) ? data.rawInput : undefined;
  const subagentType = rawInput?.subagent_type;
  return typeof subagentType === "string" && subagentType.trim().length > 0;
}

export function isAcpSubagentToolCall(input: {
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly command?: string | undefined;
  readonly detail?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): boolean {
  if (hasExplicitSubagentType(input.data)) return true;
  // Descriptions, shell commands, search queries and file paths are user data,
  // not evidence that a tool spawned an agent.
  if (input.kind && input.kind !== "other" && !containsSubagentKeyword(input.kind)) return false;
  const rawInput = isRecord(input.data?.rawInput) ? input.data.rawInput : undefined;
  const namedDelegation = (value: unknown) =>
    typeof value === "string" &&
    /^(?:sub[-_ ]?agent|subtask|delegate|delegation|spawn_agent|delegate_task)$/i.test(
      value.trim(),
    );
  return (
    namedDelegation(input.kind) ||
    namedDelegation(rawInput?.tool) ||
    namedDelegation(rawInput?.name) ||
    (input.title !== undefined &&
      /^(?:(?:launch|spawn|run|start)\s+)?(?:sub[-\s]?agent|subtask|delegate|delegation)(?:$|[:\s])/i.test(
        input.title,
      ))
  );
}

function canonicalItemTypeFromAcpTool(input: {
  readonly kind: string | undefined;
  readonly title?: string | undefined;
  readonly command?: string | undefined;
  readonly detail?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): ToolLifecycleItemType {
  if (isAcpSubagentToolCall(input)) {
    return "collab_agent_tool_call";
  }
  const kind = input.kind;
  switch (kind) {
    case "execute":
      return "command_execution";
    case "edit":
    case "delete":
    case "move":
      return "file_change";
    case "search":
    case "fetch":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

function acpSubagentStatusFromToolStatus(
  status: AcpToolCallState["status"],
): RuntimeSubagentStatus | undefined {
  switch (status) {
    case "pending":
      return "starting";
    case "inProgress":
      return "running";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    default:
      return undefined;
  }
}

function rawInputStringField(
  data: Record<string, unknown> | undefined,
  field: string,
): string | undefined {
  const rawInput = isRecord(data?.rawInput) ? data.rawInput : undefined;
  if (!rawInput) {
    return undefined;
  }
  const value = rawInput[field];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function makeAcpSubagentSummaryState(input: {
  readonly toolCallId: string;
  readonly kind?: string | undefined;
  readonly title?: string | undefined;
  readonly status?: AcpToolCallState["status"];
  readonly command?: string | undefined;
  readonly detail?: string | undefined;
  readonly data?: Record<string, unknown> | undefined;
}): AcpSubagentSummaryState | undefined {
  if (!isAcpSubagentToolCall(input)) {
    return undefined;
  }

  const label = input.title ?? rawInputStringField(input.data, "name") ?? "ACP subagent";
  const detail =
    input.detail ??
    rawInputStringField(input.data, "description") ??
    rawInputStringField(input.data, "prompt") ??
    input.command;
  const metadata = Object.fromEntries(
    [
      ["source", "acp.tool_call"],
      ["kind", input.kind],
      ["command", input.command],
    ].filter(([, value]) => value !== undefined),
  );
  const status = acpSubagentStatusFromToolStatus(input.status);
  const output =
    extractToolResultText(input.data?.rawOutput) ?? extractToolContentText(input.data?.content);
  const model = rawInputStringField(input.data, "model");
  const role = rawInputStringField(input.data, "subagent_type");

  return {
    subagent: {
      subagentId: RuntimeSubagentId.make(input.toolCallId),
      origin: "inferred",
      capability: "summary",
      label,
      ...(detail ? { description: detail } : {}),
      parentProviderItemId: ProviderItemId.make(input.toolCallId),
      ...(model ? { model } : {}),
      metadata: { ...metadata, ...(role ? { role } : {}) },
    },
    ...(status ? { status } : {}),
    summary: (status === "completed" || status === "failed") && output ? output : label,
    ...(detail ? { detail } : {}),
  };
}

function makeToolCallState(
  input: {
    readonly toolCallId: string;
    readonly title?: string | null | undefined;
    readonly kind?: EffectAcpSchema.ToolKind | null | undefined;
    readonly status?: EffectAcpSchema.ToolCallStatus | null | undefined;
    readonly rawInput?: unknown;
    readonly rawOutput?: unknown;
    readonly content?: ReadonlyArray<EffectAcpSchema.ToolCallContent> | null | undefined;
    readonly locations?: ReadonlyArray<EffectAcpSchema.ToolCallLocation> | null | undefined;
  },
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  const toolCallId = input.toolCallId.trim();
  if (!toolCallId) {
    return undefined;
  }
  const title = input.title?.trim() || undefined;
  const command = extractToolCallCommand(input.rawInput, title);
  const textContent = extractTextContentFromToolCallContent(input.content);
  const normalizedTitle =
    title && title.toLowerCase() !== "terminal" && title.toLowerCase() !== "tool call"
      ? title
      : undefined;
  const data: Record<string, unknown> = { toolCallId };
  const kind = normalizeToolKind(input.kind);
  if (kind) {
    data.kind = kind;
  }
  if (command) {
    data.command = command;
  }
  if (input.rawInput !== undefined) {
    data.rawInput = input.rawInput;
  }
  if (input.rawOutput !== undefined) {
    data.rawOutput = input.rawOutput;
  }
  if (input.content !== undefined) {
    data.content = input.content;
  }
  if (input.locations !== undefined) {
    data.locations = input.locations;
  }
  const changes = extractToolCallChanges(input.content);
  if (changes) {
    data.changes = changes;
  }
  const primaryPath = changes?.[0]?.path ?? firstToolCallLocationPath(input.locations);
  if (primaryPath) {
    data.path = primaryPath;
  }
  const fallbackDetail = command ?? normalizedTitle ?? textContent;
  const hasPresentationSeed =
    title !== undefined ||
    kind !== undefined ||
    command !== undefined ||
    normalizedTitle !== undefined ||
    textContent !== undefined;
  const presentation = hasPresentationSeed
    ? deriveToolActivityPresentation({
        itemType: canonicalItemTypeFromAcpTool({
          kind,
          title,
          command,
          detail: fallbackDetail,
          data,
        }),
        title,
        detail: fallbackDetail,
        data,
        fallbackSummary: title ?? "Tool",
      })
    : undefined;
  const status = normalizeToolCallStatus(input.status, options?.fallbackStatus);
  const subagent = makeAcpSubagentSummaryState({
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(presentation?.summary ? { title: presentation.summary } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(presentation?.detail ? { detail: presentation.detail } : {}),
    data,
  });
  return {
    toolCallId,
    ...(kind ? { kind } : {}),
    ...(presentation?.summary ? { title: presentation.summary } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(presentation?.detail ? { detail: presentation.detail } : {}),
    ...(subagent ? { subagent } : {}),
    data,
  };
}

function parseTypedToolCallState(
  event: AcpToolCallUpdate,
  options?: {
    readonly fallbackStatus?: "pending" | "inProgress" | "completed" | "failed";
  },
): AcpToolCallState | undefined {
  return makeToolCallState(
    {
      toolCallId: event.toolCallId,
      title: event.title,
      kind: event.kind,
      status: event.status,
      rawInput: event.rawInput,
      rawOutput: event.rawOutput,
      content: event.content,
      locations: event.locations,
    },
    options,
  );
}

export function mergeToolCallState(
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
): AcpToolCallState {
  const nextKind = typeof next.data.kind === "string" ? next.data.kind : undefined;
  const kind = nextKind ?? previous?.kind;
  const title = next.title ?? previous?.title;
  const status = next.status ?? previous?.status;
  const command = next.command ?? previous?.command;
  const detail = next.detail ?? previous?.detail;
  const data = {
    ...previous?.data,
    ...next.data,
  };
  const subagent = makeAcpSubagentSummaryState({
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    data,
  });
  return {
    toolCallId: next.toolCallId,
    ...(kind ? { kind } : {}),
    ...(title ? { title } : {}),
    ...(status ? { status } : {}),
    ...(command ? { command } : {}),
    ...(detail ? { detail } : {}),
    ...(subagent ? { subagent } : {}),
    data,
  };
}

export function parsePermissionRequest(
  params: EffectAcpSchema.RequestPermissionRequest,
): AcpPermissionRequest {
  const toolCall = makeToolCallState(
    {
      toolCallId: params.toolCall.toolCallId,
      title: params.toolCall.title,
      kind: params.toolCall.kind,
      status: params.toolCall.status,
      rawInput: params.toolCall.rawInput,
      rawOutput: params.toolCall.rawOutput,
      content: params.toolCall.content,
      locations: params.toolCall.locations,
    },
    { fallbackStatus: "pending" },
  );
  const kind = normalizeToolKind(params.toolCall.kind) ?? "unknown";
  const detail =
    toolCall?.command ??
    toolCall?.title ??
    toolCall?.detail ??
    (typeof params.sessionId === "string" ? `Session ${params.sessionId}` : undefined);
  return {
    kind,
    ...(detail ? { detail } : {}),
    ...(toolCall ? { toolCall } : {}),
  };
}

export function parseSessionUpdateEvent(params: EffectAcpSchema.SessionNotification): {
  readonly modeId?: string;
  readonly events: ReadonlyArray<AcpParsedSessionEvent>;
} {
  const upd = params.update;
  const events: Array<AcpParsedSessionEvent> = [];
  let modeId: string | undefined;

  switch (upd.sessionUpdate) {
    case "current_mode_update": {
      modeId = upd.currentModeId.trim();
      if (modeId) {
        events.push({
          _tag: "ModeChanged",
          modeId,
        });
      }
      break;
    }
    case "plan": {
      const plan = upd.entries.map((entry, index) => ({
        step: entry.content.trim().length > 0 ? entry.content.trim() : `Step ${index + 1}`,
        status: normalizePlanStepStatus(entry.status),
      }));
      if (plan.length > 0) {
        events.push({
          _tag: "PlanUpdated",
          payload: {
            plan,
          },
          rawPayload: params,
        });
      }
      break;
    }
    case "tool_call": {
      const toolCall = parseTypedToolCallState(upd, {
        fallbackStatus: "pending",
      });
      if (toolCall) {
        events.push({
          _tag: "ToolCallUpdated",
          toolCall,
          rawPayload: params,
        });
      }
      break;
    }
    case "tool_call_update": {
      const toolCall = parseTypedToolCallState(upd);
      if (toolCall) {
        events.push({
          _tag: "ToolCallUpdated",
          toolCall,
          rawPayload: params,
        });
      }
      break;
    }
    case "agent_message_chunk": {
      if (upd.content.type === "text" && upd.content.text.length > 0) {
        events.push({
          _tag: "ContentDelta",
          text: upd.content.text,
          rawPayload: params,
        });
      }
      break;
    }
    case "agent_thought_chunk": {
      if (upd.content.type === "text" && upd.content.text.length > 0) {
        events.push({
          _tag: "ThoughtDelta",
          text: upd.content.text,
          rawPayload: params,
        });
      }
      break;
    }
    case "usage_update": {
      if (Number.isSafeInteger(upd.used) && upd.used >= 0) {
        events.push({
          _tag: "UsageUpdated",
          usage: {
            usedTokens: upd.used,
            lastUsedTokens: upd.used,
            ...(Number.isSafeInteger(upd.size) && upd.size > 0 ? { maxTokens: upd.size } : {}),
          },
          rawPayload: params,
        });
      }
      break;
    }
    default:
      break;
  }

  return { ...(modeId !== undefined ? { modeId } : {}), events };
}
