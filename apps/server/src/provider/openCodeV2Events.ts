/**
 * OpenCode 2.x messages and live events as the 1.x events and message snapshots `OpenCodeAdapter`
 * consumes (`message.updated`, `message.part.updated|delta`, `session.status|error`, permission and
 * question requests). Pure; adapted from Synara (`openCodeV2Messages.ts`).
 *
 * Part IDs are derived, so a part streamed live and the same part read back with `message.list`
 * (after a reconnect, on resume) share one ID: `${messageID}:text:${n}` and
 * `${messageID}:reasoning:${n}` (2.x numbers text and reasoning blocks separately, while stored
 * content interleaves them with tools) and `${messageID}:tool:${callID}`.
 *
 * Text streams as deltas (`message.part.delta`); a block's full text arrives once, when it ends,
 * which the adapter reconciles with what it streamed. 2.x subagent results are rewritten into the
 * 1.x Task envelopes `OpenCodeTaskLifecycle` reads (`<task_result>`, `<task id state>`), and a
 * background subagent's report into the synthetic 1.x notification part, live and stored alike.
 */
import type {
  OpenCodeEvent,
  SessionInboxEnqueued,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageInfo,
  SessionMessageUser,
  SessionStructuredError,
  ToolContent,
  ToolContent1,
  TokenUsageInfo,
} from "@opencode/client";
import type {
  AssistantMessage,
  Event,
  FilePart,
  Message,
  Part,
  TextPart,
  ToolPart,
} from "@opencode-ai/sdk/v2";

import {
  openCodeV1Name,
  openCodeV2CreatedSession,
  openCodeV2FormAnswers,
  openCodeV2Permission,
  openCodeV2Question,
  type OpenCodeV2Form,
} from "./openCodeV2Mapping.ts";

/** A 1.x event, as the 1.x SDK's `event.subscribe` stream yields it. */
export type OpenCodeV1Event = Event;

/** A 1.x `session.messages` entry. */
export interface OpenCodeV1Message {
  readonly info: Message;
  readonly parts: Array<Part>;
}

export const openCodeV2BlockPartId = (
  messageID: string,
  type: "text" | "reasoning",
  ordinal: number,
) => `${messageID}:${type}:${ordinal}`;

export const openCodeV2ToolPartId = (messageID: string, callID: string) =>
  `${messageID}:tool:${callID}`;

const emptyTokens = (): TokenUsageInfo => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
});

const v1Error = (error: SessionStructuredError): NonNullable<AssistantMessage["error"]> =>
  error.type === "aborted"
    ? { name: "MessageAbortedError", data: { message: error.message } }
    : { name: "UnknownError", data: { message: error.message } };

type AssistantHeader = Omit<SessionMessageAssistant, "content">;

function assistantInfo(
  sessionID: string,
  message: AssistantHeader,
  directory: string,
): AssistantMessage {
  return {
    id: message.id,
    sessionID,
    role: "assistant",
    parentID: "",
    time: {
      created: message.time.created,
      ...(message.time.completed !== undefined ? { completed: message.time.completed } : {}),
    },
    modelID: message.model.id,
    providerID: message.model.providerID,
    ...(message.model.variant !== undefined ? { variant: message.model.variant } : {}),
    agent: message.agent,
    mode: message.agent,
    path: { cwd: directory, root: directory },
    cost: message.cost ?? 0,
    tokens: message.tokens ?? emptyTokens(),
    ...(message.finish !== undefined ? { finish: message.finish } : {}),
    ...(message.error !== undefined ? { error: v1Error(message.error) } : {}),
  };
}

const SUBAGENT_ENVELOPE =
  /^\s*<subagent\s+sessionID="([^"]+)"\s+state="([^"]+)"[^>]*>\n?([\s\S]*?)\n?<\/subagent>\s*$/;

/** 2.x's `<subagent sessionID state>body</subagent>` result envelope, parsed. */
function subagentEnvelope(
  text: string,
): { readonly sessionID: string; readonly state: string; readonly body: string } | undefined {
  const match = SUBAGENT_ENVELOPE.exec(text);
  return match ? { sessionID: match[1]!, state: match[2]!, body: match[3]! } : undefined;
}

/** States `OpenCodeTaskLifecycle` reads from a 1.x `<task id state>` notification. */
const TASK_NOTIFICATION_STATES = new Set(["completed", "error", "interrupted", "cancelled"]);

/** The 1.x background-Task notification for a finished 2.x subagent. */
function taskNotification(sessionID: string, state: string, body: string): string {
  const content =
    state === "completed"
      ? `<task_result>\n${body}\n</task_result>`
      : state === "error"
        ? `<task_error>\n${body}\n</task_error>`
        : body;
  return `<task id="${sessionID}" state="${state}">\n${content}\n</task>`;
}

/**
 * A finished background subagent's report as the synthetic 1.x text part `OpenCodeTaskLifecycle`
 * completes the Task from. 2.x delivers the report as a synthetic inbox item and stores it as a
 * synthetic message with the same ID; both are read here, so the part is identical live and from
 * `message.list`. Any other synthetic note has no 1.x counterpart.
 */
function subagentReportPart(
  sessionID: string,
  messageID: string,
  note: {
    readonly text: string;
    readonly metadata?: Readonly<Record<string, unknown>> | undefined;
  },
): TextPart | undefined {
  const metadata = note.metadata;
  const childID = metadata?.childID;
  const state = metadata?.state;
  if (
    metadata?.source !== "subagent" ||
    typeof childID !== "string" ||
    typeof state !== "string" ||
    !TASK_NOTIFICATION_STATES.has(state)
  ) {
    return undefined;
  }
  return {
    id: openCodeV2BlockPartId(messageID, "text", 0),
    sessionID,
    messageID,
    type: "text",
    synthetic: true,
    text: taskNotification(childID, state, subagentEnvelope(note.text)?.body ?? note.text),
  };
}

const textOf = (content: ReadonlyArray<ToolContent>) =>
  content.flatMap((item) => (item.type === "text" ? [item.text] : [])).join("\n");

/**
 * A 2.x tool call as the 1.x tool part: `shell` is `bash`, `subagent` is the Task tool (its
 * `agent` input is the Task's `subagent_type`), and text content is joined into `output`.
 */
export function openCodeV2ToolPart(
  sessionID: string,
  messageID: string,
  tool: SessionMessageAssistantTool,
): ToolPart {
  const id = openCodeV2ToolPartId(messageID, tool.id);
  const common = {
    id,
    sessionID,
    messageID,
    type: "tool" as const,
    callID: tool.id,
    tool: openCodeV1Name(tool.name),
  };
  const state = tool.state;
  if (state.status === "streaming") {
    return { ...common, state: { status: "pending", input: {}, raw: state.input } };
  }
  const subagent = tool.name === "subagent";
  const input: Record<string, unknown> = { ...state.input };
  if (subagent && typeof input.agent === "string") input.subagent_type = input.agent;
  const title = typeof input.description === "string" ? input.description : undefined;
  const start = tool.time.ran ?? tool.time.created;
  const end = tool.time.completed ?? start;
  if (state.status === "running") {
    return {
      ...common,
      state: {
        status: "running",
        input,
        ...(title !== undefined ? { title } : {}),
        metadata: { ...state.metadata },
        time: { start },
      },
    };
  }
  const metadata: Record<string, unknown> = { ...state.metadata };
  if (state.status === "error") {
    return {
      ...common,
      state: { status: "error", input, error: state.error.message, metadata, time: { start, end } },
    };
  }
  let output = textOf(state.content);
  if (subagent) {
    // A background subagent returns at once, still running; its result arrives later as a
    // notification (`session.inbox.enqueued`).
    if (metadata.status === "running") metadata.background = true;
    const envelope = subagentEnvelope(output);
    if (envelope?.state === "error") {
      return {
        ...common,
        state: { status: "error", input, error: envelope.body, metadata, time: { start, end } },
      };
    }
    if (envelope?.state === "completed") output = `<task_result>\n${envelope.body}\n</task_result>`;
    else if (envelope) output = taskNotification(envelope.sessionID, envelope.state, envelope.body);
  }
  const attachments = state.content.flatMap((item, index) =>
    item.type === "file"
      ? [
          {
            id: `${id}:file:${index}`,
            sessionID,
            messageID,
            type: "file" as const,
            mime: item.mime,
            url: item.uri,
            ...(item.name ? { filename: item.name } : {}),
          },
        ]
      : [],
  );
  return {
    ...common,
    state: {
      status: "completed",
      input,
      output,
      title: title ?? common.tool,
      metadata,
      time: { start, end },
      ...(attachments.length > 0 ? { attachments } : {}),
    },
  };
}

/** 1.x user-message info; 2.x keeps the agent and model on their own switch messages instead. */
const userInfo = (
  sessionID: string,
  message: { readonly id: string; readonly time: { readonly created: number } },
): Message => ({
  id: message.id,
  sessionID,
  role: "user",
  time: { created: message.time.created },
  agent: "",
  model: { providerID: "", modelID: "" },
});

function userMessage(sessionID: string, message: SessionMessageUser): OpenCodeV1Message {
  return {
    info: userInfo(sessionID, message),
    parts: [
      {
        id: openCodeV2BlockPartId(message.id, "text", 0),
        sessionID,
        messageID: message.id,
        type: "text",
        text: message.text,
      },
      ...(message.files ?? []).map((file, index) => {
        const part: FilePart = {
          id: `${message.id}:file:${index}`,
          sessionID,
          messageID: message.id,
          type: "file",
          mime: file.mime,
          url:
            file.source.type === "uri" ? file.source.uri : `data:${file.mime};base64,${file.data}`,
        };
        if (file.name !== undefined) part.filename = file.name;
        return part;
      }),
    ],
  };
}

/**
 * A 2.x message as a 1.x `session.messages` entry. Prompts, assistant replies and a finished
 * background subagent's report have a 1.x shape; agent and model switches, other synthetic notes,
 * shell runs, compactions and the like do not. The report is a user message of one synthetic text
 * part, as 1.x stores it, which the adapter's rewind does not count as a turn.
 */
export function openCodeV2Message(
  sessionID: string,
  message: SessionMessageInfo,
  directory: string,
): OpenCodeV1Message | undefined {
  switch (message.type) {
    case "user":
      return userMessage(sessionID, message);
    case "assistant":
      return openCodeV2AssistantMessage(sessionID, message, directory);
    case "synthetic": {
      const report = subagentReportPart(sessionID, message.id, message);
      return report ? { info: userInfo(sessionID, message), parts: [report] } : undefined;
    }
    default:
      return undefined;
  }
}

/** A 2.x assistant reply as a 1.x `session.messages` entry. */
export function openCodeV2AssistantMessage(
  sessionID: string,
  message: SessionMessageAssistant,
  directory: string,
): { readonly info: AssistantMessage; readonly parts: Array<Part> } {
  const ordinals = { text: 0, reasoning: 0 };
  return {
    info: assistantInfo(sessionID, message, directory),
    parts: message.content.map((block): Part => {
      if (block.type === "tool") return openCodeV2ToolPart(sessionID, message.id, block);
      const ordinal = ordinals[block.type]++;
      return {
        id: openCodeV2BlockPartId(message.id, block.type, ordinal),
        sessionID,
        messageID: message.id,
        type: block.type,
        text: block.text,
        time: {
          start: message.time.created,
          ...(message.time.completed !== undefined ? { end: message.time.completed } : {}),
        },
      };
    }),
  };
}

/** What the mapper keeps of an assistant message while it streams. */
interface LiveMessage {
  readonly sessionID: string;
  header: AssistantHeader;
  /** Start time of each text or reasoning part announced and not yet ended, by part ID. */
  readonly blocks: Map<string, number>;
  /** Tool calls not yet settled, by call ID. */
  readonly tools: Map<string, SessionMessageAssistantTool>;
}

/** Messages streaming at once across every session on the server; the oldest goes first. */
const MAX_LIVE_MESSAGES = 256;

const FAILED_EXECUTION_MESSAGE = "OpenCode session failed.";

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null;

/**
 * A permission request or form carrying the fields the adapter reads without checking. One that
 * does not (a frame that did not decode) is skipped rather than half mapped.
 */
const isPermissionRequest = (data: unknown) =>
  isRecord(data) &&
  typeof data.id === "string" &&
  typeof data.sessionID === "string" &&
  typeof data.action === "string" &&
  Array.isArray(data.resources);

const isForm = (form: unknown) =>
  isRecord(form) &&
  typeof form.id === "string" &&
  typeof form.sessionID === "string" &&
  Array.isArray(form.fields);

/**
 * The end of a session's execution, read defensively: it ends the turn even when the frame does
 * not decode as its documented shape, as long as it names the session. Success and interruption
 * both leave the session idle (an interrupt's turn was already ended by the adapter).
 */
function executionEnded(event: {
  readonly id?: unknown;
  readonly type: string;
  readonly data?: unknown;
}): Array<OpenCodeV1Event> {
  const data = isRecord(event.data) ? event.data : {};
  if (typeof data.sessionID !== "string") return [];
  const id = typeof event.id === "string" ? event.id : "";
  if (event.type !== "session.execution.failed") {
    return [
      {
        id,
        type: "session.status",
        properties: { sessionID: data.sessionID, status: { type: "idle" } },
      },
    ];
  }
  const message = isRecord(data.error) ? data.error.message : undefined;
  return [
    {
      id,
      type: "session.error",
      properties: {
        sessionID: data.sessionID,
        error: {
          name: "UnknownError",
          data: {
            message:
              typeof message === "string" && message.length > 0
                ? message
                : FAILED_EXECUTION_MESSAGE,
          },
        },
      },
    },
  ];
}

export type OpenCodeV2EventMapper = (event: OpenCodeEvent) => Array<OpenCodeV1Event>;

/**
 * Creates the translator for one event subscription. Its state is the assistant messages still
 * streaming (capped at {@link MAX_LIVE_MESSAGES}; a message is dropped once its step ends), so it
 * stays bounded however many sessions share the server; the adapter picks out its own sessions.
 * Events with no 1.x counterpart (compaction, inbox, shells, usage, unknown types) map to nothing,
 * and so does a frame that does not decode, except the end of an execution
 * ({@link executionEnded}).
 *
 * `resolveForm` returns the form a `form.replied` settles (remembered by the facade from
 * `form.list` and `form.created`), so its answer can be shown with option labels.
 */
export function createOpenCodeV2EventMapper(
  directory: string,
  resolveForm: (formID: string) => OpenCodeV2Form | undefined = () => undefined,
): OpenCodeV2EventMapper {
  const messages = new Map<string, LiveMessage>();

  const messageUpdated = (id: string, message: LiveMessage): OpenCodeV1Event => ({
    id,
    type: "message.updated",
    properties: {
      sessionID: message.sessionID,
      info: assistantInfo(message.sessionID, message.header, directory),
    },
  });

  const partUpdated = (id: string, time: number, part: Part): OpenCodeV1Event => ({
    id,
    type: "message.part.updated",
    properties: { sessionID: part.sessionID, part, time },
  });

  function remember(message: LiveMessage) {
    messages.delete(message.header.id);
    messages.set(message.header.id, message);
    if (messages.size > MAX_LIVE_MESSAGES) messages.delete(messages.keys().next().value!);
  }

  /** A message whose step start this mapper did not see; its agent and model are unknown. */
  const unknownMessage = (sessionID: string, messageID: string, created: number): LiveMessage => ({
    sessionID,
    header: {
      id: messageID,
      type: "assistant",
      agent: "",
      model: { id: "", providerID: "" },
      time: { created },
    },
    blocks: new Map(),
    tools: new Map(),
  });

  /**
   * The streaming message an event belongs to. A mapper created mid-message (the stream
   * reattached) has not seen its step start: it announces a placeholder first, so the adapter
   * knows the parts that follow belong to an assistant reply.
   */
  function liveMessage(
    event: { readonly id: string; readonly created: number },
    sessionID: string,
    messageID: string,
    out: Array<OpenCodeV1Event>,
  ): LiveMessage {
    const known = messages.get(messageID);
    if (known) return known;
    const message = unknownMessage(sessionID, messageID, event.created);
    remember(message);
    out.push(messageUpdated(event.id, message));
    return message;
  }

  function blockPart(
    message: LiveMessage,
    type: "text" | "reasoning",
    partID: string,
    text: string,
    time: { readonly start: number; readonly end?: number },
  ): Part {
    return {
      id: partID,
      sessionID: message.sessionID,
      messageID: message.header.id,
      type,
      text,
      time,
    };
  }

  function toolUpdated(
    event: { readonly id: string; readonly created: number },
    message: LiveMessage,
    tool: SessionMessageAssistantTool,
  ): OpenCodeV1Event {
    return partUpdated(
      event.id,
      event.created,
      openCodeV2ToolPart(message.sessionID, message.header.id, tool),
    );
  }

  function inboxNotification(event: SessionInboxEnqueued): Array<OpenCodeV1Event> {
    const item = event.data.item;
    if (item.type !== "synthetic") return [];
    const report = subagentReportPart(event.data.sessionID, event.data.inboxID, item.payload);
    return report ? [partUpdated(event.id, event.created, report)] : [];
  }

  function map(event: OpenCodeEvent): Array<OpenCodeV1Event> {
    switch (event.type) {
      case "server.connected":
        return [{ id: event.id, type: "server.connected", properties: {} }];
      case "session.created":
        return [
          {
            id: event.id,
            type: "session.created",
            properties: { sessionID: event.data.sessionID, info: openCodeV2CreatedSession(event) },
          },
        ];
      case "session.execution.started":
        return [
          {
            id: event.id,
            type: "session.status",
            properties: { sessionID: event.data.sessionID, status: { type: "busy" } },
          },
        ];
      case "session.execution.succeeded":
      case "session.execution.failed":
      case "session.execution.interrupted":
        return executionEnded(event);
      case "session.retry.scheduled":
        return [
          {
            id: event.id,
            type: "session.status",
            properties: {
              sessionID: event.data.sessionID,
              status: {
                type: "retry",
                attempt: event.data.attempt,
                message: event.data.error.message,
                next: event.data.at,
              },
            },
          },
        ];
      case "session.step.started": {
        const message: LiveMessage = {
          sessionID: event.data.sessionID,
          header: {
            id: event.data.assistantMessageID,
            type: "assistant",
            agent: event.data.agent,
            model: event.data.model,
            time: { created: event.data.started },
          },
          blocks: new Map(),
          tools: new Map(),
        };
        remember(message);
        return [messageUpdated(event.id, message)];
      }
      case "session.step.ended":
      case "session.step.failed": {
        // Its text and tool calls have all ended: nothing streams into the message again.
        const messageID = event.data.assistantMessageID;
        const message =
          messages.get(messageID) ?? unknownMessage(event.data.sessionID, messageID, event.created);
        messages.delete(messageID);
        message.header = {
          ...message.header,
          time: { ...message.header.time, completed: event.created },
          tokens: event.data.tokens ?? emptyTokens(),
          cost: event.data.cost ?? 0,
          finish: event.data.finish ?? "error",
          ...(event.type === "session.step.failed" ? { error: event.data.error } : {}),
        };
        return [messageUpdated(event.id, message)];
      }
      case "session.text.started":
      case "session.reasoning.started":
      case "session.text.delta":
      case "session.reasoning.delta":
      case "session.text.ended":
      case "session.reasoning.ended": {
        const out: Array<OpenCodeV1Event> = [];
        const { sessionID, assistantMessageID, ordinal } = event.data;
        const message = liveMessage(event, sessionID, assistantMessageID, out);
        const type = event.type.startsWith("session.reasoning.") ? "reasoning" : "text";
        const partID = openCodeV2BlockPartId(assistantMessageID, type, ordinal);
        let start = message.blocks.get(partID);
        if (start === undefined) {
          start = event.created;
          if (!event.type.endsWith(".ended")) {
            message.blocks.set(partID, start);
            out.push(
              partUpdated(event.id, event.created, blockPart(message, type, partID, "", { start })),
            );
          }
        }
        if ("delta" in event.data) {
          if (event.data.delta.length === 0) return out;
          out.push({
            id: event.id,
            type: "message.part.delta",
            properties: {
              sessionID,
              messageID: assistantMessageID,
              partID,
              field: "text",
              delta: event.data.delta,
            },
          });
        } else if ("text" in event.data) {
          message.blocks.delete(partID);
          out.push(
            partUpdated(
              event.id,
              event.created,
              blockPart(message, type, partID, event.data.text, { start, end: event.created }),
            ),
          );
        }
        return out;
      }
      case "session.tool.input.started": {
        const out: Array<OpenCodeV1Event> = [];
        const message = liveMessage(
          event,
          event.data.sessionID,
          event.data.assistantMessageID,
          out,
        );
        const tool: SessionMessageAssistantTool = {
          type: "tool",
          id: event.data.id,
          name: event.data.name,
          state: { status: "streaming", input: "" },
          time: { created: event.created },
        };
        message.tools.set(tool.id, tool);
        out.push(toolUpdated(event, message, tool));
        return out;
      }
      case "session.tool.called":
      case "session.tool.progress":
      case "session.tool.success":
      case "session.tool.failed": {
        // Without the call's start (a mapper created mid-call) the tool's name is unknown.
        const message = messages.get(event.data.assistantMessageID);
        const tool = message?.tools.get(event.data.id);
        if (!message || !tool) return [];
        const input = tool.state.status === "streaming" ? {} : tool.state.input;
        switch (event.type) {
          case "session.tool.called":
            tool.time.ran = event.created;
            tool.state = { status: "running", input: event.data.input, metadata: {} };
            break;
          case "session.tool.progress":
            tool.state = { status: "running", input, metadata: event.data.metadata };
            break;
          case "session.tool.success":
            tool.time.completed = event.created;
            tool.state = {
              status: "completed",
              input,
              content: toolContent(event.data.content),
              metadata: event.data.metadata ?? {},
            };
            message.tools.delete(tool.id);
            break;
          case "session.tool.failed":
            tool.time.completed = event.created;
            tool.state = {
              status: "error",
              input,
              error: event.data.error,
              metadata: event.data.metadata ?? {},
            };
            message.tools.delete(tool.id);
            break;
        }
        return [toolUpdated(event, message, tool)];
      }
      case "permission.asked":
        if (!isPermissionRequest(event.data)) return [];
        return [
          { id: event.id, type: "permission.asked", properties: openCodeV2Permission(event.data) },
        ];
      case "permission.replied":
        return [
          {
            id: event.id,
            type: "permission.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.requestID,
              reply: event.data.reply,
            },
          },
        ];
      case "form.created":
        if (!isForm(event.data.form)) return [];
        return [
          { id: event.id, type: "question.asked", properties: openCodeV2Question(event.data.form) },
        ];
      case "form.replied": {
        const form = resolveForm(event.data.id);
        return [
          {
            id: event.id,
            type: "question.replied",
            properties: {
              sessionID: event.data.sessionID,
              requestID: event.data.id,
              answers: form ? openCodeV2FormAnswers(form, event.data.answer) : [],
            },
          },
        ];
      }
      case "form.cancelled":
        return [
          {
            id: event.id,
            type: "question.rejected",
            properties: { sessionID: event.data.sessionID, requestID: event.data.id },
          },
        ];
      case "session.inbox.enqueued":
        return inboxNotification(event);
      default:
        return [];
    }
  }

  return (event) => {
    try {
      return map(event);
    } catch {
      // A frame that does not decode as its type. The end of an execution never gets here: it is
      // read defensively above.
      return [];
    }
  };
}

/** Tool content as stored: `name` is nullable there and optional on the event. */
const storedContent = (item: ToolContent1): ToolContent =>
  item.type === "text"
    ? { type: "text", text: item.text }
    : { type: "file", uri: item.uri, mime: item.mime, name: item.name ?? null };

function toolContent([first, ...rest]: readonly [ToolContent1, ...Array<ToolContent1>]): [
  ToolContent,
  ...Array<ToolContent>,
] {
  return [storedContent(first), ...rest.map(storedContent)];
}
