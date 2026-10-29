/**
 * The OpenCode adapter running on an OpenCode 2.x server: the real 2.x facade
 * (`openCodeV2Client.ts`) between the adapter and an in-process server that replays recorded
 * OpenCode 2.0.18 sessions. The adapter itself is generation-blind, so these tests prove that the
 * facade's 1.x shapes carry its turn, interrupt, approval, question, rewind and resume flows.
 */
import assert from "node:assert/strict";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import type { OpenCodeEvent, SessionInfo, SessionMessageInfo } from "@opencode/client";
import {
  ApprovalRequestId,
  OpenCodeSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type RuntimeMode,
  RuntimeSessionId,
  ThreadId,
} from "@ryco/contracts";
import { createModelSelection } from "@ryco/shared/model";
import { Cause, Context, Effect, Exit, Layer, Option, Schema, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  readOpenCode2Transcript,
  type OpenCode2TranscriptName,
} from "../__fixtures__/opencode2/transcripts.ts";
import { makeOpenCodeV2Api } from "../openCodeV2Client.ts";
import { openCodeV2Rules } from "../openCodeV2Mapping.ts";
import {
  buildOpenCodePermissionRules,
  OpenCodeRuntime,
  OpenCodeRuntimeError,
  type OpenCodeRuntimeShape,
} from "../opencodeRuntime.ts";
import { isMissingConversationError } from "../resumeFailure.ts";
import type { OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import {
  fakeOpenCode2Server,
  json,
  noContent,
  openCode2EventStream,
  type OpenCode2Route,
} from "../testUtils/fakeOpenCode2Server.ts";
import { makeOpenCodeAdapter } from "./OpenCodeAdapter.ts";

class OpenCodeAdapter extends Context.Service<OpenCodeAdapter, OpenCodeAdapterShape>()(
  "test/OpenCodeAdapterOnV2",
) {}

const SERVER_URL = "http://127.0.0.1:4096";
const INSTANCE = ProviderInstanceId.make("opencode");
const OPENCODE = ProviderDriverKind.make("opencode");

/**
 * A recorded session's server: the routes every session start uses, answered from the recording,
 * plus `routes` a test adds. Events reach the adapter only when the test emits them.
 */
function recordedServer(name: OpenCode2TranscriptName) {
  const transcript = readOpenCode2Transcript(name);
  const [created] = transcript.responses("session.create") as ReadonlyArray<{ data: SessionInfo }>;
  const [prompted] = transcript.responses("session.prompt");
  const session = created!.data;
  const events = openCode2EventStream();
  const empty = () => json({ location: { directory: "<work>" }, data: [] });
  const sessionPath = `/api/session/${session.id}`;
  const routes: Record<string, OpenCode2Route> = {
    "GET /api/info": () => json({ version: "2.2.0", pid: 7 }),
    "GET /api/event": events.route,
    "POST /api/session": () => json(created),
    "GET /api/session": () => json({ data: [], cursor: {} }),
    "GET /api/permission/request": empty,
    "GET /api/form": empty,
    [`GET ${sessionPath}`]: () => json(created),
    [`POST ${sessionPath}/model`]: noContent,
    [`POST ${sessionPath}/agent`]: noContent,
    [`POST ${sessionPath}/prompt`]: () => json(prompted),
    // Stopping a session interrupts it.
    [`POST ${sessionPath}/interrupt`]: () => json({ interrupted: true }),
  };
  const server = fakeOpenCode2Server(routes);
  const recorded = transcript.events;
  // The stream opens with the server's first event, as 2.x sends it at once.
  events.emit(recorded[0]);
  return {
    session,
    sessionPath,
    routes,
    server,
    events,
    /**
     * Emits the recorded events after the opening one, from the first that matches `from` up to
     * and including the first that matches `until`.
     */
    replay: (
      until?: (event: OpenCodeEvent) => boolean,
      from?: (event: OpenCodeEvent) => boolean,
    ) => {
      const start = from === undefined ? 1 : recorded.findIndex(from);
      const end = until === undefined ? recorded.length : recorded.findIndex(until) + 1;
      for (const event of recorded.slice(start, end)) events.emit(event);
    },
  };
}

type RecordedServer = ReturnType<typeof recordedServer>;

/** The real adapter on a runtime whose clients are 2.x facades answered by `server`. */
function adapterOn(server: RecordedServer) {
  const runtime: OpenCodeRuntimeShape = {
    startOpenCodeServerProcess: () => Effect.die(new Error("the test uses a configured server")),
    connectToOpenCodeServer: ({ serverUrl, serverPassword }) =>
      Effect.succeed({
        url: serverUrl ?? SERVER_URL,
        ...(serverPassword ? { serverPassword } : {}),
        exitCode: null,
        external: true,
      }),
    runOpenCodeCommand: () => Effect.die(new Error("the test runs no OpenCode command")),
    createOpenCodeSdkClient: ({ baseUrl, directory, serverPassword }) =>
      Effect.sync(() =>
        makeOpenCodeV2Api({ baseUrl, directory, serverPassword, fetch: server.server.fetch }),
      ),
    loadOpenCodeInventory: () =>
      Effect.fail(
        new OpenCodeRuntimeError({ operation: "loadOpenCodeInventory", detail: "unused" }),
      ),
  };
  const settings = Schema.decodeSync(OpenCodeSettings)({
    binaryPath: "opencode",
    serverUrl: SERVER_URL,
    serverPassword: "secret-password",
  });
  return Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter(settings)).pipe(
    Layer.provideMerge(Layer.succeed(OpenCodeRuntime, runtime)),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
    Layer.provideMerge(ServerSettingsService.layerTest()),
    Layer.provideMerge(
      Layer.succeed(ProviderSessionDirectory, {
        upsert: () => Effect.void,
        getProvider: () => Effect.die(new Error("unused")),
        getBinding: () => Effect.succeed(Option.none()),
        listThreadIds: () => Effect.succeed([]),
        listBindings: () => Effect.succeed([]),
      }),
    ),
    Layer.provideMerge(NodeServices.layer),
  );
}

/** Starts a session on `server`, records the adapter's events and stops the session at the end. */
const onSession = <A, E>(
  server: RecordedServer,
  runtimeMode: RuntimeMode,
  body: (input: {
    readonly adapter: OpenCodeAdapterShape;
    readonly threadId: ThreadId;
    readonly waitFor: (
      predicate: (event: ProviderRuntimeEvent) => boolean,
    ) => Effect.Effect<ProviderRuntimeEvent>;
    readonly events: ReadonlyArray<ProviderRuntimeEvent>;
  }) => Effect.Effect<A, E, OpenCodeAdapter>,
) =>
  Effect.gen(function* () {
    const adapter = yield* OpenCodeAdapter;
    const threadId = ThreadId.make(`thread-${server.session.id}`);
    const events: Array<ProviderRuntimeEvent> = [];
    yield* Stream.runForEach(adapter.streamEvents, (event) =>
      Effect.sync(() => {
        if (event.threadId === threadId) events.push(event);
      }),
    ).pipe(Effect.forkScoped);
    const waitFor = (predicate: (event: ProviderRuntimeEvent) => boolean) =>
      Effect.gen(function* () {
        for (let attempt = 0; attempt < 400; attempt += 1) {
          const found = events.find(predicate);
          if (found) return found;
          yield* Effect.sleep("5 millis");
        }
        return yield* Effect.die(new Error("Timed out waiting for an adapter event."));
      });
    yield* adapter.startSession({
      runtimeSessionId: RuntimeSessionId.make(`runtime-${server.session.id}`),
      provider: OPENCODE,
      threadId,
      runtimeMode,
    });
    return yield* body({ adapter, threadId, waitFor, events }).pipe(
      Effect.ensuring(adapter.stopSession(threadId).pipe(Effect.ignore)),
    );
  }).pipe(Effect.scoped, Effect.provide(adapterOn(server)));

const sendTurn = (adapter: OpenCodeAdapterShape, threadId: ThreadId, input: string) =>
  adapter.sendTurn({
    threadId,
    input,
    modelSelection: createModelSelection(INSTANCE, "opencode/space-bunny-free"),
  });

const deltas = (events: ReadonlyArray<ProviderRuntimeEvent>, streamKind: string) =>
  events
    .flatMap((event) =>
      event.type === "content.delta" && event.payload.streamKind === streamKind
        ? [event.payload.delta]
        : [],
    )
    .join("");

const recordedDeltas = (name: OpenCode2TranscriptName, type: string) =>
  readOpenCode2Transcript(name)
    .events.flatMap((event) =>
      event.type === type ? [(event.data as { readonly delta: string }).delta] : [],
    )
    .join("");

it.live("completes a turn from the 2.x stream with its text and reasoning deltas", () => {
  const server = recordedServer("simple");
  return onSession(server, "full-access", ({ adapter, threadId, waitFor, events }) =>
    Effect.gen(function* () {
      yield* sendTurn(adapter, threadId, "Say hello");
      server.replay();
      const completed = yield* waitFor((event) => event.type === "turn.completed");

      assert.equal(completed.type === "turn.completed" && completed.payload.state, "completed");
      assert.ok(recordedDeltas("simple", "session.text.delta").length > 0);
      assert.equal(
        deltas(events, "assistant_text"),
        recordedDeltas("simple", "session.text.delta"),
      );
      assert.equal(
        deltas(events, "reasoning_text"),
        recordedDeltas("simple", "session.reasoning.delta"),
      );
      assert.ok(server.server.requests().includes(`POST ${server.sessionPath}/prompt`));
      // Every request, the event stream included, carries the configured password.
      const authorization = `Basic ${Buffer.from("opencode:secret-password").toString("base64")}`;
      assert.deepEqual(
        new Set(server.server.calls.map((call) => call.headers.get("authorization"))),
        new Set([authorization]),
      );
    }),
  );
});

it.live("interrupts a running turn on the 2.x session", () => {
  const server = recordedServer("interrupt");
  return onSession(server, "full-access", ({ adapter, threadId, waitFor, events }) =>
    Effect.gen(function* () {
      yield* sendTurn(adapter, threadId, "Run a long command");
      server.replay((event) => event.type === "session.tool.progress");
      yield* waitFor((event) => event.type === "item.updated" || event.type === "item.started");

      yield* adapter.interruptTurn(threadId);
      yield* waitFor((event) => event.type === "turn.aborted");
      // OpenCode then reports the interrupted execution; with no active turn it ends nothing.
      server.replay(undefined, (event) => event.type === "shell.deleted");
      yield* Effect.sleep("50 millis");

      assert.equal(
        server.server.requests().filter((request) => request.endsWith("/interrupt")).length,
        1,
      );
      assert.equal(
        events.some((event) => event.type === "turn.completed"),
        false,
      );
    }),
  );
});

it.live("asks for a 2.x permission and replies on the request's session", () => {
  const server = recordedServer("permission");
  const [asked] = readOpenCode2Transcript("permission").events.filter(
    (event) => event.type === "permission.asked",
  ) as ReadonlyArray<Extract<OpenCodeEvent, { type: "permission.asked" }>>;
  const replyPath = `${server.sessionPath}/permission/${asked!.data.id}/reply`;
  server.routes[`POST ${replyPath}`] = noContent;
  return onSession(server, "approval-required", ({ adapter, threadId, waitFor }) =>
    Effect.gen(function* () {
      yield* sendTurn(adapter, threadId, "Run echo FIRST");
      server.replay((event) => event.type === "permission.asked");
      const opened = yield* waitFor((event) => event.type === "request.opened");

      assert.equal(opened.requestId, asked!.data.id);
      assert.equal(
        opened.type === "request.opened" && opened.payload.requestType,
        "command_execution_approval",
      );
      yield* adapter.respondToRequest(threadId, ApprovalRequestId.make(asked!.data.id), "accept");
      const reply = server.server.calls.find((call) => call.path === replyPath);
      assert.deepEqual(reply?.body, { decision: "once" });

      server.replay(
        (event) => event.type === "permission.replied",
        (event) => event.type === "permission.replied",
      );
      yield* waitFor((event) => event.type === "request.resolved");
    }),
  );
});

it.live("asks a 2.x form as a question and answers it with the chosen option", () => {
  const server = recordedServer("question");
  const [created] = readOpenCode2Transcript("question").events.filter(
    (event) => event.type === "form.created",
  ) as ReadonlyArray<Extract<OpenCodeEvent, { type: "form.created" }>>;
  const form = created!.data.form;
  const replyPath = `/api/session/${form.sessionID}/form/${form.id}/reply`;
  server.routes[`POST ${replyPath}`] = noContent;
  return onSession(server, "full-access", ({ adapter, threadId, waitFor }) =>
    Effect.gen(function* () {
      yield* sendTurn(adapter, threadId, "Ask me for a color");
      server.replay((event) => event.type === "form.created");
      const requested = yield* waitFor((event) => event.type === "user-input.requested");
      assert.ok(requested.type === "user-input.requested");
      const [question] = requested.payload.questions;
      assert.deepEqual(
        question?.options.map((option) => option.label),
        ["Red", "Blue"],
      );

      yield* adapter.respondToUserInput(threadId, ApprovalRequestId.make(form.id), {
        [question!.id]: "Blue",
      });
      const reply = server.server.calls.find((call) => call.path === replyPath);
      assert.deepEqual(reply?.body, { answer: { q0: "Blue" } });

      server.replay(undefined, (event) => event.type === "form.replied");
      const completed = yield* waitFor((event) => event.type === "turn.completed");
      assert.equal(completed.type === "turn.completed" && completed.payload.state, "completed");
    }),
  );
});

it.live("rewinds a 2.x conversation by forking before the first dropped turn", () => {
  const server = recordedServer("simple");
  const { session, sessionPath } = server;
  const model = { providerID: "opencode", id: "space-bunny-free" };
  const user = (id: string, text: string): SessionMessageInfo => ({
    id,
    type: "user",
    time: { created: 1 },
    text,
  });
  const reply = (id: string, text: string): SessionMessageInfo => ({
    id,
    type: "assistant",
    agent: "build",
    model,
    time: { created: 2, completed: 3 },
    content: [{ type: "text", text }],
  });
  const history = [
    user("msg_u1", "First"),
    reply("msg_a1", "One"),
    user("msg_u2", "Second"),
    reply("msg_a2", "Two"),
  ];
  const fork = { ...session, id: "ses_fork" };
  Object.assign(server.routes, {
    [`GET ${sessionPath}/message`]: () => json({ data: history, cursor: {} }),
    [`POST ${sessionPath}/fork`]: () => json({ data: fork }),
    "GET /api/session/ses_fork/message": () => json({ data: history.slice(0, 2), cursor: {} }),
    "PATCH /api/session/ses_fork": noContent,
    "GET /api/session/ses_fork": () => json({ data: fork }),
  } satisfies Record<string, OpenCode2Route>);
  return onSession(server, "approval-required", ({ adapter, threadId }) =>
    Effect.gen(function* () {
      const thread = yield* adapter.rollbackThread(threadId, {
        numTurns: 1,
        targetTurnId: null,
        droppedTurnIds: [],
      });

      const forked = server.server.calls.find((call) => call.path === `${sessionPath}/fork`);
      assert.deepEqual(forked?.body, { before: "msg_u2" });
      // The fork gets this thread's rules, never the looser ones it might inherit.
      const patched = server.server.calls.find((call) => call.method === "PATCH");
      assert.equal(patched?.path, "/api/session/ses_fork");
      assert.deepEqual(patched?.body, {
        permissions: openCodeV2Rules(buildOpenCodePermissionRules("approval-required")),
      });
      assert.equal(thread.turns.length, 1);
      assert.equal(
        server.server.requests().some((request) => request.includes("revert")),
        false,
      );
    }),
  );
});

it.live("fails a resume of a 2.x session the server no longer has as a missing session", () => {
  const server = recordedServer("simple");
  server.routes["GET /api/session/ses_gone"] = () =>
    json(
      { _tag: "SessionNotFoundError", sessionID: "ses_gone", message: "Session not found" },
      404,
    );
  return Effect.gen(function* () {
    const adapter = yield* OpenCodeAdapter;
    const exit = yield* adapter
      .startSession({
        runtimeSessionId: RuntimeSessionId.make("runtime-resume-gone"),
        provider: OPENCODE,
        threadId: ThreadId.make("thread-resume-gone"),
        runtimeMode: "full-access",
        resumeCursor: { schemaVersion: 1, sessionId: "ses_gone" },
      })
      .pipe(Effect.exit);

    assert.ok(Exit.isFailure(exit));
    const failure = Cause.squash(exit.cause);
    assert.equal(isMissingConversationError(failure), true);
    assert.match(String(Reflect.get(failure ?? {}, "detail")), /^Session not found: ses_gone/);
    // Never a silent new session: the orchestrator decides between fresh and a handoff.
    assert.equal(server.server.requests().includes("POST /api/session"), false);
  }).pipe(Effect.provide(adapterOn(server)));
});
