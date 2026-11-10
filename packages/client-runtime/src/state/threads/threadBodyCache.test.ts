import { MessageId, ThreadId, type OrchestrationThreadActivity } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { derivePendingApprovals, derivePendingUserInputs } from "../session/session-logic.ts";
import { selectThreadLiveDetailLoaded } from "./storeSelectors.ts";
import { syncServerThreadDetail, type AppState } from "./store.ts";
import { localEnvironmentId, makeState, makeThread } from "./store.testSupport.ts";
import {
  CACHED_THREAD_PROMPT_LIMIT,
  captureOpenPromptActivities,
  decodeOpenPromptActivities,
  hydrateCachedThreadBodies,
} from "./threadBodyCache.ts";
import type { ChatMessage } from "./types.ts";

const threadId = ThreadId.make("thread-1");

function activity(
  id: string,
  kind: string,
  payload: Record<string, unknown>,
  minute: number,
): OrchestrationThreadActivity {
  return {
    id,
    kind,
    tone: "approval",
    summary: kind,
    payload,
    turnId: "turn-1",
    createdAt: `2026-08-20T00:${String(minute).padStart(2, "0")}:00.000Z`,
  } as never;
}

const question = {
  id: "q1",
  header: "Pick",
  question: "Which one?",
  options: [{ label: "A", description: "first" }],
};

function message(id: string, text: string): ChatMessage {
  return {
    id: MessageId.make(id),
    role: "assistant",
    text,
    createdAt: "2026-08-20T00:00:00.000Z",
    streaming: false,
  };
}

/** One thread whose shell is in the store and whose body is not. */
function shellOnlyState(): AppState {
  const state = makeState(makeThread());
  const environmentState = state.environmentStateById[localEnvironmentId]!;
  const { [threadId]: _messages, ...messageByThreadId } = environmentState.messageByThreadId;
  const { [threadId]: _ids, ...messageIdsByThreadId } = environmentState.messageIdsByThreadId;
  return {
    ...state,
    environmentStateById: {
      [localEnvironmentId]: { ...environmentState, messageByThreadId, messageIdsByThreadId },
    },
  };
}

const environmentOf = (state: AppState) => state.environmentStateById[localEnvironmentId]!;

describe("saved approval and question cards", () => {
  it("keeps the request rows of open cards only, with their payload allowlisted", () => {
    const activities = [
      activity(
        "a-open",
        "approval.requested",
        {
          requestId: "req-open",
          requestKind: "command",
          detail: "bun run migrate",
          approvalIdentity: { requestEventId: "evt-1", runtimeSessionId: "rs-1" },
          attachmentUrl: "https://example.test/secret",
        },
        1,
      ),
      activity(
        "a-done",
        "approval.requested",
        { requestId: "req-done", requestKind: "command" },
        2,
      ),
      activity("a-done-resolved", "approval.resolved", { requestId: "req-done" }, 3),
      activity(
        "q-open",
        "user-input.requested",
        { requestId: "req-question", questions: [question] },
        4,
      ),
      activity("tool", "tool.completed", { output: "x".repeat(10_000) }, 5),
    ];

    const saved = captureOpenPromptActivities(activities);

    expect(saved.map((entry) => entry.id)).toEqual(["a-open", "q-open"]);
    expect(saved[0]?.payload).toEqual({
      requestId: "req-open",
      requestKind: "command",
      detail: "bun run migrate",
      approvalIdentity: { requestEventId: "evt-1", runtimeSessionId: "rs-1" },
    });
    // The cards derive from the saved rows exactly as from the live ones.
    expect(derivePendingApprovals(saved)).toEqual(derivePendingApprovals(activities));
    expect(derivePendingUserInputs(saved)).toEqual(derivePendingUserInputs(activities));
  });

  it("does not keep a card whose answer was already sent", () => {
    const identity = { requestEventId: "evt-1", runtimeSessionId: "rs-1" };
    const activities = [
      activity(
        "a1",
        "approval.requested",
        { requestId: "req-1", requestKind: "command", approvalIdentity: identity },
        1,
      ),
      activity(
        "a2",
        "approval.response.submitted",
        { requestId: "req-1", approvalIdentity: identity, responseState: "submitting" },
        2,
      ),
    ];
    expect(derivePendingApprovals(activities)).toHaveLength(1);
    expect(captureOpenPromptActivities(activities)).toEqual([]);
  });

  it("keeps at most the newest cards and none with an oversized payload", () => {
    const many = Array.from({ length: CACHED_THREAD_PROMPT_LIMIT + 3 }, (_, index) =>
      activity(
        `a${index}`,
        "approval.requested",
        { requestId: `req-${index}`, requestKind: "command" },
        index,
      ),
    );
    const saved = captureOpenPromptActivities(many);
    expect(saved).toHaveLength(CACHED_THREAD_PROMPT_LIMIT);
    expect(saved.at(-1)?.id).toBe(many.at(-1)?.id);
    expect(
      captureOpenPromptActivities([
        activity(
          "big",
          "approval.requested",
          { requestId: "req-big", requestKind: "command", detail: "x".repeat(40_000) },
          1,
        ),
      ]),
    ).toEqual([]);
  });

  it("reads back valid rows only, and allowlists their payload again", () => {
    const saved = captureOpenPromptActivities([
      activity("a1", "approval.requested", { requestId: "req-1", requestKind: "command" }, 1),
    ]);
    const decoded = decodeOpenPromptActivities(JSON.parse(JSON.stringify(saved)));
    expect(decoded).toEqual(saved);
    expect(
      decodeOpenPromptActivities([
        { ...saved[0], kind: "tool.completed" },
        { ...saved[0], id: "" },
        { ...saved[0], id: "a2", tone: "loud" },
        { ...saved[0], id: "a3", payload: { requestKind: "command" } },
        { ...saved[0], id: "a4", payload: { requestId: "req-4", extra: "dropped" } },
        "garbage",
        null,
      ]).map((entry) => [entry.id, entry.payload]),
    ).toEqual([["a4", { requestId: "req-4" }]]);
    expect(decodeOpenPromptActivities("not a list")).toEqual([]);
  });
});

describe("hydrateCachedThreadBodies", () => {
  const prompts = captureOpenPromptActivities([
    activity("a1", "approval.requested", { requestId: "req-1", requestKind: "command" }, 1),
  ]);

  it("puts saved text and cards in the store as display-only state", () => {
    const next = hydrateCachedThreadBodies(shellOnlyState(), [
      {
        environmentId: localEnvironmentId,
        threadId,
        content: { messages: [message("m1", "saved")] },
        prompts,
      },
    ]);
    const environmentState = environmentOf(next);
    expect(environmentState.cachedMessageThreadIds?.[threadId]).toBe(true);
    expect(environmentState.messageIdsByThreadId[threadId]).toEqual(["m1"]);
    expect(environmentState.activityIdsByThreadId[threadId]).toEqual(["a1"]);
    expect(
      selectThreadLiveDetailLoaded(next, { environmentId: localEnvironmentId, threadId }),
    ).toBe(false);

    // The thread's live window replaces both.
    const live = syncServerThreadDetail(
      next,
      {
        ...makeThread(),
        messages: [],
        activities: [],
        proposedPlans: [],
        checkpoints: [],
        deletedAt: null,
        updatedAt: "2026-08-20T00:00:00.000Z",
      } as never,
      localEnvironmentId,
    );
    expect(environmentOf(live).cachedMessageThreadIds?.[threadId]).toBeUndefined();
    expect(environmentOf(live).activityIdsByThreadId[threadId]).toEqual([]);
  });

  it("never covers a live body, a pending send, or a thread or machine the store lacks", () => {
    const entry = {
      environmentId: localEnvironmentId,
      threadId,
      content: { messages: [message("m1", "saved")] },
      prompts,
    };
    // `makeState` holds the thread's live (empty) message list.
    const live = makeState(makeThread());
    expect(hydrateCachedThreadBodies(live, [entry])).toBe(live);

    const shellOnly = shellOnlyState();
    const pending: AppState = {
      ...shellOnly,
      environmentStateById: {
        [localEnvironmentId]: {
          ...environmentOf(shellOnly),
          pendingMessagesByThreadId: { [threadId]: [message("p1", "sending")] },
        },
      },
    };
    expect(hydrateCachedThreadBodies(pending, [entry])).toBe(pending);
    expect(
      hydrateCachedThreadBodies(shellOnly, [{ ...entry, threadId: ThreadId.make("missing") }]),
    ).toBe(shellOnly);
    expect(
      hydrateCachedThreadBodies(shellOnly, [{ ...entry, environmentId: "elsewhere" as never }]),
    ).toBe(shellOnly);
    expect(hydrateCachedThreadBodies(shellOnly, [{ ...entry, content: null, prompts: [] }])).toBe(
      shellOnly,
    );
  });

  it("refreshes a body an earlier saved copy filled in", () => {
    const first = hydrateCachedThreadBodies(shellOnlyState(), [
      {
        environmentId: localEnvironmentId,
        threadId,
        content: { messages: [message("m1", "old")] },
        prompts: [],
      },
    ]);
    const second = hydrateCachedThreadBodies(first, [
      {
        environmentId: localEnvironmentId,
        threadId,
        content: { messages: [message("m2", "newer")] },
        prompts: [],
      },
    ]);
    expect(environmentOf(second).messageIdsByThreadId[threadId]).toEqual(["m2"]);
  });
});
