import {
  resolveHtmlRenderToolKind,
  withoutHtmlRenderMarkup,
} from "@ryco/shared/htmlRenderToolPresentation";
import { extractToolContentText, extractToolResultText } from "@ryco/shared/toolOutput";
import type { OrchestrationThreadActivity } from "@ryco/contracts";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asTrimmedString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function summarizeToolTextOutput(value: string): string | null {
  const lines: string[] = [];
  for (const rawLine of value.split(/\r?\n/u)) {
    const line = rawLine.replace(/\s+/g, " ").trim();
    if (line.length > 0) {
      lines.push(line);
    }
  }

  const firstLine = lines.find((line) => line !== "```");
  if (firstLine) {
    return firstLine.length <= 84 ? firstLine : `${firstLine.slice(0, 83).trimEnd()}…`;
  }
  if (lines.length > 1) {
    return `${lines.length.toLocaleString()} lines`;
  }
  return null;
}

function pushChangedFile(target: string[], seen: Set<string>, value: unknown): void {
  const normalized = asTrimmedString(value);
  if (!normalized || seen.has(normalized)) {
    return;
  }
  seen.add(normalized);
  target.push(normalized);
}

function collectChangedFiles(
  value: unknown,
  target: string[],
  seen: Set<string>,
  depth: number,
): void {
  if (depth > 4 || target.length >= 12) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      collectChangedFiles(entry, target, seen, depth + 1);
      if (target.length >= 12) {
        return;
      }
    }
    return;
  }

  const record = asRecord(value);
  if (!record) {
    return;
  }

  pushChangedFile(target, seen, record.path);
  pushChangedFile(target, seen, record.filePath);
  pushChangedFile(target, seen, record.relativePath);
  pushChangedFile(target, seen, record.filename);
  pushChangedFile(target, seen, record.newPath);
  pushChangedFile(target, seen, record.oldPath);

  for (const nestedKey of [
    "item",
    "result",
    "input",
    "data",
    "changes",
    "files",
    "edits",
    "patch",
    "patches",
    "operations",
  ]) {
    if (!(nestedKey in record)) {
      continue;
    }
    collectChangedFiles(record[nestedKey], target, seen, depth + 1);
    if (target.length >= 12) {
      return;
    }
  }
}

function projectCommandData(data: Record<string, unknown>): Record<string, unknown> | undefined {
  const item = asRecord(data.item);
  if (!item) {
    return undefined;
  }

  const projectedItem: Record<string, unknown> = {};
  if ("command" in item) {
    projectedItem.command = item.command;
  }

  const aggregatedOutput = asTrimmedString(item.aggregatedOutput);
  if (aggregatedOutput) {
    const summary = summarizeToolTextOutput(aggregatedOutput);
    if (summary) {
      projectedItem.aggregatedOutput = summary;
    }
  }

  const input = asRecord(item.input);
  if (input && "command" in input) {
    projectedItem.input = { command: input.command };
  }

  const result = asRecord(item.result);
  if (result) {
    const projectedResult: Record<string, unknown> = {};
    if ("command" in result) {
      projectedResult.command = result.command;
    }
    const content = asTrimmedString(result.content);
    if (content) {
      const summary = summarizeToolTextOutput(content);
      if (summary) {
        projectedResult.content = summary;
      }
    }
    if (Object.keys(projectedResult).length > 0) {
      projectedItem.result = projectedResult;
    }
  }

  return Object.keys(projectedItem).length > 0 ? projectedItem : undefined;
}

function projectCommandValue(data: Record<string, unknown>): unknown {
  if (data.command !== undefined) {
    return data.command;
  }

  const input = asRecord(data.input);
  if (input?.command !== undefined) {
    return input.command;
  }

  const stateInput = asRecord(asRecord(data.state)?.input);
  if (stateInput?.command !== undefined) {
    return stateInput.command;
  }

  return undefined;
}

const MCP_ITEM_KEPT_FIELDS = [
  "type",
  "id",
  "tool",
  "server",
  "status",
  "arguments",
  "appContext",
  "error",
  "durationMs",
] as const;

function summarizeMcpResult(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined || result === null) {
    return undefined;
  }
  const text = extractToolResultText(result);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

// Ryco's HTML tools carry a whole page in their input; activities keep only its length.
function isHtmlRenderToolCall(
  data: Record<string, unknown>,
  item: Record<string, unknown> | null,
): boolean {
  const server = asTrimmedString(item?.server);
  return (
    resolveHtmlRenderToolKind(asTrimmedString(item?.tool), server) !== undefined ||
    resolveHtmlRenderToolKind(asTrimmedString(data.toolName)) !== undefined
  );
}

// Pages are whole documents; smaller html arguments are left to their tools.
const UNNAMED_HTML_TOOL_MIN_CHARS = 1024;
const RENDER_ARGUMENT_KEYS = new Set(["html", "title", "height"]);
const PREVIEW_ARGUMENT_KEYS = new Set(["html", "width", "appearance"]);

/**
 * Whether tool arguments are exactly those of `ryco_html_render` or
 * `ryco_html_preview` carrying a page: a call that arrives already completed
 * with no tool name (as an ACP update can) is recognized by them alone.
 */
function isUnnamedHtmlRenderToolInput(value: unknown): boolean {
  const args = asRecord(value);
  if (
    !args ||
    typeof args.html !== "string" ||
    args.html.length < UNNAMED_HTML_TOOL_MIN_CHARS ||
    !/<[a-z!]/i.test(args.html)
  ) {
    return false;
  }
  const keys = Object.keys(args);
  const render =
    keys.every((key) => RENDER_ARGUMENT_KEYS.has(key)) &&
    typeof args.title === "string" &&
    typeof args.height === "number";
  const preview =
    keys.every((key) => PREVIEW_ARGUMENT_KEYS.has(key)) &&
    (args.width === undefined || typeof args.width === "number") &&
    (args.appearance === undefined || args.appearance === "dark" || args.appearance === "light");
  return render || preview;
}

/** Whether tool data names its tool, so its arguments are judged by that name alone. */
const namesTool = (data: Record<string, unknown>, item: Record<string, unknown> | null) =>
  asTrimmedString(data.toolName) !== null || asTrimmedString(item?.tool) !== null;

/**
 * Tool data with the page of a Ryco HTML tool call replaced by its length.
 * Ingestion applies it to every lifecycle event, so a started or completed
 * activity can never store the markup even if an adapter forwarded it.
 */
export function withoutHtmlRenderToolMarkup(data: unknown): unknown {
  const record = asRecord(data);
  if (!record) return data;
  const item = asRecord(record.item);
  if (isHtmlRenderToolCall(record, item)) {
    return {
      ...record,
      ...("input" in record ? { input: withoutHtmlRenderMarkup(record.input) } : {}),
      ...("rawInput" in record ? { rawInput: withoutHtmlRenderMarkup(record.rawInput) } : {}),
      ...(item && "arguments" in item
        ? { item: { ...item, arguments: withoutHtmlRenderMarkup(item.arguments) } }
        : {}),
    };
  }
  if (namesTool(record, item)) return data;
  const input = isUnnamedHtmlRenderToolInput(record.input);
  const rawInput = isUnnamedHtmlRenderToolInput(record.rawInput);
  if (!input && !rawInput) return data;
  return {
    ...record,
    ...(input ? { input: withoutHtmlRenderMarkup(record.input) } : {}),
    ...(rawInput ? { rawInput: withoutHtmlRenderMarkup(record.rawInput) } : {}),
  };
}

function projectMcpToolCallData(data: Record<string, unknown>): Record<string, unknown> {
  const projectedData: Record<string, unknown> = {};

  const item = asRecord(data.item);
  const htmlRenderTool = isHtmlRenderToolCall(data, item);
  if (item) {
    const projectedItem: Record<string, unknown> = {};
    for (const key of MCP_ITEM_KEPT_FIELDS) {
      if (key in item) {
        projectedItem[key] =
          key === "arguments" && htmlRenderTool ? withoutHtmlRenderMarkup(item[key]) : item[key];
      }
    }
    const result = summarizeMcpResult(item.result);
    if (result) {
      projectedItem.result = result;
    }
    projectedData.item = projectedItem;
  }

  if ("toolName" in data) {
    projectedData.toolName = data.toolName;
  }
  if ("input" in data) {
    projectedData.input = htmlRenderTool ? withoutHtmlRenderMarkup(data.input) : data.input;
  }
  if (!item) {
    const result = summarizeMcpResult(data.result);
    if (result) {
      projectedData.result = result;
    }
  }
  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  return projectedData;
}

function projectRawOutput(value: unknown): Record<string, unknown> | undefined {
  const rawOutput = asRecord(value);
  if (typeof rawOutput?.totalFiles === "number" && Number.isFinite(rawOutput.totalFiles)) {
    return {
      totalFiles: rawOutput.totalFiles,
      ...(rawOutput.truncated === true ? { truncated: true } : {}),
    };
  }
  const text = extractToolResultText(value);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

function projectAcpContent(value: unknown): Record<string, unknown> | undefined {
  const text = extractToolContentText(value);
  const summary = text ? summarizeToolTextOutput(text) : null;
  return summary ? { content: summary } : undefined;
}

/**
 * Projects provider-specific tool data to the fields shared clients consume.
 * The result is safe to persist for cumulative streaming updates: unbounded
 * tool output is reduced to a one-line summary while identity, command, and
 * changed-file metadata remain available to every client.
 */
export function projectActivityPayload(
  activity: OrchestrationThreadActivity,
): OrchestrationThreadActivity {
  const payload = asRecord(activity.payload);
  const data = asRecord(payload?.data);
  if (!payload || !data) {
    return activity;
  }

  const itemStatus = asRecord(data.item)?.status;
  const projectedPayload =
    payload.status === "completed" && (itemStatus === "failed" || itemStatus === "declined")
      ? { ...payload, status: itemStatus }
      : payload;

  if (payload.itemType === "mcp_tool_call") {
    return {
      ...activity,
      payload: {
        ...projectedPayload,
        data: projectMcpToolCallData(data),
      },
    };
  }

  const projectedData: Record<string, unknown> = {};
  const item = projectCommandData(data);
  if (item) {
    projectedData.item = item;
  }
  const command = projectCommandValue(data);
  if (command !== undefined) {
    projectedData.command = command;
  }

  const changedFiles: string[] = [];
  collectChangedFiles(data, changedFiles, new Set<string>(), 0);
  if (changedFiles.length > 0) {
    projectedData.files = changedFiles.map((path) => ({ path }));
  }

  if ("toolCallId" in data) {
    projectedData.toolCallId = data.toolCallId;
  }
  if ("kind" in data) {
    projectedData.kind = data.kind;
  }

  const rawOutput =
    projectRawOutput(data.rawOutput) ??
    projectRawOutput(data.result) ??
    projectRawOutput(asRecord(data.state)?.output) ??
    projectRawOutput(asRecord(data.state)?.error) ??
    projectRawOutput(asRecord(data.error)?.message) ??
    projectAcpContent(data.content);
  if (rawOutput) {
    projectedData.rawOutput = rawOutput;
  }

  return {
    ...activity,
    payload: {
      ...projectedPayload,
      data: projectedData,
    },
  };
}
