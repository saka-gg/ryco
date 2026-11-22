import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  AGENT_CONTROL_CAPABILITIES,
  CommandId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadId,
  TurnId,
} from "@ryco/contracts";
import type { BrowserHandoffBridgeRequest } from "@ryco/contracts/browser-handoff";
import { Deferred, Effect, Fiber, Layer, Option, Queue } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineLive } from "../../orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../../orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../../orchestration/Layers/ProjectionSnapshotQuery.ts";
import { NO_DELEGATION_LIMITS } from "../../orchestration/delegationLimits.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../../orchestration/ThreadBackgroundLiveness.ts";
import { findThreadInArray } from "../../orchestration/threadIndex.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { RepositoryIdentityResolverLive } from "../../project/Layers/RepositoryIdentityResolver.ts";
import { ProjectAvatarStore } from "../../project/Services/ProjectAvatarStore.ts";
import {
  answerUserActionRequest,
  readThreadUserActionRequests,
  userActionRequestIdFor,
} from "../../userActionRequests/userActionRequests.ts";
import {
  decodeNodeBrowserFrame,
  NODE_BROWSER_FRAME_ACK,
  NODE_BROWSER_FRAME_CLOSE,
} from "@ryco/shared/nodeBrowserFrame";
import { userActionRemoteViewTabId } from "@ryco/shared/userActionRequests";
import { Socket } from "effect/socket";
import * as TestClock from "effect/testing/TestClock";
import { threadWakeSource, waitUntil } from "../eventDrivenWait.ts";
import type { AgentControlSessionRecord } from "../Services/AgentControlSessionRegistry.ts";
import { makeHandoffTabSource } from "./browserHandoffRemoteView.ts";
import { withComputerUseTools } from "./computerTools.ts";
import type { ViewerSocket } from "../../nodeBrowser/nodeBrowserViewerSocket.ts";
import type { AgentControlMcpTools } from "./tools.ts";

const layer = it.layer(
  OrchestrationEngineLive.pipe(
    Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
    Layer.provide(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(OrchestrationProjectionPipelineLive),
    Layer.provide(
      Layer.succeed(ProjectAvatarStore, {
        write: () => Effect.die("unused"),
        read: () => Effect.succeed(null),
        remove: () => Effect.void,
      }),
    ),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolverLive),
    Layer.provideMerge(SqlitePersistenceMemory),
    Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "ryco-browser-handoff-" })),
    Layer.provideMerge(NodeServices.layer),
  ),
);

const noTools: AgentControlMcpTools = {
  descriptors: [],
  descriptorsFor: () => Effect.succeed([]),
  hasTool: () => false,
  isWriteTool: () => false,
  callTool: () => Effect.die("not used"),
};

/** The desktop's /handoff bridge, as a small state machine the test steers. */
function fakeDesktop() {
  const state = {
    requests: [] as BrowserHandoffBridgeRequest[],
    active: new Set<string>(),
    met: false,
    alreadyMet: false,
    ended: new Map<string, string>(),
    /** The desktop's viewer token for the current hand-off; `staleOnce` refuses one call. */
    viewer: "1".repeat(32),
    staleOnce: false,
    inputs: [] as unknown[],
  };
  const handle = async (url: string | URL | Request, init?: RequestInit) => {
    assert.strictEqual(String(url), "http://127.0.0.1:12345/handoff");
    const request = JSON.parse(String(init?.body)) as BrowserHandoffBridgeRequest;
    state.requests.push(request);
    const answer = (value: unknown) => new Response(JSON.stringify(value), { status: 200 });
    if (request.op === "begin") {
      if (state.alreadyMet) {
        return answer({
          status: "already-met",
          page: { href: "https://jira.test/dashboard", title: "Dashboard", ready: "complete" },
        });
      }
      state.active.add(request.requestId);
      return answer({ status: "handed-off", remoteView: true });
    }
    if (request.op === "probe") {
      return answer(
        state.active.has(request.requestId)
          ? { status: "active", met: state.met }
          : { status: "missing" },
      );
    }
    if (request.op === "view" || request.op === "frame" || request.op === "input") {
      // The desktop's own gate: its pending hand-off, then the viewer token.
      if (!state.active.has(request.requestId) || request.tab !== "tab-1") {
        return answer({ status: "gone" });
      }
      if (request.op === "view") {
        return answer({ status: "viewing", viewer: state.viewer, cssWidth: 1280, cssHeight: 850 });
      }
      if (state.staleOnce || request.viewer !== state.viewer) {
        state.staleOnce = false;
        return answer({ status: "stale" });
      }
      if (request.op === "input") {
        state.inputs.push(...request.events);
        return answer({ status: "accepted" });
      }
      return request.since === "pixels-1"
        ? answer({ status: "unchanged" })
        : answer({
            status: "frame",
            jpeg: Buffer.from("jpeg").toString("base64"),
            width: 640,
            height: 425,
            cssWidth: 1280,
            cssHeight: 850,
            fingerprint: "pixels-1",
          });
    }
    if (request.op !== "end") return answer({ status: "gone" });
    state.active.delete(request.requestId);
    const outcome = state.ended.get(request.requestId) ?? request.outcome;
    state.ended.set(request.requestId, outcome);
    return answer({
      status: "ended",
      outcome,
      tab: "tab-1",
      url: "https://jira.test/dashboard",
      page: { href: "https://jira.test/dashboard", title: "Dashboard", ready: "complete" },
      withheld: { requests: 4, messages: 0 },
      scrubbed: 1,
      stillPaused: false,
      waitedMs: 12_000,
    });
  };
  // A fetch for the bridge only: the tool posts JSON and reads the body.
  const fetcher: typeof fetch = Object.assign(handle, { preconnect: () => undefined });
  return { state, fetcher };
}

const setup = (key: string) =>
  Effect.gen(function* () {
    const engine = yield* OrchestrationEngineService;
    const threadId = ThreadId.make(`thread-${key}`);
    const projectId = ProjectId.make(`project-${key}`);
    const createdAt = new Date().toISOString();
    yield* engine.dispatch({
      type: "project.create",
      commandId: CommandId.make(`cmd-project-${key}`),
      projectId,
      title: "Hand-off",
      workspaceRoot: process.cwd(),
      defaultModelSelection: null,
      createdAt,
    });
    yield* engine.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`cmd-thread-${key}`),
      threadId,
      projectId,
      title: "Hand-off",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
    });
    const desktop = fakeDesktop();
    const handoff = { engine, findThreadInArray, waitUntil, threadWakeSource };
    const tools = withComputerUseTools(noTools, {
      config: { url: "http://127.0.0.1:12345/control", token: "a".repeat(43) },
      policy: {
        isEnabled: Effect.succeed(true),
        delegationLimits: Effect.succeed(NO_DELEGATION_LIMITS),
        requireEnabled: () => Effect.void,
        requiredCapabilityForAction: () => AGENT_CONTROL_CAPABILITIES.read,
        authorize: () => Effect.void,
      },
      registry: {
        getTurnAuthority: (sessionId) =>
          Effect.succeed(
            Option.some({ sessionId, threadId, turnId: TurnId.make("turn-1"), boundAt: createdAt }),
          ),
      },
      fetch: desktop.fetcher,
      handoff,
    });
    const caller: AgentControlSessionRecord = {
      sessionId: `lease-${key}`,
      issuedAt: createdAt,
      threadId,
      providerInstanceId: ProviderInstanceId.make("codex"),
      runtimeSessionId: RuntimeSessionId.make("runtime-1"),
      grantedCapabilities: [AGENT_CONTROL_CAPABILITIES.controlBrowser],
      injectionMode: "codex-http",
    };
    const call = (args: Record<string, unknown>) =>
      tools.callTool(caller, "ryco_browser", {
        action: "handoff",
        browser: "ryco",
        tab: "tab-1",
        requestId: "jira",
        ...args,
      });
    return { threadId, desktop, call, deps: handoff };
  });

const textOf = (result: { content: ReadonlyArray<{ type: string; text?: string }> }) =>
  result.content.map((item) => item.text ?? "").join("\n");

const hasPendingUserInput = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projections = yield* ProjectionSnapshotQuery;
    return Option.getOrThrow(yield* projections.getThreadShellById(threadId)).hasPendingUserInput;
  });

layer("ryco_browser handoff", (it) => {
  it.effect(
    "hands the tab over, answers pending, and ends on the user's Done with the page now",
    () =>
      Effect.gen(function* () {
        const { threadId, desktop, call, deps } = yield* setup("done");
        const first = yield* call({
          message: "Sign in to Jira with your company account.",
          done_when: { url: "/dashboard" },
          waitMs: 0,
        });
        assert.isUndefined(first.isError);
        assert.match(textOf(first), /The user has tab-1 now/);
        assert.deepInclude(first.structuredContent as object, { status: "pending", tab: "tab-1" });
        assert.deepInclude(desktop.state.requests[0] as object, {
          op: "begin",
          tab: "tab-1",
          need: "sign-in",
          doneWhen: { url: "/dashboard" },
        });
        assert.isTrue(yield* hasPendingUserInput(threadId));

        // The next call waits; the user's Done on the card wakes it.
        const waiting = yield* Effect.forkChild(call({ waitMs: 20_000 }));
        yield* answerUserActionRequest(deps, {
          threadId,
          requestId: userActionRequestIdFor(threadId, "jira"),
          answer: "done",
        });
        const ended = yield* Fiber.join(waiting);
        const words = textOf(ended);
        // The structured result carries the same sentences: some clients show only it.
        assert.strictEqual((ended.structuredContent as { message: string }).message, words);
        assert.match(words, /The user said they are done/);
        assert.match(words, /Page now: https:\/\/jira\.test\/dashboard — "Dashboard"/);
        assert.match(words, /a password or code field still on the page was emptied/);
        assert.isFalse(yield* hasPendingUserInput(threadId));
        // The surface hook gave the tab back with the user's outcome.
        assert.isTrue(
          desktop.state.requests.some(
            (request) => request.op === "end" && request.outcome === "done",
          ),
        );
      }),
  );

  it.effect("ends by itself once done_when holds on the desktop", () =>
    Effect.gen(function* () {
      const { desktop, call } = yield* setup("condition");
      yield* call({ message: "Sign in.", done_when: { url: "/dashboard" }, waitMs: 0 });
      desktop.state.met = true;
      const ended = yield* call({ waitMs: 20_000 });
      assert.match(textOf(ended), /done_when matched/);
      assert.deepInclude(ended.structuredContent as object, { status: "condition-met" });
    }),
  );

  it.effect("hands nothing over when done_when already holds", () =>
    Effect.gen(function* () {
      const { threadId, desktop, call } = yield* setup("already");
      desktop.state.alreadyMet = true;
      const result = yield* call({ message: "Sign in.", done_when: { url: "/dashboard" } });
      assert.match(textOf(result), /already holds in tab-1, so nothing was handed to the user/);
      assert.isFalse(yield* hasPendingUserInput(threadId));
    }),
  );

  it.effect("refuses a selector that reads field values and a first call without a message", () =>
    Effect.gen(function* () {
      const { desktop, call } = yield* setup("refusals");
      const bad = yield* call({ message: "Sign in.", done_when: { selector: "input[value=x]" } });
      assert.isTrue(bad.isError);
      assert.match(textOf(bad), /cannot test field values/);
      const bare = yield* call({});
      assert.isTrue(bare.isError);
      assert.match(textOf(bare), /needs a message/);
      assert.lengthOf(desktop.state.requests, 0);
    }),
  );

  it.effect("trims the message, and refuses one the card could not show before handing over", () =>
    Effect.gen(function* () {
      const { threadId, desktop, call } = yield* setup("message");
      // Only spaces: refused before the desktop is asked, so the tab is never locked.
      const blank = yield* call({ message: "   ", waitMs: 0 });
      assert.isTrue(blank.isError);
      assert.match(textOf(blank), /needs a message for the user: 1 to 300 characters/);
      assert.lengthOf(desktop.state.requests, 0);
      // Spaces around a real message: trimmed, recorded, and the card shows it.
      const spaced = yield* call({ message: "  Sign in to Acme.  ", waitMs: 0 });
      assert.deepInclude(spaced.structuredContent as object, { status: "pending" });
      assert.deepInclude(desktop.state.requests[0] as object, { message: "Sign in to Acme." });
      assert.isTrue(yield* hasPendingUserInput(threadId));
    }),
  );

  it.effect(
    "lets the owner view and drive the tab while pending, and stops the moment it ends",
    () =>
      Effect.gen(function* () {
        const { threadId, desktop, call, deps } = yield* setup("remote");
        yield* call({ message: "Sign in to Acme.", waitMs: 0 });
        const requestId = userActionRequestIdFor(threadId, "jira");
        const recorded = yield* readThreadUserActionRequests(deps, threadId);
        assert.isTrue(recorded?.[0]?.remoteView);
        const source = makeHandoffTabSource({
          post: (request) =>
            Effect.promise(async () => {
              const response = await desktop.fetcher("http://127.0.0.1:12345/handoff", {
                method: "POST",
                body: JSON.stringify(request),
              });
              return JSON.parse(await response.text()) as unknown;
            }),
          requests: deps,
        });
        const tabId = userActionRemoteViewTabId(requestId);
        const still = yield* source.still({ tabId, maxWidth: 640, maxHeight: 480, quality: 50 });
        assert.deepInclude(still, { width: 640, cssWidth: 1280, bytesBase64: "anBlZw==" });
        // A token the desktop no longer takes (it restarted, the node reconnected) is renewed once.
        desktop.state.staleOnce = true;
        yield* source.input({ tabId, events: [{ type: "text", text: "secret" }] });
        assert.deepEqual(desktop.state.inputs, [{ type: "text", text: "secret" }]);
        // A viewer's resize answers the tab as it is; navigation stays on the desktop.
        const resized = yield* source.command(tabId, "resize");
        assert.deepEqual(resized.tab?.viewport, { width: 1280, height: 850 });
        const navigate = yield* Effect.flip(source.command(tabId, "navigate"));
        assert.strictEqual(navigate.code, "failed");
        // Another request's tab id, or a malformed one: not found, and the desktop is not asked.
        const asked = desktop.state.requests.length;
        const other = yield* Effect.flip(
          source.still({
            tabId: userActionRemoteViewTabId(userActionRequestIdFor(threadId, "other")),
            maxWidth: 640,
            maxHeight: 480,
            quality: 50,
          }),
        );
        assert.strictEqual(other.code, "not-found");
        assert.strictEqual(desktop.state.requests.length, asked);

        // The owner answers: from now on the node's own gate refuses, even before the desktop.
        yield* answerUserActionRequest(deps, { threadId, requestId, answer: "done" });
        const afterward = desktop.state.requests.length;
        const gone = yield* Effect.flip(
          source.input({ tabId, events: [{ type: "text", text: "late" }] }),
        );
        assert.strictEqual(gone.code, "not-found");
        assert.deepEqual(desktop.state.inputs, [{ type: "text", text: "secret" }]);
        assert.isFalse(
          desktop.state.requests
            .slice(afterward)
            .some((request) => request.op === "input" || request.op === "frame"),
        );
      }),
  );

  it.effect("streams frames to a viewer and closes it with tabGone when the hand-off ends", () =>
    Effect.gen(function* () {
      const { threadId, desktop, call, deps } = yield* setup("stream");
      yield* call({ message: "Sign in to Acme.", waitMs: 0 });
      const requestId = userActionRequestIdFor(threadId, "jira");
      const source = makeHandoffTabSource({
        post: (request) =>
          Effect.promise(async () => {
            const response = await desktop.fetcher("http://127.0.0.1:12345/handoff", {
              method: "POST",
              body: JSON.stringify(request),
            });
            return JSON.parse(await response.text()) as unknown;
          }),
        requests: deps,
      });
      const written: Array<Uint8Array | Socket.CloseEvent> = [];
      const acks = yield* Queue.unbounded<string>();
      const closed = yield* Deferred.make<Socket.CloseEvent>();
      const socket: ViewerSocket = {
        write: (chunk) =>
          Effect.gen(function* () {
            written.push(chunk);
            if (chunk instanceof Socket.CloseEvent) yield* Deferred.succeed(closed, chunk);
            // The viewer acknowledges every frame it gets.
            else yield* Queue.offer(acks, NODE_BROWSER_FRAME_ACK);
          }),
        pull: Effect.map(Queue.take(acks), (ack) => [ack]),
        bufferedBytes: () => 0,
        cut: Effect.void,
      };
      const serving = yield* Effect.forkChild(
        Effect.scoped(
          source.serveViewer(
            socket,
            new URLSearchParams({ tab: userActionRemoteViewTabId(requestId), maxWidth: "640" }),
          ),
        ),
      );
      // The first frame arrives: a node-browser envelope around the desktop's JPEG.
      yield* TestClock.adjust("1 second");
      const frame = written.find((chunk): chunk is Uint8Array => chunk instanceof Uint8Array);
      assert.isDefined(frame);
      const decoded = decodeNodeBrowserFrame(frame!);
      assert.isTrue(decoded.ok && decoded.frame.cssWidth === 1280);
      assert.isTrue(decoded.ok && Buffer.from(decoded.frame.jpeg).toString() === "jpeg");
      // The request ends: the next tick closes the stream for good.
      yield* answerUserActionRequest(deps, { threadId, requestId, answer: "declined" });
      yield* TestClock.adjust("1 second");
      const close = yield* Deferred.await(closed);
      assert.strictEqual(close.code, NODE_BROWSER_FRAME_CLOSE.tabGone);
      // serveViewerSocket ends the socket by interrupting itself after a close.
      yield* Fiber.await(serving);
    }),
  );

  it.effect("lets the agent withdraw its hand-off", () =>
    Effect.gen(function* () {
      const { threadId, call } = yield* setup("cancel");
      yield* call({ message: "Sign in.", waitMs: 0 });
      const cancelled = yield* call({ cancel: true });
      assert.match(textOf(cancelled), /was withdrawn/);
      assert.isFalse(yield* hasPendingUserInput(threadId));
    }),
  );
});
