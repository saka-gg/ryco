import type {
  AgentListOutput,
  ConfigGetOutput,
  FormInfo,
  ModelListOutput,
  OpenCodeEvent,
  ProviderInfo,
  SessionInfo,
  SessionMessageInfo,
} from "@opencode/client";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  readOpenCode2Transcript,
  type OpenCode2TranscriptName,
} from "./__fixtures__/opencode2/transcripts.ts";
import { OPENCODE_REJECTED_PASSWORD_MESSAGE } from "./openCodeProtocol.ts";
import {
  makeOpenCodeV2Api,
  OPENCODE_V2_CLOSED_STREAM_MESSAGE,
  OPENCODE_V2_SILENT_STREAM_MESSAGE,
  OPENCODE_V2_STREAM_OPEN_TIMEOUT_MESSAGE,
  readOpenCodeSseData,
  type OpenCodeV2ApiInput,
} from "./openCodeV2Client.ts";
import { createOpenCodeV2EventMapper, type OpenCodeV1Event } from "./openCodeV2Events.ts";
import type { OpenCodeV2Form } from "./openCodeV2Mapping.ts";
import { runOpenCodeSdk } from "./opencodeRuntime.ts";

const BASE_URL = "http://127.0.0.1:4096";
const DIRECTORY = "<work>";

const simple = readOpenCode2Transcript("simple");
const [MODELS] = simple.responses("model.list") as ReadonlyArray<ModelListOutput>;
const [CREATED] = simple.responses("session.create") as ReadonlyArray<{ data: SessionInfo }>;
/** A session created on OpenCode Zen's free model, `high` variant, with no agent selected. */
const SESSION = CREATED!.data;
const permissionTranscript = readOpenCode2Transcript("permission");
const [AGENTS] = permissionTranscript.responses("agent.list") as ReadonlyArray<AgentListOutput>;

type EventOf<TType extends OpenCodeEvent["type"]> = Extract<OpenCodeEvent, { type: TType }>;
const eventsOf = <TType extends OpenCodeEvent["type"]>(
  name: OpenCode2TranscriptName,
  type: TType,
) =>
  readOpenCode2Transcript(name).events.filter(
    (event): event is EventOf<TType> => event.type === type,
  );

const [FORM_CREATED] = eventsOf("question", "form.created");
const [FORM_REPLIED] = eventsOf("question", "form.replied");
const FORM = FORM_CREATED!.data.form as FormInfo;
const [PERMISSION_ASKED] = eventsOf("permission", "permission.asked");

interface Call {
  readonly method: string;
  readonly path: string;
  readonly query: URLSearchParams;
  readonly body: unknown;
  readonly headers: Headers;
}

type Route = (call: Call, signal: AbortSignal | undefined) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
const noContent = () => new Response(null, { status: 204 });

/** A 2.x server in process, keyed by `METHOD /path`; an unknown route fails the request. */
function fakeServer(routes: Readonly<Record<string, Route>>) {
  const calls: Array<Call> = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}) => {
    if (init.signal?.aborted) throw init.signal.reason;
    const url = new URL(String(input));
    const call: Call = {
      method: init.method ?? "GET",
      path: url.pathname,
      query: url.searchParams,
      body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      headers: new Headers(init.headers),
    };
    calls.push(call);
    const route = routes[`${call.method} ${call.path}`];
    if (!route) throw new Error(`Unexpected request: ${call.method} ${call.path}`);
    return route(call, init.signal ?? undefined);
  };
  return {
    calls,
    requests: () => calls.map((call) => `${call.method} ${call.path}`),
    api: (input: Partial<OpenCodeV2ApiInput> = {}) =>
      makeOpenCodeV2Api({
        baseUrl: BASE_URL,
        directory: DIRECTORY,
        fetch: fetch as typeof globalThis.fetch,
        ...input,
      }),
  };
}

/**
 * An `/api/event` response the test writes to. Like undici's, its body errors once the request's
 * signal aborts.
 */
function eventStream() {
  const encoder = new TextEncoder();
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const state = { aborted: false, cancelled: false };
  const body = new ReadableStream<Uint8Array>({
    start: (streamController) => {
      controller = streamController;
    },
    cancel: () => {
      state.cancelled = true;
    },
  });
  const write = (chunk: string | Uint8Array) =>
    controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
  const route: Route = (_call, signal) => {
    signal?.addEventListener(
      "abort",
      () => {
        state.aborted = true;
        controller.error(signal.reason);
      },
      { once: true },
    );
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  };
  return {
    route,
    write,
    emit: (event: unknown) => write(`data: ${JSON.stringify(event)}\n\n`),
    end: () => controller.close(),
    state,
  };
}

const CONNECTED = { id: "evt_connected", type: "server.connected", data: {} };

/** Every event up to the server closing the stream (a recording's end). */
async function drain(stream: AsyncGenerator<OpenCodeV1Event>): Promise<Array<OpenCodeV1Event>> {
  const events: Array<OpenCodeV1Event> = [];
  try {
    for await (const event of stream) events.push(event);
  } catch (error) {
    if (!(error instanceof Error) || error.message !== OPENCODE_V2_CLOSED_STREAM_MESSAGE)
      throw error;
  }
  return events;
}

/** Records whether a promise settled, without leaving a rejection unhandled. */
function track(promise: Promise<unknown>) {
  const state = { settled: false };
  promise.then(
    () => (state.settled = true),
    () => (state.settled = true),
  );
  return state;
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  vi.useRealTimers();
});

describe("OpenCode 2 facade requests", () => {
  it("answers the health check from /api/info with UTF-8 basic auth", async () => {
    const server = fakeServer({
      "GET /api/info": () => json({ version: "2.2.0", pid: 7, urls: [], paths: { tmp: "/tmp" } }),
    });
    const api = server.api({ serverPassword: "pässwörd✓" });

    expect(api.generation).toBe("v2");
    await expect(api.global.health()).resolves.toEqual({
      data: { healthy: true, version: "2.2.0" },
    });
    expect(server.calls[0]!.headers.get("authorization")).toBe(
      `Basic ${Buffer.from("opencode:pässwörd✓", "utf8").toString("base64")}`,
    );
  });

  it("lists models before providers, at the directory, without provider settings", async () => {
    const providers: ReadonlyArray<ProviderInfo> = [
      {
        id: "opencode",
        name: "OpenCode Zen",
        activation: "auto",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { apiKey: "sk-provider-secret" },
      },
    ];
    const server = fakeServer({
      "GET /api/model": () => json(MODELS),
      "GET /api/provider": () => json({ location: { directory: DIRECTORY }, data: providers }),
      "GET /api/agent": () => json(AGENTS),
    });
    const api = server.api();

    const { data: inventory } = await api.provider.list();
    expect(server.requests()).toEqual(["GET /api/model", "GET /api/provider"]);
    expect(inventory!.connected).toEqual(["opencode"]);
    expect(Object.keys(inventory!.all[0]!.models)).toEqual(["space-bunny-free", "big-pickle"]);
    expect(JSON.stringify(inventory)).not.toMatch(/apiKey|secret|settings/);

    const { data: agents } = await api.app.agents();
    expect(agents!.map((agent) => agent.name)).toEqual(AGENTS!.data.map((agent) => agent.id));
    expect(server.calls.map((call) => call.query.get("location[directory]"))).toEqual([
      DIRECTORY,
      DIRECTORY,
      DIRECTORY,
    ]);
  });

  it("creates a session at the directory with 2.x permission rules", async () => {
    const server = fakeServer({ "POST /api/session": () => json(CREATED) });
    const { data } = await server.api().session.create({
      title: "Ryco thread",
      permission: [
        { permission: "*", pattern: "*", action: "ask" },
        { permission: "bash", pattern: "*", action: "ask" },
      ],
    });

    expect(server.calls[0]!.body).toEqual({
      location: { directory: DIRECTORY },
      title: "Ryco thread",
      permissions: [
        { action: "*", resource: "*", effect: "ask" },
        { action: "shell", resource: "*", effect: "ask" },
      ],
    });
    expect(data).toMatchObject({ id: SESSION.id, directory: DIRECTORY, title: SESSION.title });
  });

  it("reports a missing session with the 404 status the adapter recognises", async () => {
    const server = fakeServer({
      "GET /api/session/ses_gone": () =>
        json(
          {
            _tag: "SessionNotFoundError",
            sessionID: "ses_gone",
            message: "Session not found: ses_gone",
          },
          404,
        ),
    });
    const error = await Effect.runPromise(
      Effect.flip(
        runOpenCodeSdk("session.get", () => server.api().session.get({ sessionID: "ses_gone" })),
      ),
    );

    // What `isOpenCodeNotFound` (`OpenCodeAdapter.ts`) reads: the status of the cause's cause.
    expect(Reflect.get(error.cause as object, "cause")).toMatchObject({ status: 404 });
    expect(error.detail).toBe("Session not found: ses_gone");
  });

  it("updates a session's rules and answers with the session read back", async () => {
    const rules = [{ action: "*", resource: "*", effect: "allow" as const }];
    const server = fakeServer({
      "PATCH /api/session/ses_1": () => noContent(),
      "GET /api/session/ses_1": () =>
        json({ data: { ...SESSION, id: "ses_1", permissions: rules } }),
    });
    const { data } = await server.api().session.update({
      sessionID: "ses_1",
      permission: [{ permission: "*", pattern: "*", action: "allow" }],
    });

    expect(server.requests()).toEqual(["PATCH /api/session/ses_1", "GET /api/session/ses_1"]);
    expect(server.calls[0]!.body).toEqual({ permissions: rules });
    expect(data?.permission).toEqual([{ permission: "*", pattern: "*", action: "allow" }]);
  });

  it("pages through child sessions and refuses a repeated cursor", async () => {
    let repeat = false;
    const child = (id: string) => ({ ...SESSION, id, parentID: SESSION.id });
    const server = fakeServer({
      "GET /api/session": ({ query }) =>
        query.get("cursor") === null
          ? json({ data: [child("ses_child1")], cursor: { next: "page2" } })
          : json({ data: [child("ses_child2")], cursor: repeat ? { next: "page2" } : {} }),
    });
    const api = server.api();

    const { data } = await api.session.children({ sessionID: SESSION.id });
    expect(data!.map((session) => [session.id, session.parentID])).toEqual([
      ["ses_child1", SESSION.id],
      ["ses_child2", SESSION.id],
    ]);
    expect(
      server.calls.map(({ query }) => [
        query.get("parentID"),
        query.get("cursor"),
        query.get("limit"),
      ]),
    ).toEqual([
      [SESSION.id, null, "100"],
      [SESSION.id, "page2", "100"],
    ]);

    repeat = true;
    await expect(api.session.children({ sessionID: SESSION.id })).rejects.toThrow(
      "OpenCode returned a repeated session cursor.",
    );
  });

  it("reads messages oldest first, naming the order on the first page only", async () => {
    const model = { providerID: "opencode", id: "big-pickle" };
    const pages: Record<string, { data: Array<SessionMessageInfo>; cursor: { next?: string } }> = {
      first: {
        data: [
          { id: "msg_model", type: "model-switched", time: { created: 1 }, model },
          { id: "msg_user", type: "user", time: { created: 2 }, text: "Hello" },
        ],
        cursor: { next: "page2" },
      },
      page2: {
        data: [
          {
            id: "msg_reply",
            type: "assistant",
            agent: "build",
            model,
            time: { created: 3, completed: 4 },
            content: [
              { type: "reasoning", text: "Thinking" },
              { type: "text", text: "Hi" },
              { type: "text", text: "there" },
            ],
          },
        ],
        cursor: {},
      },
    };
    const server = fakeServer({
      [`GET /api/session/${SESSION.id}/message`]: ({ query }) =>
        json(pages[query.get("cursor") ?? "first"]),
    });
    const { data } = await server.api().session.messages({ sessionID: SESSION.id });

    expect(
      server.calls.map(({ query }) => [
        query.get("order"),
        query.get("cursor"),
        query.get("limit"),
      ]),
    ).toEqual([
      ["asc", null, "200"],
      [null, "page2", "200"],
    ]);
    // Model switches have no 1.x message.
    expect(data!.map((message) => [message.info.id, message.info.role])).toEqual([
      ["msg_user", "user"],
      ["msg_reply", "assistant"],
    ]);
    expect(data![1]!.parts.map((part) => part.id)).toEqual([
      "msg_reply:reasoning:0",
      "msg_reply:text:0",
      "msg_reply:text:1",
    ]);
  });

  it("interrupts on abort and forks before the boundary message", async () => {
    const server = fakeServer({
      [`POST /api/session/${SESSION.id}/interrupt`]: () => json({ interrupted: true }),
      [`POST /api/session/${SESSION.id}/fork`]: () =>
        json({ data: { ...SESSION, id: "ses_fork" } }),
    });
    const api = server.api();

    await expect(api.session.abort({ sessionID: SESSION.id })).resolves.toEqual({ data: true });
    const { data } = await api.session.fork({ sessionID: SESSION.id, messageID: "msg_user2" });
    expect(data?.id).toBe("ses_fork");
    expect(server.calls[1]!.body).toEqual({ before: "msg_user2" });
  });

  it("lists pending permissions and replies on the request's session", async () => {
    const request = PERMISSION_ASKED!.data;
    const server = fakeServer({
      "GET /api/permission/request": () =>
        json({ location: { directory: DIRECTORY }, data: [request] }),
      [`POST /api/session/${request.sessionID}/permission/${request.id}/reply`]: () => noContent(),
    });
    const api = server.api();

    const { data } = await api.permission.list();
    expect(data).toEqual([
      expect.objectContaining({
        id: request.id,
        sessionID: request.sessionID,
        permission: "bash",
        patterns: request.resources,
      }),
    ]);
    await expect(
      api.permission.respond({
        sessionID: request.sessionID,
        permissionID: request.id,
        response: "once",
      }),
    ).resolves.toEqual({ data: true });
    expect(server.calls[1]!.body).toEqual({ decision: "once" });
  });

  it("answers a listed form with its option values and cancels an unanswered one", async () => {
    const formPath = `/api/session/${FORM.sessionID}/form/${FORM.id}`;
    const server = fakeServer({
      "GET /api/form": () => json({ location: { directory: DIRECTORY }, data: [FORM] }),
      [`POST ${formPath}/reply`]: () => noContent(),
      [`DELETE ${formPath}`]: () => noContent(),
    });
    const api = server.api();

    await expect(api.question.reply({ requestID: FORM.id, answers: [["Blue"]] })).rejects.toThrow(
      "OpenCode form is no longer pending; refresh the session.",
    );
    expect(server.calls).toEqual([]);

    const { data } = await api.question.list();
    expect(data![0]).toMatchObject({ id: FORM.id, sessionID: FORM.sessionID });
    expect(data![0]!.questions[0]!.options.map((option) => option.label)).toEqual(["Red", "Blue"]);

    await api.question.reply({ requestID: FORM.id, answers: [["Blue"]] });
    expect(server.calls.at(-1)).toMatchObject({
      method: "POST",
      path: `${formPath}/reply`,
      body: { answer: { q0: "Blue" } },
    });
    // A reply keeps the form until `form.replied`; a cancel forgets it at once.
    await api.question.reply({ requestID: FORM.id, answers: [[]] });
    expect(server.requests().at(-1)).toBe(`DELETE ${formPath}`);
    await expect(api.question.reply({ requestID: FORM.id, answers: [["Red"]] })).rejects.toThrow(
      "no longer pending",
    );
  });
});

describe("OpenCode 2 facade prompts", () => {
  function promptServer(
    options: {
      outcome?: SessionInfo["outcome"];
      /** The reply after the prompt: none, a normal one, or one whose step failed. */
      reply?: boolean | "failed";
      /** The error stored on the idle message that ends the execution. */
      idleError?: string;
      config?: ConfigGetOutput;
      agents?: AgentListOutput;
    } = {},
  ) {
    const sessionPath = `/api/session/${SESSION.id}`;
    const model = { providerID: "opencode", id: "big-pickle" };
    const assistant = (id: string, text: string): SessionMessageInfo => ({
      id,
      type: "assistant",
      agent: "build",
      model,
      time: { created: 5, completed: 6 },
      content: [{ type: "text", text }],
    });
    const failedReply: SessionMessageInfo = {
      id: "msg_reply",
      type: "assistant",
      agent: "build",
      model,
      time: { created: 5, completed: 6 },
      content: [],
      finish: "error",
      error: { type: "provider", message: "Invalid API key." },
    };
    const reply =
      options.reply === false
        ? []
        : options.reply === "failed"
          ? [failedReply]
          : [assistant("msg_reply", "A title")];
    return fakeServer({
      "GET /api/config": () => json(options.config ?? []),
      "GET /api/agent": () => json(options.agents ?? AGENTS),
      "POST /api/session": () => json(CREATED),
      [`POST ${sessionPath}/agent`]: () => noContent(),
      [`POST ${sessionPath}/model`]: () => noContent(),
      [`POST ${sessionPath}/prompt`]: ({ body }) =>
        json({
          data: {
            id: "msg_prompt",
            sessionID: SESSION.id,
            time: { created: 4 },
            type: "user",
            payload: body,
            delivery: "steer",
          },
        }),
      [`POST /api/experimental/session/${SESSION.id}/wait`]: () => noContent(),
      [`GET ${sessionPath}`]: () =>
        json({ data: { ...SESSION, outcome: options.outcome ?? "succeeded" } }),
      [`GET ${sessionPath}/message`]: () =>
        json({
          data: [
            { id: "msg_old", type: "user", time: { created: 1 }, text: "Earlier" },
            assistant("msg_old_reply", "Earlier reply"),
            { id: "msg_prompt", type: "user", time: { created: 4 }, text: "Title this" },
            ...reply,
            ...(options.idleError === undefined
              ? []
              : [
                  {
                    id: "msg_idle",
                    type: "idle",
                    time: { created: 7 },
                    outcome: "failed",
                    error: { type: "provider", message: options.idleError },
                  } satisfies SessionMessageInfo,
                ]),
          ],
          cursor: {},
        }),
    });
  }

  const promptInput = (overrides: { agent?: string; variant?: string } = {}) => ({
    sessionID: SESSION.id,
    model: { providerID: "opencode", modelID: "space-bunny-free" },
    ...overrides,
    parts: [
      { type: "text" as const, text: "Hello" },
      {
        type: "file" as const,
        mime: "image/png",
        url: "data:image/png;base64,aGVsbG8=",
        filename: "shot.png",
      },
    ],
  });

  it("switches agent and model only when they change, then steers the prompt in", async () => {
    const server = promptServer();
    const api = server.api();
    await api.session.create({ title: "Ryco thread" });
    const sent = () => {
      const requests = server.calls
        .slice(1)
        .map((call) => `${call.method} ${call.path.split("/").at(-1)}`);
      server.calls.splice(1);
      return requests;
    };

    // The session already runs this model and variant, on the default agent.
    await expect(api.session.promptAsync(promptInput({ variant: "high" }))).resolves.toEqual({
      data: undefined,
    });
    expect(sent()).toEqual(["POST prompt"]);

    await api.session.promptAsync(promptInput({ agent: "plan", variant: "high" }));
    // An agent can bring its own model, so the model is set again after an agent switch.
    expect(sent()).toEqual(["POST agent", "POST model", "POST prompt"]);
    await api.session.promptAsync(promptInput({ agent: "plan", variant: "high" }));
    expect(sent()).toEqual(["POST prompt"]);
    await api.session.promptAsync(promptInput({ agent: "plan" }));
    expect(sent()).toEqual(["POST model", "POST prompt"]);

    // Leaving plan mode: a prompt without an agent runs on the default agent, which the facade
    // reads once from the configuration and the agents (none configured here: `build`).
    await api.session.promptAsync(promptInput());
    expect(
      server.calls
        .slice(1)
        .filter((call) => call.method === "POST")
        .map((call) => call.body),
    ).toEqual([
      { agent: "build" },
      { model: { providerID: "opencode", id: "space-bunny-free" } },
      {
        text: "Hello",
        files: [{ uri: "data:image/png;base64,aGVsbG8=", name: "shot.png" }],
        delivery: "steer",
      },
    ]);
    const leaving = sent();
    expect(leaving.slice(0, 2).toSorted()).toEqual(["GET agent", "GET config"]);
    expect(leaving.slice(2)).toEqual(["POST agent", "POST model", "POST prompt"]);
    await api.session.promptAsync(promptInput());
    expect(sent()).toEqual(["POST prompt"]);

    await api.session.promptAsync(promptInput({ agent: "plan" }));
    sent();
    await api.session.promptAsync(promptInput());
    expect(sent()).toEqual(["POST agent", "POST model", "POST prompt"]);
  });

  it("returns to the user's configured default agent when leaving plan mode", async () => {
    const coder = { ...AGENTS!.data[0]!, id: "coder", name: "Coder" };
    const server = promptServer({
      // Lowest priority first: the project's `default_agent` overrides the global one.
      config: [
        {
          type: "document",
          path: "/home/.config/opencode/opencode.json",
          info: { default_agent: "plan" },
        },
        { type: "directory", path: "/work/.opencode" },
        { type: "document", path: "/work/opencode.json", info: { default_agent: "coder" } },
      ],
      agents: { ...AGENTS!, data: [...AGENTS!.data, coder] },
    });
    const api = server.api();
    await api.session.create({ title: "Ryco thread" });

    await api.session.promptAsync(promptInput({ agent: "plan" }));
    await api.session.promptAsync(promptInput());
    expect(
      server.calls
        .filter((call) => call.method === "POST" && call.path.endsWith("/agent"))
        .map((call) => call.body),
    ).toEqual([{ agent: "plan" }, { agent: "coder" }]);
    expect(
      server.calls
        .filter((call) => call.method === "GET")
        .map((call) => call.query.get("location[directory]")),
    ).toEqual([DIRECTORY, DIRECTORY]);
  });

  it("waits for the execution and returns the reply to its own prompt", async () => {
    const server = promptServer();
    const { data } = await server.api().session.prompt(promptInput());

    expect(server.requests().map((request) => request.split("/").at(-1))).toEqual([
      "model",
      "prompt",
      "wait",
      SESSION.id,
      "message",
    ]);
    expect(data!.info).toMatchObject({ id: "msg_reply", role: "assistant" });
    expect(data!.parts).toEqual([expect.objectContaining({ type: "text", text: "A title" })]);
  });

  it("returns a failed reply with its error, as 1.x does", async () => {
    const { data } = await promptServer({
      outcome: "failed",
      reply: "failed",
      idleError: "Invalid API key.",
    })
      .api()
      .session.prompt(promptInput());

    // Text generation shows `info.error.data.message`.
    expect(data!.info).toMatchObject({
      id: "msg_reply",
      finish: "error",
      error: { name: "UnknownError", data: { message: "Invalid API key." } },
    });
  });

  it("fails a prompt whose execution did not succeed or did not reply", async () => {
    // A failure before any reply: the execution's own error.
    await expect(
      promptServer({ outcome: "failed", reply: false, idleError: "Model not found: x/y." })
        .api()
        .session.prompt(promptInput()),
    ).rejects.toThrow("Model not found: x/y.");
    // A reply that ran fine, then a failed execution.
    await expect(
      promptServer({ outcome: "failed", idleError: "Rate limited." })
        .api()
        .session.prompt(promptInput()),
    ).rejects.toThrow("Rate limited.");
    await expect(
      promptServer({ outcome: "failed" }).api().session.prompt(promptInput()),
    ).rejects.toThrow("OpenCode execution failed.");
    await expect(
      promptServer({ outcome: "interrupted" }).api().session.prompt(promptInput()),
    ).rejects.toThrow("OpenCode execution interrupted.");
    await expect(
      promptServer({ reply: false }).api().session.prompt(promptInput()),
    ).rejects.toThrow("OpenCode finished without an assistant reply.");
  });
});

describe("OpenCode 2 MCP registration", () => {
  const config = {
    type: "remote" as const,
    url: "http://127.0.0.1:9/mcp",
    headers: { Authorization: "Bearer lease" },
    oauth: false as const,
    enabled: true,
  };

  function mcpServer(statuses: () => string) {
    return fakeServer({
      "PUT /api/experimental/mcp/ryco_computer": () => noContent(),
      "GET /api/mcp": () =>
        json({
          location: { directory: DIRECTORY },
          data: [
            { name: "ryco_computer", status: { status: statuses() } },
            { name: "other", status: { status: "failed", error: "unreachable" } },
          ],
        }),
    });
  }

  it("waits until the server leaves pending, then for the tool registry to settle", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    let reads = 0;
    const server = mcpServer(() => (reads++ < 2 ? "pending" : "connected"));
    const added = server.api().mcp.add({ directory: DIRECTORY, name: "ryco_computer", config });
    const state = track(added);

    await vi.advanceTimersByTimeAsync(200);
    expect(reads).toBe(3);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    await expect(added).resolves.toEqual({
      data: {
        ryco_computer: { status: "connected" },
        other: { status: "failed", error: "unreachable" },
      },
    });
    expect(server.calls[0]).toMatchObject({
      method: "PUT",
      body: {
        config: {
          type: "remote",
          url: config.url,
          headers: config.headers,
          oauth: false,
          disabled: false,
        },
      },
    });
    expect(server.calls[0]!.query.get("location[directory]")).toBe(DIRECTORY);
  });

  it("gives up on a server that stays pending", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const added = mcpServer(() => "pending")
      .api()
      .mcp.add({ directory: DIRECTORY, name: "ryco_computer", config });
    const state = track(added);

    await vi.advanceTimersByTimeAsync(8_900);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(100);
    await expect(added).rejects.toThrow(
      "Timed out waiting for OpenCode to connect the MCP server 'ryco_computer'.",
    );
  });
});

describe("OpenCode 2 event stream", () => {
  it("resolves the subscription with its first event", async () => {
    const events = eventStream();
    const server = fakeServer({ "GET /api/event": events.route });
    const subscription = server.api({ serverPassword: "secret" }).event.subscribe();
    const state = track(subscription);

    await settle();
    expect(state.settled).toBe(false);
    expect(server.calls[0]!.headers.get("accept")).toBe("text/event-stream");
    expect(server.calls[0]!.headers.get("authorization")).toMatch(/^Basic /);

    events.emit(CONNECTED);
    const { stream } = await subscription;
    await expect(stream.next()).resolves.toEqual({
      done: false,
      value: { id: CONNECTED.id, type: "server.connected", properties: {} },
    });
    await stream.return();
  });

  it.each(["simple", "tool_call", "permission", "question", "subagent", "interrupt"] as const)(
    "replays the %s recording as the mapper translates it",
    async (name) => {
      const transcript = readOpenCode2Transcript(name);
      const forms = new Map<string, OpenCodeV2Form>(
        eventsOf(name, "form.created").map((event) => [event.data.form.id, event.data.form]),
      );
      const expected = transcript.events.flatMap(
        createOpenCodeV2EventMapper(DIRECTORY, (id) => forms.get(id)),
      );
      // CRLF line ends and small chunks split lines, line ends and UTF-8 sequences.
      const bytes = new TextEncoder().encode(
        transcript.events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(""),
      );
      const events = eventStream();
      for (let offset = 0; offset < bytes.length; offset += 97) {
        events.write(bytes.subarray(offset, offset + 97));
      }
      events.end();

      const { stream } = await fakeServer({ "GET /api/event": events.route })
        .api()
        .event.subscribe();
      expect(await drain(stream)).toEqual(expected);
    },
  );

  it("skips frames it cannot read and still ends executions it cannot fully read", async () => {
    const events = eventStream();
    events.write("data: not json\n\n");
    events.write('data: {"no":"type"}\n\n');
    events.write("data: [1, 2]\n\n: keepalive\n\n");
    events.emit({ id: "evt_new", type: "brand.new.event", data: {} });
    events.emit({ id: "evt_delta", type: "session.text.delta", data: null });
    events.emit({ type: "session.execution.succeeded", data: { sessionID: "ses_1", extra: [] } });
    events.emit({ type: "session.execution.failed", data: { sessionID: "ses_1", error: 7 } });
    events.emit({ type: "session.execution.interrupted", data: {} });
    events.end();

    const { stream } = await fakeServer({ "GET /api/event": events.route }).api().event.subscribe();
    expect(await drain(stream)).toEqual([
      // The first event has no 1.x counterpart: the stream still opens with a connected event.
      { id: "evt_new", type: "server.connected", properties: {} },
      {
        id: "",
        type: "session.status",
        properties: { sessionID: "ses_1", status: { type: "idle" } },
      },
      {
        id: "",
        type: "session.error",
        properties: {
          sessionID: "ses_1",
          error: { name: "UnknownError", data: { message: "OpenCode session failed." } },
        },
      },
    ]);
  });

  it("remembers forms it streams until they are settled", async () => {
    const formPath = `/api/session/${FORM.sessionID}/form/${FORM.id}`;
    const events = eventStream();
    const server = fakeServer({
      "GET /api/event": events.route,
      [`POST ${formPath}/reply`]: () => noContent(),
    });
    const api = server.api();
    events.emit(CONNECTED);
    events.emit(FORM_CREATED);
    const { stream } = await api.event.subscribe();
    await stream.next();

    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "question.asked", properties: { id: FORM.id } },
    });
    await api.question.reply({ requestID: FORM.id, answers: [["blue"]] });
    expect(server.calls.at(-1)?.body).toEqual({ answer: { q0: "blue" } });

    events.emit(FORM_REPLIED);
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "question.replied", properties: { requestID: FORM.id, answers: [["blue"]] } },
    });
    await expect(api.question.reply({ requestID: FORM.id, answers: [["Red"]] })).rejects.toThrow(
      "no longer pending",
    );
    await stream.return();
  });

  it("fails a stream that goes silent, counting keepalives as activity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events = eventStream();
    events.emit(CONNECTED);
    const { stream } = await fakeServer({ "GET /api/event": events.route }).api().event.subscribe();
    await stream.next();
    const next = stream.next();
    const state = track(next);

    await vi.advanceTimersByTimeAsync(44_000);
    events.write(": keepalive\n\n");
    await vi.advanceTimersByTimeAsync(44_000);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(next).rejects.toThrow(OPENCODE_V2_SILENT_STREAM_MESSAGE);
    expect(events.state.aborted).toBe(true);
  });

  it("fails a stream the server closes, so a running turn does not wait forever", async () => {
    const events = eventStream();
    events.emit(CONNECTED);
    const { stream } = await fakeServer({ "GET /api/event": events.route }).api().event.subscribe();
    await stream.next();
    const next = stream.next();
    events.end();
    await expect(next).rejects.toThrow(OPENCODE_V2_CLOSED_STREAM_MESSAGE);
  });

  it("does not count the time the caller spends on an event as silence", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events = eventStream();
    events.emit(CONNECTED);
    const { stream } = await fakeServer({ "GET /api/event": events.route }).api().event.subscribe();
    await stream.next();

    // The adapter reads history after its first event before it reads on.
    await vi.advanceTimersByTimeAsync(120_000);
    events.emit({
      id: "evt_late",
      type: "session.execution.started",
      data: { sessionID: "ses_1" },
    });
    await expect(stream.next()).resolves.toMatchObject({
      value: { type: "session.status", properties: { status: { type: "busy" } } },
    });
    expect(events.state.aborted).toBe(false);
    await stream.return();
  });

  it("fails a subscription whose first event does not arrive in time", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const events = eventStream();
    const subscription = fakeServer({ "GET /api/event": events.route }).api().event.subscribe();
    const state = track(subscription);

    await vi.advanceTimersByTimeAsync(9_000);
    // Keepalives do not extend the time the first event has.
    events.write(": keepalive\n\n");
    await vi.advanceTimersByTimeAsync(999);
    expect(state.settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(subscription).rejects.toThrow(OPENCODE_V2_STREAM_OPEN_TIMEOUT_MESSAGE);
    expect(events.state.aborted).toBe(true);
  });

  it("ends quietly and closes the connection when the caller aborts or stops reading", async () => {
    const aborted = eventStream();
    aborted.emit(CONNECTED);
    const controller = new AbortController();
    const { stream } = await fakeServer({ "GET /api/event": aborted.route })
      .api()
      .event.subscribe(undefined, { signal: controller.signal });
    await stream.next();
    const next = stream.next();
    controller.abort();
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    expect(aborted.state.aborted).toBe(true);

    const abandoned = eventStream();
    abandoned.emit(CONNECTED);
    const subscription = await fakeServer({ "GET /api/event": abandoned.route })
      .api()
      .event.subscribe();
    await subscription.stream.next();
    await subscription.stream.return();
    expect(abandoned.state.aborted).toBe(true);
  });

  it("refuses a rejected password and a response that is not an event stream", async () => {
    const rejected = fakeServer({
      "GET /api/event": () => new Response("Unauthorized", { status: 401 }),
    });
    await expect(rejected.api().event.subscribe()).rejects.toThrow(
      OPENCODE_REJECTED_PASSWORD_MESSAGE,
    );
    const html = fakeServer({
      "GET /api/event": () =>
        new Response("<!doctype html>", { headers: { "content-type": "text/html" } }),
    });
    await expect(html.api().event.subscribe()).rejects.toThrow(
      "The OpenCode server did not answer with an event stream.",
    );
  });
});

describe("readOpenCodeSseData", () => {
  const body = (chunks: ReadonlyArray<string | Uint8Array>) =>
    new ReadableStream<Uint8Array>({
      start(controller) {
        const encoder = new TextEncoder();
        for (const chunk of chunks) {
          controller.enqueue(typeof chunk === "string" ? encoder.encode(chunk) : chunk);
        }
        controller.close();
      },
    });

  async function read(chunks: ReadonlyArray<string | Uint8Array>, onActivity?: () => void) {
    const data: Array<string> = [];
    for await (const item of readOpenCodeSseData(
      body(chunks),
      new AbortController().signal,
      onActivity,
    )) {
      data.push(item);
    }
    return data;
  }

  it("follows the SSE line and field rules", async () => {
    const check = new TextEncoder().encode("data: ✓\n\n");
    let activity = 0;
    expect(
      await read(
        [
          "data: one\r",
          "\n\r\ndata:two\n",
          "data:  three\nid: 1\nevent: x\n\n",
          ": keepalive\n\n",
          "data\n\n",
          "data: lone CR\r\r",
          check.subarray(0, 7),
          check.subarray(7),
          "data: cut off",
        ],
        () => activity++,
      ),
    ).toEqual(["one", "two\n three", "", "lone CR", "✓"]);
    expect(activity).toBe(9);
  });

  it("refuses an event larger than 16 MiB", async () => {
    await expect(read([`data: ${"x".repeat(16 * 1024 * 1024)}`])).rejects.toThrow(
      "The OpenCode server sent an event larger than 16 MiB.",
    );
  });
});
