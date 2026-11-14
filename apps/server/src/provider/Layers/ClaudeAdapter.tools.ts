/**
 * Claude tool classification, tool-request summaries and tool-result parsing.
 */
import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type {
  CanonicalItemType,
  CanonicalRequestType,
  RuntimePlanStep,
  VcsStateChangedPayload,
} from "@ryco/contracts";
import { redactToolParameterCredentials } from "@ryco/shared/toolParameterRedaction";
import {
  resolveHtmlRenderToolKind,
  resolveHtmlRenderToolPresentation,
  withoutHtmlRenderMarkup,
} from "@ryco/shared/htmlRenderToolPresentation";
import { CLAUDE_PLAN_TOOL_NAMES, claudePlanToolDetail } from "../claudePlanTasks.ts";
import { type ClaudeToolResultStreamKind, trimmedClaudeString } from "./ClaudeAdapter.types.ts";

export function readClaudeToolUseResult(message: SDKMessage): Record<string, unknown> | undefined {
  if (message.type !== "user") {
    return undefined;
  }
  const result = (message as { readonly tool_use_result?: unknown }).tool_use_result;
  return result !== null && typeof result === "object" && !Array.isArray(result)
    ? (result as Record<string, unknown>)
    : undefined;
}

/**
 * Claude Code's own report that a shell command changed git or forge state; the pinned SDK
 * typings carry neither subtype, so both are matched structurally. `vcs_state_changed` follows a
 * commit, push, merge or rebase the CLI saw in a Bash command's output (scripts and aliases
 * included); `code_change_published` follows a command that opened or touched a pull request.
 * The CLI calls both a cue to re-read the repository: the thread git sync re-reads the checkout
 * and trusts no field. A kind a newer CLI adds is kept; fields that are not strings are dropped.
 * Null for a frame that reports no change: `started` names the pull request the session's branch
 * already had when the session started or resumed. Undefined for any other frame.
 */
export function readClaudeVcsSignal(
  message: SDKMessage,
): VcsStateChangedPayload | null | undefined {
  if (message.type !== "system") return undefined;
  const wire = message as unknown as Record<string, unknown>;
  if (wire.subtype === "code_change_published") {
    const action = trimmedClaudeString(wire.action);
    if (action === "started") return null;
    return { kind: "change-request", ...(action !== undefined ? { action } : {}) };
  }
  if (wire.subtype !== "vcs_state_changed") return undefined;
  const kind = trimmedClaudeString(wire.kind);
  if (kind === undefined) return undefined;
  const cwd = trimmedClaudeString(wire.cwd);
  return { kind, ...(cwd !== undefined ? { cwd } : {}) };
}

export function classifyToolItemType(toolName: string): CanonicalItemType {
  // Planning tools before the substring rules: TaskCreate ("create") and TodoWrite ("write")
  // would otherwise read as file changes and count as edits. Their rows stay in the work log,
  // only relabelled; hiding them would be a client change.
  if (CLAUDE_PLAN_TOOL_NAMES.has(toolName)) {
    return "dynamic_tool_call";
  }
  const normalized = toolName.toLowerCase();
  if (normalized.includes("agent")) {
    return "collab_agent_tool_call";
  }
  if (
    normalized === "task" ||
    normalized === "agent" ||
    normalized.includes("subagent") ||
    normalized.includes("sub-agent")
  ) {
    return "collab_agent_tool_call";
  }
  if (
    normalized.includes("bash") ||
    normalized.includes("command") ||
    normalized.includes("shell") ||
    normalized.includes("terminal")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("file") ||
    normalized.includes("patch") ||
    normalized.includes("replace") ||
    normalized.includes("create") ||
    normalized.includes("delete")
  ) {
    return "file_change";
  }
  if (normalized.includes("mcp")) {
    return "mcp_tool_call";
  }
  if (normalized.includes("websearch") || normalized.includes("web search")) {
    return "web_search";
  }
  if (normalized.includes("image")) {
    return "image_view";
  }
  return "dynamic_tool_call";
}

export function isReadOnlyToolName(toolName: string): boolean {
  const normalized = toolName.toLowerCase();
  return (
    normalized === "read" ||
    normalized.includes("read file") ||
    normalized.includes("view") ||
    normalized.includes("grep") ||
    normalized.includes("glob") ||
    normalized.includes("search")
  );
}

export function classifyRequestType(toolName: string): CanonicalRequestType {
  if (isReadOnlyToolName(toolName)) {
    return "file_read_approval";
  }
  const itemType = classifyToolItemType(toolName);
  return itemType === "command_execution"
    ? "command_execution_approval"
    : itemType === "file_change"
      ? "file_change_approval"
      : "dynamic_tool_call";
}

export function isTodoTool(toolName: string): boolean {
  return toolName.toLowerCase().includes("todowrite");
}

export function extractPlanStepsFromTodoInput(
  input: Record<string, unknown>,
): RuntimePlanStep[] | null {
  // TodoWrite format: { todos: [{ content, status, activeForm? }] }
  const todos = input.todos;
  if (!Array.isArray(todos) || todos.length === 0) {
    return null;
  }
  return todos
    .filter((t): t is Record<string, unknown> => t !== null && typeof t === "object")
    .map((todo) => ({
      step:
        typeof todo.content === "string" && todo.content.trim().length > 0
          ? todo.content.trim()
          : "Task",
      status:
        todo.status === "completed"
          ? "completed"
          : todo.status === "in_progress"
            ? "inProgress"
            : "pending",
    }));
}

export function summarizeToolRequest(toolName: string, input: Record<string, unknown>): string {
  // Ryco's HTML tools carry a whole page; name the page instead of dumping it.
  const htmlRender = resolveHtmlRenderToolPresentation({ toolName, input });
  if (htmlRender) return htmlRender.detail ? `${toolName}: ${htmlRender.detail}` : toolName;

  const planDetail = claudePlanToolDetail(toolName, input);
  if (planDetail) return planDetail;

  const commandValue = input.command ?? input.cmd;
  const command = typeof commandValue === "string" ? commandValue : undefined;
  if (command && command.trim().length > 0) {
    return `${toolName}: ${command.trim().slice(0, 400)}`;
  }

  // For agent/subagent tools, prefer the human-readable description or prompt
  // over raw JSON, but keep the tool identity in front: the summary lands in
  // pendingApproval.detail, where free text alone reads as an unlabeled quote.
  // The structured subagent_type is carried separately on the task.* payloads
  // (role) — the label is display-only.
  const itemType = classifyToolItemType(toolName);
  if (itemType === "collab_agent_tool_call") {
    const description =
      typeof input.description === "string" ? input.description.trim() : undefined;
    const prompt = typeof input.prompt === "string" ? input.prompt.trim() : undefined;
    const label = description || (prompt ? prompt.slice(0, 200) : undefined);
    if (label) {
      return `${toolName}: ${label}`;
    }
  }

  // The summary is persisted with the approval and the tool activity: redact before truncating.
  const serialized = JSON.stringify(redactToolParameterCredentials(input));
  if (serialized.length <= 400) {
    return `${toolName}: ${serialized}`;
  }
  return `${toolName}: ${serialized.slice(0, 397)}...`;
}

/** Work-log detail of a tool item: an HTML tool shows its page title or viewport alone. */
export function toolItemDetail(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  const htmlRender = resolveHtmlRenderToolPresentation({ toolName, input });
  return htmlRender ? htmlRender.detail : summarizeToolRequest(toolName, input);
}

export function toolItemTitle(toolName: string, itemType: CanonicalItemType): string {
  return (
    resolveHtmlRenderToolPresentation({ toolName, input: undefined })?.title ??
    titleForTool(itemType)
  );
}

/** Tool input as carried on runtime events: an HTML tool's page is reduced to its length. */
export function toolEventInput(toolName: string, input: Record<string, unknown>): unknown {
  return resolveHtmlRenderToolKind(toolName) === undefined ? input : withoutHtmlRenderMarkup(input);
}

export function titleForTool(itemType: CanonicalItemType): string {
  switch (itemType) {
    case "command_execution":
      return "Command run";
    case "file_change":
      return "File change";
    case "mcp_tool_call":
      return "MCP tool call";
    case "collab_agent_tool_call":
      return "Subagent task";
    case "web_search":
      return "Web search";
    case "image_view":
      return "Image view";
    case "dynamic_tool_call":
      return "Tool call";
    default:
      return "Item";
  }
}

export function extractContentBlockText(block: unknown): string {
  if (!block || typeof block !== "object") {
    return "";
  }

  const candidate = block as { type?: unknown; text?: unknown };
  return candidate.type === "text" && typeof candidate.text === "string" ? candidate.text : "";
}

export function extractTextContent(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => extractTextContent(entry)).join("");
  }

  if (!value || typeof value !== "object") {
    return "";
  }

  const record = value as {
    text?: unknown;
    content?: unknown;
  };

  if (typeof record.text === "string") {
    return record.text;
  }

  return extractTextContent(record.content);
}

export function extractExitPlanModePlan(value: unknown): string | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as {
    plan?: unknown;
  };
  return typeof record.plan === "string" && record.plan.trim().length > 0
    ? record.plan.trim()
    : undefined;
}

export function exitPlanCaptureKey(input: {
  readonly toolUseId?: string | undefined;
  readonly planMarkdown: string;
}): string {
  return input.toolUseId && input.toolUseId.length > 0
    ? `tool:${input.toolUseId}`
    : `plan:${input.planMarkdown}`;
}

/**
 * How far a streamed tool input's JSON has got, advanced one delta at a time.
 * The accumulated text can only parse once its top-level value closes, so it
 * is parsed then rather than after every delta: re-parsing the whole prefix
 * each time is quadratic, and an HTML tool call streams a page of up to 512k
 * characters.
 */
export interface StreamedJsonScan {
  /** Open objects and arrays; negative once the text can no longer be JSON. */
  readonly depth: number;
  readonly inString: boolean;
  readonly escaped: boolean;
  readonly opened: boolean;
}

export const EMPTY_STREAMED_JSON_SCAN: StreamedJsonScan = {
  depth: 0,
  inString: false,
  escaped: false,
  opened: false,
};

export function scanStreamedJson(scan: StreamedJsonScan, chunk: string): StreamedJsonScan {
  let { depth, inString, escaped, opened } = scan;
  for (let index = 0; index < chunk.length; index += 1) {
    const code = chunk.charCodeAt(index);
    if (inString) {
      if (escaped) escaped = false;
      else if (code === 0x5c) escaped = true; // backslash
      else if (code === 0x22) inString = false; // quote
    } else if (code === 0x22) {
      inString = true;
    } else if (code === 0x7b || code === 0x5b) {
      depth += 1;
      opened = true;
    } else if (code === 0x7d || code === 0x5d) {
      depth -= 1;
    }
  }
  return { depth, inString, escaped, opened };
}

/** Every complete JSON object passes this, so skipping the parse otherwise changes nothing. */
export const mayBeCompleteJson = (scan: StreamedJsonScan): boolean =>
  scan.opened && scan.depth === 0 && !scan.inString;

export function tryParseJsonRecord(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

export function toolInputFingerprint(input: Record<string, unknown>): string | undefined {
  try {
    return JSON.stringify(input);
  } catch {
    return undefined;
  }
}

export function toolResultStreamKind(
  itemType: CanonicalItemType,
): ClaudeToolResultStreamKind | undefined {
  switch (itemType) {
    case "command_execution":
      return "command_output";
    case "file_change":
      return "file_change_output";
    default:
      return undefined;
  }
}

export function toolResultBlocksFromUserMessage(message: SDKMessage): Array<{
  readonly toolUseId: string;
  readonly block: Record<string, unknown>;
  readonly text: string;
  readonly isError: boolean;
}> {
  if (message.type !== "user") {
    return [];
  }

  const content = (message.message as { content?: unknown } | undefined)?.content;
  if (!Array.isArray(content)) {
    return [];
  }

  const blocks: Array<{
    readonly toolUseId: string;
    readonly block: Record<string, unknown>;
    readonly text: string;
    readonly isError: boolean;
  }> = [];

  for (const entry of content) {
    if (!entry || typeof entry !== "object") {
      continue;
    }

    const block = entry as Record<string, unknown>;
    if (block.type !== "tool_result") {
      continue;
    }

    const toolUseId = typeof block.tool_use_id === "string" ? block.tool_use_id : undefined;
    if (!toolUseId) {
      continue;
    }

    blocks.push({
      toolUseId,
      block,
      text: extractTextContent(block.content),
      isError: block.is_error === true,
    });
  }

  return blocks;
}
