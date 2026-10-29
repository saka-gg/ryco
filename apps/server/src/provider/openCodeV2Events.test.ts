import type {
  OpenCodeEvent,
  SessionMessageAssistant,
  SessionMessageAssistantTool,
  SessionMessageSynthetic,
  SessionMessageToolStateCompleted,
  SessionMessageUser,
} from "@opencode/client";
import type { Part, ToolPart } from "@opencode-ai/sdk/v2";
import { describe, expect, it } from "vite-plus/test";

import {
  OPENCODE2_TRANSCRIPTS,
  readOpenCode2Transcript,
  type OpenCode2TranscriptName,
} from "./__fixtures__/opencode2/transcripts.ts";
import {
  createOpenCodeV2EventMapper,
  openCodeV2BlockPartId,
  openCodeV2Message,
  openCodeV2ToolPartId,
  type OpenCodeV1Event,
} from "./openCodeV2Events.ts";
import { OpenCodeTaskLifecycle } from "./openCodeTaskLifecycle.ts";

const DIRECTORY = "<work>";

function replay(
  events: ReadonlyArray<OpenCodeEvent>,
  mapper = createOpenCodeV2EventMapper(DIRECTORY),
): Array<OpenCodeV1Event> {
  return events.flatMap((event) => mapper(event));
}

const replayTranscript = (name: OpenCode2TranscriptName) =>
  replay(readOpenCode2Transcript(name).events);

type Of<TType extends OpenCodeV1Event["type"]> = Extract<OpenCodeV1Event, { type: TType }>;
const ofType = <TType extends OpenCodeV1Event["type"]>(
  events: ReadonlyArray<OpenCodeV1Event>,
  type: TType,
) => events.filter((event): event is Of<TType> => event.type === type);

const partsOf = (events: ReadonlyArray<OpenCodeV1Event>) =>
  ofType(events, "message.part.updated").map((event) => event.properties.part);

/** The final state of each part, in the order the parts first appeared. */
function finalParts(events: ReadonlyArray<OpenCodeV1Event>): Map<string, Part> {
  const parts = new Map<string, Part>();
  for (const part of partsOf(events)) parts.set(part.id, part);
  return parts;
}

const toolStates = (events: ReadonlyArray<OpenCodeV1Event>, callID: string) =>
  partsOf(events)
    .filter((part): part is ToolPart => part.type === "tool" && part.callID === callID)
    .map((part) => part.state);

function eventsOf<TType extends OpenCodeEvent["type"]>(
  name: OpenCode2TranscriptName,
  type: TType,
): Array<Extract<OpenCodeEvent, { type: TType }>> {
  return readOpenCode2Transcript(name).events.filter(
    (event): event is Extract<OpenCodeEvent, { type: TType }> => event.type === type,
  );
}

type StoredMessage = SessionMessageUser | SessionMessageSynthetic | SessionMessageAssistant;

/**
 * The prompts, synthetic notes and assistant messages a 2.x server stores for the recorded events,
 * in order: an inbox item becomes a message with its ID, and a block or tool call takes its place
 * in `content` when it starts, and later events settle it. Independent of the mapper, so hydrated
 * parts are checked against what the live stream produced.
 */
function storedMessages(
  events: ReadonlyArray<OpenCodeEvent>,
): Array<{ sessionID: string; message: StoredMessage }> {
  const stored: Array<{ sessionID: string; message: StoredMessage }> = [];
  const assistants = new Map<string, SessionMessageAssistant>();
  const message = (sessionID: string, id: string, created: number) => {
    let assistant = assistants.get(id);
    if (!assistant) {
      assistant = {
        id,
        type: "assistant",
        agent: "build",
        model: { id: "model", providerID: "provider" },
        time: { created },
        content: [],
      };
      assistants.set(id, assistant);
      stored.push({ sessionID, message: assistant });
    }
    return assistant;
  };
  const ordinals = new Map<string, number>();
  const tool = (stored: SessionMessageAssistant, id: string) =>
    stored.content.find(
      (block): block is SessionMessageAssistantTool => block.type === "tool" && block.id === id,
    )!;
  for (const event of events) {
    switch (event.type) {
      case "session.inbox.enqueued": {
        const { sessionID, inboxID: id, item } = event.data;
        const time = { created: event.created };
        if (item.type === "user") {
          stored.push({ sessionID, message: { id, type: "user", time, text: item.payload.text } });
        } else if (item.type === "synthetic") {
          const { text, description, metadata } = item.payload;
          stored.push({
            sessionID,
            message: {
              id,
              type: "synthetic",
              time,
              text,
              ...(description !== undefined ? { description } : {}),
              ...(metadata !== undefined ? { metadata } : {}),
            },
          });
        }
        break;
      }
      case "session.text.started":
      case "session.reasoning.started": {
        const stored = message(event.data.sessionID, event.data.assistantMessageID, event.created);
        const type = event.type === "session.text.started" ? "text" : "reasoning";
        stored.content.push({ type, text: "" });
        ordinals.set(`${stored.id}:${type}:${event.data.ordinal}`, stored.content.length - 1);
        break;
      }
      case "session.text.ended":
      case "session.reasoning.ended": {
        const stored = message(event.data.sessionID, event.data.assistantMessageID, event.created);
        const type = event.type === "session.text.ended" ? "text" : "reasoning";
        const index = ordinals.get(`${stored.id}:${type}:${event.data.ordinal}`);
        if (index === undefined) stored.content.push({ type, text: event.data.text });
        else stored.content[index] = { type, text: event.data.text };
        break;
      }
      case "session.tool.input.started":
        message(event.data.sessionID, event.data.assistantMessageID, event.created).content.push({
          type: "tool",
          id: event.data.id,
          name: event.data.name,
          state: { status: "streaming", input: "" },
          time: { created: event.created },
        });
        break;
      case "session.tool.called": {
        const call = tool(
          message(event.data.sessionID, event.data.assistantMessageID, 0),
          event.data.id,
        );
        call.time.ran = event.created;
        call.state = { status: "running", input: event.data.input, metadata: {} };
        break;
      }
      case "session.tool.success":
      case "session.tool.failed": {
        const call = tool(
          message(event.data.sessionID, event.data.assistantMessageID, 0),
          event.data.id,
        );
        const input = call.state.status === "streaming" ? {} : call.state.input;
        call.time.completed = event.created;
        call.state =
          event.type === "session.tool.success"
            ? {
                status: "completed",
                input,
                // The recordings carry text content only.
                content: event.data.content as SessionMessageToolStateCompleted["content"],
                metadata: event.data.metadata ?? {},
              }
            : {
                status: "error",
                input,
                error: event.data.error,
                metadata: event.data.metadata ?? {},
              };
        break;
      }
      case "session.step.ended": {
        const stored = message(event.data.sessionID, event.data.assistantMessageID, event.created);
        stored.time.completed = event.created;
        stored.tokens = event.data.tokens;
        stored.cost = event.data.cost;
        stored.finish = event.data.finish;
        break;
      }
      default:
        break;
    }
  }
  return stored;
}

describe("OpenCode 2 event mapping", () => {
  it("streams a reasoning reply as 1.x deltas and reports usage when the step ends", () => {
    const events = replayTranscript("simple");
    const [step] = eventsOf("simple", "session.step.started");
    const messageID = step!.data.assistantMessageID;
    const sessionID = step!.data.sessionID;
    const reasoningID = openCodeV2BlockPartId(messageID, "reasoning", 0);
    const textID = openCodeV2BlockPartId(messageID, "text", 0);

    expect(events.slice(0, 3).map((event) => event.type)).toEqual([
      "server.connected",
      "session.created",
      "session.status",
    ]);
    expect(ofType(events, "session.status")[0]?.properties).toEqual({
      sessionID,
      status: { type: "busy" },
    });
    // The assistant message is announced before any of its parts.
    const firstMessage = events.findIndex((event) => event.type === "message.updated");
    const firstPart = events.findIndex((event) => event.type === "message.part.updated");
    expect(firstMessage).toBeGreaterThan(-1);
    expect(firstMessage).toBeLessThan(firstPart);
    expect(ofType(events, "message.updated")[0]?.properties.info).toMatchObject({
      id: messageID,
      role: "assistant",
      agent: "build",
      providerID: "opencode",
      modelID: "space-bunny-free",
      variant: "high",
      path: { cwd: DIRECTORY, root: DIRECTORY },
    });

    for (const [partID, type, deltaCount] of [
      [reasoningID, "reasoning", 14],
      [textID, "text", 12],
    ] as const) {
      // Announced empty, then deltas, then the full text once: never a re-sent growing body.
      const updates = partsOf(events).filter((part) => part.id === partID);
      expect(updates.map((part) => (part.type === type ? part.text.length > 0 : null))).toEqual([
        false,
        true,
      ]);
      const deltas = ofType(events, "message.part.delta").filter(
        (event) => event.properties.partID === partID,
      );
      expect(deltas).toHaveLength(deltaCount);
      expect(deltas.every((event) => event.properties.field === "text")).toBe(true);
      const ended = updates[1]!;
      expect(ended.type === type && ended.text).toBe(
        deltas.map((event) => event.properties.delta).join(""),
      );
      expect(ended.type === type && ended.time?.end).toBeTypeOf("number");
    }
    expect(finalParts(events).get(textID)).toMatchObject({
      text: expect.stringMatching(/391 is not prime: it's the product 17 × 23\.$/),
    });

    const [ended] = eventsOf("simple", "session.step.ended");
    const final = ofType(events, "message.updated").at(-1)!.properties.info;
    expect(final).toMatchObject({
      id: messageID,
      tokens: ended!.data.tokens,
      cost: ended!.data.cost,
      finish: "stop",
      time: { completed: ended!.created },
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.status",
      properties: { sessionID, status: { type: "idle" } },
    });
  });

  it("maps tool calls to 1.x tool parts with 1.x tool names", () => {
    const events = replayTranscript("tool_call");
    const [read, shell] = eventsOf("tool_call", "session.tool.input.started");
    const messageID = read!.data.assistantMessageID;

    expect(toolStates(events, read!.data.id).map((state) => state.status)).toEqual([
      "pending",
      "running",
      "completed",
    ]);
    // The shell call reports progress (its shell ID) before it completes.
    expect(toolStates(events, shell!.data.id).map((state) => state.status)).toEqual([
      "pending",
      "running",
      "running",
      "completed",
    ]);
    expect(finalParts(events).get(openCodeV2ToolPartId(messageID, shell!.data.id))).toMatchObject({
      type: "tool",
      tool: "bash",
      callID: shell!.data.id,
      messageID,
      state: {
        status: "completed",
        input: { command: "echo TOOL_OK" },
        output: "TOOL_OK\n",
        title: "bash",
        metadata: { status: "completed", exit: 0 },
      },
    });
    const readPart = finalParts(events).get(openCodeV2ToolPartId(messageID, read!.data.id));
    expect(readPart).toMatchObject({
      tool: "read",
      state: {
        status: "completed",
        output: "Read file hello.txt, lines 1-1\n1: hello from the spike",
      },
    });
  });

  it("maps permission requests and their replies, and failed tool calls", () => {
    const events = replayTranscript("permission");
    const [asked] = eventsOf("permission", "permission.asked");
    expect(ofType(events, "permission.asked")[0]?.properties).toEqual({
      id: asked!.data.id,
      sessionID: asked!.data.sessionID,
      permission: "bash",
      patterns: ["echo FIRST"],
      always: ["echo *"],
      metadata: {},
      tool: { messageID: asked!.data.source!.messageID, callID: asked!.data.source!.id },
    });
    expect(ofType(events, "permission.replied").map((event) => event.properties.reply)).toEqual([
      "once",
      "reject",
      "reject",
      "reject",
    ]);
    const [, rejected] = eventsOf("permission", "session.tool.failed");
    expect(toolStates(events, rejected!.data.id).at(-1)).toMatchObject({
      status: "error",
      error: "Unable to execute command: echo SECOND",
    });
  });

  it("maps a question form to a 1.x question and its reply to positional answers", () => {
    const [created] = eventsOf("question", "form.created");
    const form = created!.data.form;
    const events = replay(
      readOpenCode2Transcript("question").events,
      createOpenCodeV2EventMapper(DIRECTORY, (id) => (id === form.id ? form : undefined)),
    );
    expect(ofType(events, "question.asked")[0]?.properties).toEqual({
      id: form.id,
      sessionID: form.sessionID,
      questions: [
        {
          header: "Color preference",
          question: "Which color do you prefer?",
          options: [
            { label: "Red", description: "Choose the color red" },
            { label: "Blue", description: "Choose the color blue" },
          ],
          custom: true,
        },
      ],
      tool: { messageID: "msg_0eb79a277001Yxbds4JIg1DwOa", callID: "call_function_p1m69ex0bp70_1" },
    });
    // The recorded answer was typed, not picked, so it stays as typed.
    expect(ofType(events, "question.replied")[0]?.properties).toEqual({
      sessionID: form.sessionID,
      requestID: form.id,
      answers: [["blue"]],
    });
    // Without the form the answer cannot be placed; the adapter falls back to its pending copy.
    expect(ofType(replayTranscript("question"), "question.replied")[0]?.properties.answers).toEqual(
      [],
    );
  });

  it("maps a cancelled form to a rejected question", () => {
    const mapper = createOpenCodeV2EventMapper(DIRECTORY);
    expect(
      mapper({
        id: "evt",
        created: 1,
        type: "form.cancelled",
        data: { id: "frm", sessionID: "ses" },
      }),
    ).toEqual([
      {
        id: "evt",
        type: "question.rejected",
        properties: { sessionID: "ses", requestID: "frm" },
      },
    ]);
  });

  it("feeds subagent calls to the Task lifecycle as 1.x Task tool parts", () => {
    const events = replayTranscript("subagent");
    const [root, child] = eventsOf("subagent", "session.created");
    const childCreated = ofType(events, "session.created").find(
      (event) => event.properties.sessionID === child!.data.sessionID,
    );
    expect(childCreated?.properties.info).toMatchObject({
      id: child!.data.sessionID,
      parentID: root!.data.sessionID,
      title: "List files in current directory",
      slug: "hidden-mountain",
      agent: "explore",
      directory: DIRECTORY,
    });

    const call = eventsOf("subagent", "session.tool.input.started").find(
      (event) => event.data.name === "subagent",
    )!;
    const states = toolStates(events, call.data.id);
    expect(states.at(-1)).toMatchObject({
      status: "completed",
      input: { agent: "explore", subagent_type: "explore" },
      title: "List files in current directory",
      metadata: { sessionID: child!.data.sessionID, status: "completed" },
    });
    const last = states.at(-1);
    const output = last?.status === "completed" ? last.output : "";
    expect(output).toMatch(/^<task_result>\nThe current directory/);
    expect(output).not.toContain("<subagent");

    const lifecycle = new OpenCodeTaskLifecycle();
    const transitions = partsOf(events)
      .filter((part) => part.sessionID === root!.data.sessionID)
      .flatMap((part) => lifecycle.project(part));
    expect(transitions.at(-1)).toMatchObject({
      type: "completed",
      status: "completed",
      subagent: {
        providerSessionId: child!.data.sessionID,
        label: "explore",
        description: "List files in current directory",
      },
    });
    expect(transitions.at(-1)?.summary).toMatch(/^The current directory \(`<work>`\) contains/);

    // The child session's execution maps to its own status.
    expect(
      ofType(events, "session.status")
        .filter((event) => event.properties.sessionID === child!.data.sessionID)
        .map((event) => event.properties.status.type),
    ).toEqual(["busy", "idle"]);
  });

  it("completes a background subagent from its notification", () => {
    const events = replayTranscript("background");
    const [root] = eventsOf("background", "session.created");
    const lifecycle = new OpenCodeTaskLifecycle();
    const transitions: ReturnType<OpenCodeTaskLifecycle["project"]> = [];
    let afterToolSuccess: string | undefined;
    for (const part of partsOf(events)) {
      if (part.sessionID !== root!.data.sessionID) continue;
      transitions.push(...lifecycle.project(part));
      if (part.type === "tool" && part.state.status === "completed") {
        expect(part.state.metadata).toMatchObject({ background: true, status: "running" });
        afterToolSuccess = transitions.at(-1)?.status;
      }
    }
    // The call returns at once; the subagent keeps running until its notification.
    expect(afterToolSuccess).toBe("running");
    const notice = partsOf(events).find((part) => part.type === "text" && part.synthetic);
    expect(notice).toMatchObject({
      sessionID: root!.data.sessionID,
      messageID: "msg_0eb7a3aee0015KmTB8XkMDW8iy",
      text: '<task id="ses_f1485c529ffea4URrYruwEg0Ja" state="completed">\n<task_result>\nCHILD_OK\n</task_result>\n</task>',
    });
    expect(transitions.at(-1)).toMatchObject({
      type: "completed",
      status: "completed",
      summary: "CHILD_OK",
    });
  });

  it("completes a background subagent from its stored report when history is read back", () => {
    const { events } = readOpenCode2Transcript("background");
    const [root] = eventsOf("background", "session.created");
    const sessionID = root!.data.sessionID;
    const history = storedMessages(events)
      .filter((stored) => stored.sessionID === sessionID)
      .flatMap((stored) => openCodeV2Message(sessionID, stored.message, DIRECTORY) ?? []);

    // As 1.x stores it: a user message of one synthetic part, the one the live stream sent.
    const report = history.find((entry) => entry.info.id === "msg_0eb7a3aee0015KmTB8XkMDW8iy");
    const liveReport = partsOf(replay(events)).find(
      (part) => part.type === "text" && part.synthetic,
    );
    expect(report?.info).toMatchObject({ role: "user", sessionID });
    expect(report?.parts).toEqual([liveReport]);

    // What the adapter's `loadOpenCodeTasks` projects on resume: assistant parts and synthetic text.
    const project = (entries: typeof history) => {
      const lifecycle = new OpenCodeTaskLifecycle();
      return entries.flatMap((entry) =>
        entry.parts
          .filter(
            (part) => entry.info.role === "assistant" || (part.type === "text" && part.synthetic),
          )
          .flatMap((part) => lifecycle.project(part)),
      );
    };
    expect(project(history).at(-1)).toMatchObject({
      type: "completed",
      status: "completed",
      summary: "CHILD_OK",
    });
    // Without the report, the subagent would stay running.
    expect(project(history.filter((entry) => entry !== report)).at(-1)?.status).toBe("running");
  });

  it("maps an interrupted execution: failed tool, aborted step, idle session", () => {
    const events = replayTranscript("interrupt");
    const [call] = eventsOf("interrupt", "session.tool.input.started");
    expect(toolStates(events, call!.data.id).at(-1)).toMatchObject({
      status: "error",
      error: "Tool execution interrupted",
      input: { command: "sleep 60 && echo LATE", timeout: 90000 },
    });
    expect(ofType(events, "message.updated").at(-1)?.properties.info).toMatchObject({
      role: "assistant",
      error: { name: "MessageAbortedError", data: { message: "Step interrupted" } },
      finish: "error",
      tokens: { input: 8762, output: 47 },
    });
    expect(events.at(-1)).toMatchObject({
      type: "session.status",
      properties: { status: { type: "idle" } },
    });
    expect(ofType(events, "session.error")).toEqual([]);
  });

  it("ends the turn with an error when the execution fails", () => {
    const mapper = createOpenCodeV2EventMapper(DIRECTORY);
    expect(
      mapper({
        id: "evt",
        created: 1,
        type: "session.execution.failed",
        durable: { aggregateID: "ses", seq: 3, version: 1 },
        data: { sessionID: "ses", error: { type: "provider", message: "Rate limited" } },
      }),
    ).toEqual([
      {
        id: "evt",
        type: "session.error",
        properties: {
          sessionID: "ses",
          error: { name: "UnknownError", data: { message: "Rate limited" } },
        },
      },
    ]);
    expect(
      mapper({
        id: "evt",
        created: 1,
        type: "session.retry.scheduled",
        durable: { aggregateID: "ses", seq: 4, version: 1 },
        data: {
          sessionID: "ses",
          assistantMessageID: "msg",
          attempt: 2,
          at: 5_000,
          error: { type: "provider", message: "Overloaded" },
        },
      }),
    ).toEqual([
      {
        id: "evt",
        type: "session.status",
        properties: {
          sessionID: "ses",
          status: { type: "retry", attempt: 2, message: "Overloaded", next: 5_000 },
        },
      },
    ]);
  });

  it.each(OPENCODE2_TRANSCRIPTS)(
    "gives parts the same IDs live and from message.list (%s)",
    (name) => {
      const transcript = readOpenCode2Transcript(name);
      const live = finalParts(replay(transcript.events));
      const stored = storedMessages(transcript.events);
      expect(stored.length).toBeGreaterThan(0);
      for (const { sessionID, message } of stored) {
        // Prompts have no live parts: Ryco shows its own copy of what it sent.
        if (message.type === "user") continue;
        const hydrated = openCodeV2Message(sessionID, message, DIRECTORY)!;
        const liveParts = [...live.values()].filter((part) => part.messageID === message.id);
        expect(hydrated.parts.map((part) => part.id)).toEqual(liveParts.map((part) => part.id));
        for (const part of hydrated.parts) {
          const livePart = live.get(part.id)!;
          if (part.type === "tool") expect(part).toEqual(livePart);
          else expect({ ...part, time: undefined }).toEqual({ ...livePart, time: undefined });
        }
      }
    },
  );

  it("numbers text and reasoning blocks separately around tool calls", () => {
    const message: SessionMessageAssistant = {
      id: "msg",
      type: "assistant",
      agent: "build",
      model: { id: "model", providerID: "provider" },
      time: { created: 1, completed: 9 },
      content: [
        { type: "text", text: "First" },
        {
          type: "tool",
          id: "call",
          name: "read",
          state: { status: "running", input: { path: "a" }, metadata: {} },
          time: { created: 2, ran: 3 },
        },
        { type: "reasoning", text: "Think" },
        { type: "text", text: "Second" },
      ],
    };
    expect(openCodeV2Message("ses", message, DIRECTORY)?.parts.map((part) => part.id)).toEqual([
      "msg:text:0",
      "msg:tool:call",
      "msg:reasoning:0",
      "msg:text:1",
    ]);
    const live = finalParts(
      replay(
        (
          [
            ["session.text.started", 0],
            ["session.reasoning.started", 0],
            ["session.text.started", 1],
          ] as const
        ).map(([type, ordinal], index) => ({
          id: `evt${index}`,
          created: index,
          type,
          durable: { aggregateID: "ses", seq: index, version: 1 as const },
          data: { sessionID: "ses", assistantMessageID: "msg", ordinal },
        })),
      ),
    );
    expect([...live.keys()]).toEqual(["msg:text:0", "msg:reasoning:0", "msg:text:1"]);
  });

  it("maps prompts and subagent reports, and skips messages without a 1.x shape", () => {
    expect(
      openCodeV2Message(
        "ses",
        {
          id: "msg",
          type: "user",
          time: { created: 1 },
          text: "Look at this",
          files: [
            {
              data: "",
              mime: "image/png",
              name: "a.png",
              source: { type: "uri", uri: "file:///a.png" },
            },
            { data: "aGk=", mime: "text/plain", source: { type: "inline" } },
          ],
        },
        DIRECTORY,
      ),
    ).toEqual({
      info: {
        id: "msg",
        sessionID: "ses",
        role: "user",
        time: { created: 1 },
        agent: "",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        {
          id: "msg:text:0",
          sessionID: "ses",
          messageID: "msg",
          type: "text",
          text: "Look at this",
        },
        {
          id: "msg:file:0",
          sessionID: "ses",
          messageID: "msg",
          type: "file",
          mime: "image/png",
          url: "file:///a.png",
          filename: "a.png",
        },
        {
          id: "msg:file:1",
          sessionID: "ses",
          messageID: "msg",
          type: "file",
          mime: "text/plain",
          url: "data:text/plain;base64,aGk=",
        },
      ],
    });
    for (const message of [
      { id: "a", type: "agent-switched", time: { created: 1 }, agent: "plan" },
      { id: "s", type: "synthetic", time: { created: 1 }, text: "note" },
      {
        id: "r",
        type: "synthetic",
        time: { created: 1 },
        text: "Still going",
        metadata: { source: "subagent", childID: "ses_child", state: "running" },
      },
    ] as const) {
      expect(openCodeV2Message("ses", message, DIRECTORY)).toBeUndefined();
    }
    // A finished subagent's report.
    expect(
      openCodeV2Message(
        "ses",
        {
          id: "msg_report",
          type: "synthetic",
          time: { created: 7 },
          text: '<subagent sessionID="ses_child" state="error" description="Look">\nNo access\n</subagent>',
          metadata: { source: "subagent", childID: "ses_child", agent: "General", state: "error" },
        },
        DIRECTORY,
      ),
    ).toEqual({
      info: {
        id: "msg_report",
        sessionID: "ses",
        role: "user",
        time: { created: 7 },
        agent: "",
        model: { providerID: "", modelID: "" },
      },
      parts: [
        {
          id: "msg_report:text:0",
          sessionID: "ses",
          messageID: "msg_report",
          type: "text",
          synthetic: true,
          text: '<task id="ses_child" state="error">\n<task_error>\nNo access\n</task_error>\n</task>',
        },
      ],
    });
  });

  it("continues a message it joined midway with the same part IDs", () => {
    const { events } = readOpenCode2Transcript("simple");
    const full = replay(events);
    const cut = events.findIndex(
      (event, index) =>
        event.type === "session.reasoning.delta" &&
        events.slice(0, index).filter((prior) => prior.type === "session.reasoning.delta")
          .length === 4,
    );
    const resumed = replay(events.slice(cut));
    const [step] = eventsOf("simple", "session.step.started");
    const reasoningID = openCodeV2BlockPartId(step!.data.assistantMessageID, "reasoning", 0);
    // A placeholder announces the assistant message, then the part, then the delta.
    expect(resumed.slice(0, 3)).toMatchObject([
      {
        type: "message.updated",
        properties: { info: { id: step!.data.assistantMessageID, role: "assistant", agent: "" } },
      },
      { type: "message.part.updated", properties: { part: { id: reasoningID, text: "" } } },
      { type: "message.part.delta", properties: { partID: reasoningID } },
    ]);
    expect([...finalParts(resumed).keys()]).toEqual([...finalParts(full).keys()]);
    expect(
      [...finalParts(resumed).values()].map((part) =>
        part.type === "reasoning" || part.type === "text" ? part.text : "",
      ),
    ).toEqual(
      [...finalParts(full).values()].map((part) =>
        part.type === "reasoning" || part.type === "text" ? part.text : "",
      ),
    );
    expect(ofType(resumed, "message.updated").at(-1)?.properties.info).toMatchObject({
      tokens: eventsOf("simple", "session.step.ended")[0]!.data.tokens,
    });

    // A tool call whose start it missed has no name, so it is left out.
    const toolEvents = readOpenCode2Transcript("tool_call").events;
    const called = toolEvents.findIndex((event) => event.type === "session.tool.called");
    expect(
      partsOf(replay(toolEvents.slice(called))).filter((part) => part.type === "tool"),
    ).toEqual([]);
  });

  it("maps events without a 1.x counterpart and undecodable frames to nothing", () => {
    const ignored = new Set<string>();
    for (const name of OPENCODE2_TRANSCRIPTS) {
      const mapper = createOpenCodeV2EventMapper(DIRECTORY);
      for (const event of readOpenCode2Transcript(name).events) {
        if (mapper(event).length === 0) ignored.add(event.type);
      }
    }
    // A user prompt's inbox entry has no 1.x event; a subagent notification does (above).
    expect([...ignored].toSorted()).toEqual([
      "project.updated",
      "session.inbox.delivered",
      "session.inbox.enqueued",
      "session.instructions.updated",
      "session.step.streamed",
      "session.tool.input.ended",
      "session.usage.updated",
      "shell.created",
      "shell.deleted",
      "shell.exited",
    ]);

    const mapper = createOpenCodeV2EventMapper(DIRECTORY);
    const frames: ReadonlyArray<unknown> = [
      { id: "evt", type: "provider.quota", data: { used: 1 } },
      { id: "evt", type: "session.compaction.started", data: { sessionID: "ses" } },
      { id: "evt", type: "session.text.delta" },
      { id: "evt", type: "session.step.started", data: null },
      { id: "evt", type: "permission.asked", data: { id: "per" } },
      { id: "evt", type: "form.created", data: { form: { id: "frm", sessionID: "ses" } } },
      { id: "evt", type: "session.execution.succeeded", data: {} },
      { type: "session.execution.interrupted" },
    ];
    for (const frame of frames) expect(mapper(frame as OpenCodeEvent)).toEqual([]);
  });

  it("still ends the execution for an undecodable terminal frame that names its session", () => {
    const mapper = createOpenCodeV2EventMapper(DIRECTORY);
    expect(
      mapper({ type: "session.execution.failed", data: { sessionID: "ses" } } as OpenCodeEvent),
    ).toEqual([
      {
        id: "",
        type: "session.error",
        properties: {
          sessionID: "ses",
          error: { name: "UnknownError", data: { message: "OpenCode session failed." } },
        },
      },
    ]);
    expect(
      mapper({
        id: "evt",
        type: "session.execution.succeeded",
        data: { sessionID: "ses", extra: 1 },
      } as unknown as OpenCodeEvent),
    ).toEqual([
      {
        id: "evt",
        type: "session.status",
        properties: { sessionID: "ses", status: { type: "idle" } },
      },
    ]);
  });

  it("keeps a bounded set of streaming messages", () => {
    const mapper = createOpenCodeV2EventMapper(DIRECTORY);
    const stepStarted = (index: number): OpenCodeEvent => ({
      id: `evt${index}`,
      created: index,
      type: "session.step.started",
      durable: { aggregateID: "ses", seq: index, version: 1 },
      data: {
        sessionID: "ses",
        assistantMessageID: `msg${index}`,
        agent: "build",
        model: { id: "model", providerID: "provider" },
        started: index,
      },
    });
    const textStarted = (messageID: string): OpenCodeEvent => ({
      id: "evt",
      created: 1_000,
      type: "session.text.started",
      durable: { aggregateID: "ses", seq: 1_000, version: 1 },
      data: { sessionID: "ses", assistantMessageID: messageID, ordinal: 0 },
    });
    for (let index = 0; index < 300; index++) mapper(stepStarted(index));
    // The oldest messages were let go: a late part re-announces its message.
    expect(mapper(textStarted("msg0")).map((event) => event.type)).toEqual([
      "message.updated",
      "message.part.updated",
    ]);
    expect(mapper(textStarted("msg299")).map((event) => event.type)).toEqual([
      "message.part.updated",
    ]);
  });

  it("records the OpenCode version of every fixture", () => {
    for (const name of OPENCODE2_TRANSCRIPTS) {
      expect(readOpenCode2Transcript(name).version).toBe("2.0.18");
    }
  });
});
