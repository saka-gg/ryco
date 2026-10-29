import {
  AGENT_CONTROL_MCP_MESSAGE_PAGE_MAX_CHARS,
  AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS,
  EventId,
  MessageId,
  OrchestrationThreadShell,
  type OrchestrationMessage,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationEventType,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadShell as ThreadShell,
} from "@ryco/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Option, PubSub, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import {
  scopeShellSnapshot,
  threadKeyPageOf,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { allThreadsVisible, listThreadsPage, readThreadPage, waitThreads } from "./threadReads.ts";

const thread = (index: number, options: { archived?: boolean; projectId?: string } = {}) =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id: `thread-${String(index).padStart(3, "0")}`,
    projectId: options.projectId ?? "project-1",
    title: `Thread ${index}`,
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    // Pairs share a creation time, so the id breaks ties.
    createdAt: new Date(Date.UTC(2026, 9, 1, 0, Math.floor(index / 2))).toISOString(),
    updatedAt: "2026-10-01T00:00:00.000Z",
    archivedAt: options.archived === true ? "2026-10-02T00:00:00.000Z" : null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

// Shuffled storage order, every third thread archived, every fifth hidden from the caller.
const threads = Array.from({ length: 250 }, (_, index) =>
  thread(index, { archived: index % 3 === 0 }),
).toReversed();
const visible = (shell: ThreadShell) => Number(shell.id.slice("thread-".length)) % 5 !== 0;

const snapshot: OrchestrationShellSnapshot = {
  snapshotSequence: 9,
  projects: [],
  threads,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const makeProjections = () => {
  const calls = { keys: 0, scoped: 0 };
  const projections = {
    getShellSnapshot: () => Effect.die("an unscoped listing must not build the whole shell"),
    listThreadKeyPage: (input) =>
      Effect.sync(() => {
        calls.keys += 1;
        return threadKeyPageOf(snapshot, input);
      }),
    getScopedShellSnapshot: (scope) =>
      Effect.sync(() => {
        calls.scoped += 1;
        // Bounded by the key batch, never the whole shell.
        assert.isAtMost(scope.threadIds?.length ?? Number.POSITIVE_INFINITY, 100);
        return scopeShellSnapshot(snapshot, scope);
      }),
  } as Partial<ProjectionSnapshotQueryShape> as ProjectionSnapshotQueryShape;
  return { projections, calls };
};

const pageThrough = (projections: ProjectionSnapshotQueryShape, includeArchived: boolean) =>
  Effect.gen(function* () {
    const ids: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    for (;;) {
      const page = yield* listThreadsPage(
        projections,
        { limit: 40, includeArchived, ...(cursor === undefined ? {} : { cursor }) },
        visible,
      );
      pages += 1;
      ids.push(...page.threads.map((entry) => entry.threadId));
      if (page.nextCursor === null) break;
      cursor = page.nextCursor;
    }
    return { ids, pages };
  });

it.effect("pages an unscoped thread listing by keyset reads, never a whole shell", () =>
  Effect.gen(function* () {
    for (const includeArchived of [false, true]) {
      const { projections, calls } = makeProjections();
      const { ids, pages } = yield* pageThrough(projections, includeArchived);
      const expected = threads
        .filter((entry) => visible(entry) && (includeArchived || entry.archivedAt === null))
        .toSorted((left, right) =>
          left.createdAt === right.createdAt
            ? left.id.localeCompare(right.id)
            : left.createdAt.localeCompare(right.createdAt),
        )
        .map((entry) => entry.id);
      assert.deepEqual(ids, expected);
      assert.equal(pages, Math.ceil(expected.length / 40));
      // About one keyset batch and one bounded scoped read per page.
      assert.isAtMost(calls.keys, pages + 1);
      assert.isAtMost(calls.scoped, calls.keys);
    }
  }),
);

it.effect("rejects a malformed cursor on an unscoped listing", () =>
  Effect.gen(function* () {
    const { projections } = makeProjections();
    const failure = yield* listThreadsPage(projections, { cursor: "not-a-cursor" }).pipe(
      Effect.flip,
    );
    assert.equal(failure.reason, "Invalid cursor.");
  }),
);

describe("waitThreads", () => {
  const now = "2026-10-23T00:00:00.000Z";
  const page = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };
  const shellOf = (id: string, busy: boolean, overrides: Partial<ThreadShell> = {}) => ({
    ...thread(0),
    id: ThreadId.make(id),
    // Background work keeps a thread unsettled whatever its session says.
    backgroundLiveness: busy ? ("working" as const) : null,
    ...overrides,
  });

  const eventFor = (
    threadId: string,
    type: OrchestrationEventType,
    payload: Record<string, unknown> = {},
  ) =>
    ({
      sequence: 1,
      eventId: EventId.make(`event-${type}-${threadId}`),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: now,
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type,
      payload: { threadId, ...payload },
    }) as unknown as OrchestrationEvent;
  const activityFor = (threadId: string, kind: string, payload: Record<string, unknown> = {}) =>
    eventFor(threadId, "thread.activity-appended", {
      activity: {
        id: `activity-${kind}`,
        tone: "info",
        kind,
        summary: kind,
        payload,
        turnId: null,
        createdAt: now,
      },
    });

  /** Lets forked fibers run without advancing the test clock; true once `fiber` has ended. */
  const awaitDone = (fiber: Fiber.Fiber<unknown, unknown>) =>
    Effect.gen(function* () {
      for (let turn = 0; turn < 50 && fiber.pollUnsafe() === undefined; turn += 1) {
        yield* Effect.yieldNow;
      }
      return fiber.pollUnsafe() !== undefined;
    });

  const makeHarness = (ids: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const events = yield* PubSub.unbounded<OrchestrationEvent>();
      const shells = new Map<string, ThreadShell>(ids.map((id) => [id, shellOf(id, true)]));
      const reads = new Map<string, number>();
      let onRead: ((id: string) => Effect.Effect<void>) | undefined;
      const projections = {
        getThreadShellById: (id: string) =>
          Effect.gen(function* () {
            reads.set(id, (reads.get(id) ?? 0) + 1);
            const shell = shells.get(id);
            yield* onRead?.(id) ?? Effect.void;
            return Option.fromNullishOr(shell);
          }),
        getThreadWindow: (input: { readonly threadId: string }) =>
          Effect.succeed({
            thread: {
              ...shells.get(input.threadId)!,
              messages: [],
              activities: [],
              proposedPlans: [],
              checkpoints: [],
            },
            history: { messages: page, activities: page, proposedPlans: page, checkpoints: page },
          }),
        getThreadHistoryPage: () => Effect.die("unused"),
      } as unknown as ProjectionSnapshotQueryShape;
      const totalReads = () => [...reads.values()].reduce((sum, count) => sum + count, 0);
      return {
        events,
        shells,
        reads,
        totalReads,
        setOnRead: (next: typeof onRead) => {
          onRead = next;
        },
        publish: (event: OrchestrationEvent) => PubSub.publish(events, event),
        wait: (
          timeoutMs: number,
          access: Effect.Effect<typeof allThreadsVisible, Error> = Effect.succeed(
            allThreadsVisible,
          ),
        ) =>
          waitThreads(
            projections,
            { threadIds: ids.map((id) => ThreadId.make(id)), timeoutMs },
            access,
            {
              domainEvents: {
                subscribeDomainEvents: Effect.map(
                  PubSub.subscribe(events),
                  Stream.fromSubscription,
                ),
              },
            },
          ),
      };
    });

  it.effect("wakes when a waited thread settles, without waiting for a poll", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["thread-a", "thread-b"]);
      const fiber = yield* Effect.forkChild(harness.wait(30_000));
      // Fails on the 500 ms poll: virtual time never advances in this test.
      assert.isFalse(yield* awaitDone(fiber));
      assert.strictEqual(harness.totalReads(), 2);

      harness.shells.set("thread-a", shellOf("thread-a", false));
      yield* harness.publish(eventFor("thread-a", "thread.session-set"));
      assert.isTrue(yield* awaitDone(fiber));
      const result = yield* Fiber.join(fiber);
      assert.isFalse(result.timedOut);
      assert.deepStrictEqual(
        result.threads.map((entry) => entry.threadId),
        ["thread-a", "thread-b"],
      );
      // Two checks of two threads, then one result read each.
      assert.strictEqual(harness.totalReads(), 2 * 2 + 2);
      assert.strictEqual(yield* Clock.currentTimeMillis, 0);
    }),
  );

  it.effect("keeps an event committed while the first read runs", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["thread-a"]);
      // The first read sees the busy shell; the settle commits and publishes before it returns.
      harness.setOnRead((id) =>
        harness.reads.get(id) === 1
          ? Effect.suspend(() => {
              harness.shells.set(id, shellOf(id, false));
              return harness.publish(eventFor(id, "thread.session-set"));
            }).pipe(Effect.asVoid)
          : Effect.void,
      );
      const fiber = yield* Effect.forkChild(harness.wait(30_000));
      assert.isTrue(yield* awaitDone(fiber));
      assert.isFalse((yield* Fiber.join(fiber)).timedOut);
      // The busy first check, the woken check, the result read.
      assert.strictEqual(harness.reads.get("thread-a"), 3);
      assert.strictEqual(yield* Clock.currentTimeMillis, 0);
    }),
  );

  it.effect("ignores streaming text, tool activity, a busy fleet and other threads", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["thread-a", "thread-b"]);
      const fiber = yield* Effect.forkChild(harness.wait(30_000));
      assert.isFalse(yield* awaitDone(fiber));
      for (let index = 0; index < 100; index += 1) {
        yield* harness.publish(
          eventFor("thread-a", "thread.message-sent", { role: "assistant", streaming: true }),
        );
        yield* harness.publish(
          activityFor("thread-a", "subagent.updated", { status: "running", summary: `${index}` }),
        );
      }
      for (let index = 0; index < 20; index += 1) {
        // One completed assistant message per agent step.
        yield* harness.publish(
          eventFor("thread-b", "thread.message-sent", { role: "assistant", streaming: false }),
        );
        yield* harness.publish(activityFor("thread-b", "task.updated", { status: "running" }));
        yield* harness.publish(activityFor("thread-b", "task.progress", { status: "running" }));
        yield* harness.publish(activityFor("thread-a", "context-window.updated"));
        yield* harness.publish(activityFor("thread-a", "tool.updated"));
        yield* harness.publish(eventFor("thread-c", "thread.session-set"));
      }
      assert.isFalse(yield* awaitDone(fiber));
      assert.strictEqual(harness.totalReads(), 2);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("wakes on a pending approval", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["thread-a"]);
      const fiber = yield* Effect.forkChild(harness.wait(30_000));
      assert.isFalse(yield* awaitDone(fiber));
      harness.shells.set("thread-a", shellOf("thread-a", true, { hasPendingApprovals: true }));
      yield* harness.publish(activityFor("thread-a", "approval.requested"));
      assert.isTrue(yield* awaitDone(fiber));
      assert.isFalse((yield* Fiber.join(fiber)).timedOut);
      assert.strictEqual(yield* Clock.currentTimeMillis, 0);
    }),
  );

  it.effect("wakes when the last background task of a thread goes idle", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["thread-a"]);
      const fiber = yield* Effect.forkChild(harness.wait(30_000));
      assert.isFalse(yield* awaitDone(fiber));
      harness.shells.set("thread-a", shellOf("thread-a", false));
      yield* harness.publish(activityFor("thread-a", "task.updated", { status: "idle" }));
      assert.isTrue(yield* awaitDone(fiber));
      assert.isFalse((yield* Fiber.join(fiber)).timedOut);
    }),
  );

  it.effect("checks a busy stream of wake events at most once per 500 ms", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["thread-a", "thread-b"]);
      const fiber = yield* Effect.forkChild(harness.wait(30_000));
      assert.isFalse(yield* awaitDone(fiber));
      // Tasks of a fleet finishing one by one while others still run: each update can end
      // liveness, so each wakes, but the checks coalesce.
      for (let index = 0; index < 40; index += 1) {
        yield* harness.publish(activityFor("thread-a", "task.updated", { status: "idle" }));
        yield* Effect.yieldNow;
      }
      assert.isFalse(yield* awaitDone(fiber));
      // The initial check and one woken check; the rest wait for the trailing check.
      assert.strictEqual(harness.totalReads(), 2 * 2);
      yield* TestClock.adjust(500);
      assert.isFalse(yield* awaitDone(fiber));
      assert.strictEqual(harness.totalReads(), 2 * 3);
      yield* Fiber.interrupt(fiber);
    }),
  );

  it.effect("re-reads 8 quiet threads 10 times over 45 s instead of 91", () =>
    Effect.gen(function* () {
      const ids = Array.from({ length: 8 }, (_, index) => `thread-${index}`);
      const harness = yield* makeHarness(ids);
      const fiber = yield* Effect.forkChild(harness.wait(45_000));
      assert.isFalse(yield* awaitDone(fiber));
      yield* TestClock.adjust(45_000);
      assert.isTrue(yield* awaitDone(fiber));
      assert.isTrue((yield* Fiber.join(fiber)).timedOut);
      // Checks at 0, 5, ..., 45 s: 8 x 10 = 80 shell reads (320 SQL statements), plus one result
      // read per thread. The 500 ms poll read 8 x 91 = 728 shells (2,912 statements).
      assert.strictEqual(harness.totalReads(), 8 * 10 + 8);
    }),
  );

  it.effect("ends the wait at the fallback re-check when access is revoked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["thread-a"]);
      let checks = 0;
      const access = Effect.suspend(() => {
        checks += 1;
        return checks === 1
          ? Effect.succeed(allThreadsVisible)
          : Effect.fail(new Error("Agent Control is disabled."));
      });
      const fiber = yield* Effect.forkChild(harness.wait(30_000, access));
      assert.isFalse(yield* awaitDone(fiber));
      yield* TestClock.adjust(5_000);
      assert.isTrue(yield* awaitDone(fiber));
      const exit = yield* Fiber.await(fiber);
      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "Agent Control is disabled.");
    }),
  );

  it.effect("returns at once with a zero timeout", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness(["thread-a"]);
      const result = yield* harness.wait(0);
      assert.isTrue(result.timedOut);
      assert.strictEqual(harness.totalReads(), 2);
    }),
  );
});

describe("readThreadPage message paging", () => {
  const shell = thread(1);
  const message = (
    id: string,
    text: string,
    options: { streaming?: boolean; updatedAt?: string } = {},
  ): OrchestrationMessage => ({
    id: MessageId.make(id),
    role: "assistant",
    text,
    turnId: null,
    streaming: options.streaming ?? false,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: options.updatedAt ?? "2026-10-01T00:00:00.000Z",
  });

  const makePagingProjections = (messages: OrchestrationMessage[]) => {
    const byId = new Map(messages.map((entry) => [entry.id as string, entry]));
    return {
      byId,
      projections: {
        getThreadShellById: () => Effect.succeed(Option.some(shell)),
        getThreadWindow: () =>
          Effect.succeed({
            thread: { messages },
            history: {
              messages: { hasMoreBefore: false, oldestCursor: null },
            },
          }),
        getThreadHistoryPage: () => Effect.die("not used"),
        getThreadMessageById: (input: { readonly messageId: string }) =>
          Effect.succeed(Option.fromNullishOr(byId.get(input.messageId))),
      } as unknown as ProjectionSnapshotQueryShape,
    };
  };

  it.effect("reads a 50,000-character report whole through continuations", () =>
    Effect.gen(function* () {
      const report = Array.from({ length: 5_000 }, (_, index) => `${index}`.padStart(9, "-") + "\n")
        .join("")
        .slice(0, 50_000);
      const { projections } = makePagingProjections([message("report", report)]);
      const first = yield* readThreadPage(projections, { threadId: shell.id });
      const head = first.messages[0]!;
      assert.isTrue(head.truncated);
      assert.equal(head.text.length, AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS);
      assert.equal(head.totalChars, 50_000);
      assert.equal(head.nextOffsetChars, AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS);
      let text = head.text;
      let next = head.nextOffsetChars ?? null;
      let reads = 0;
      while (next !== null) {
        const page = yield* readThreadPage(projections, {
          threadId: shell.id,
          message: { messageId: head.messageId, version: head.version!, offsetChars: next },
        });
        const slice = page.messages[0]!;
        assert.isAtMost(slice.text.length, AGENT_CONTROL_MCP_MESSAGE_PAGE_MAX_CHARS);
        assert.equal(slice.offsetChars, next);
        assert.equal(slice.version, head.version);
        assert.isNull(page.nextCursor);
        text += slice.text;
        next = slice.nextOffsetChars ?? null;
        reads += 1;
      }
      assert.equal(text, report);
      assert.equal(reads, 3);
    }),
  );

  it.effect("refuses a changed, streaming or unknown message and a cursor with a message", () =>
    Effect.gen(function* () {
      const long = "x".repeat(AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS + 10);
      const { projections, byId } = makePagingProjections([message("m", long)]);
      const first = (yield* readThreadPage(projections, { threadId: shell.id })).messages[0]!;
      const continuation = {
        messageId: "m",
        version: first.version!,
        offsetChars: first.nextOffsetChars!,
      };

      const both = yield* readThreadPage(projections, {
        threadId: shell.id,
        cursor: "cursor",
        message: continuation,
      }).pipe(Effect.flip);
      assert.equal(both.reason, "Pass either cursor or message, not both.");

      const offset = yield* readThreadPage(projections, {
        threadId: shell.id,
        message: { ...continuation, offsetChars: long.length + 1 },
      }).pipe(Effect.flip);
      assert.equal(offset.reason, "Invalid offset for this message.");

      const unknown = yield* readThreadPage(projections, {
        threadId: shell.id,
        message: { ...continuation, messageId: "other" },
      }).pipe(Effect.flip);
      assert.equal(unknown.reason, "Message not found.");

      byId.set("m", message("m", `${long}more`, { updatedAt: "2026-10-01T00:01:00.000Z" }));
      const changed = yield* readThreadPage(projections, {
        threadId: shell.id,
        message: continuation,
      }).pipe(Effect.flip);
      assert.equal(
        changed.reason,
        "The message changed since that version. Read the thread again before continuing.",
      );

      byId.set("m", message("m", long, { streaming: true }));
      const streaming = yield* readThreadPage(projections, {
        threadId: shell.id,
        message: continuation,
      }).pipe(Effect.flip);
      assert.equal(
        streaming.reason,
        "The message is still streaming. Read the thread again after it settles.",
      );
    }),
  );

  it.effect("gives a streaming message no continuation and keeps the page budget", () =>
    Effect.gen(function* () {
      const long = "y".repeat(AGENT_CONTROL_MCP_MESSAGE_TEXT_MAX_CHARS * 2);
      const messages = [
        ...Array.from({ length: 12 }, (_, index) => message(`old-${index}`, long)),
        message("live", long, { streaming: true }),
      ];
      const { projections } = makePagingProjections(messages);
      const page = yield* readThreadPage(projections, { threadId: shell.id });
      const live = page.messages.at(-1)!;
      assert.isTrue(live.truncated);
      assert.isUndefined(live.version);
      const total = page.messages.reduce((sum, entry) => sum + entry.text.length, 0);
      assert.equal(total, 80_000);
      // Messages cut to nothing by the budget still say where to read on.
      const emptied = page.messages[0]!;
      assert.equal(emptied.text, "");
      assert.equal(emptied.nextOffsetChars, 0);
      assert.isString(emptied.version);
    }),
  );
});

describe("readThreadPage", () => {
  const page = { oldestCursor: null, newestCursor: null, hasMoreBefore: false };
  const entry = (messageId: string, text: string, author: "user" | "agent") => ({
    messageId,
    text,
    attachments: [],
    modelSelection: { instanceId: "codex", model: "gpt-5.6" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    revision: 1,
    status: "queued",
    author,
  });
  const projectionsWith = (followUpQueue: unknown) =>
    ({
      getThreadShellById: () => Effect.succeed(Option.some(thread(1))),
      getThreadWindow: () =>
        Effect.succeed({
          thread: {
            ...thread(1),
            messages: [],
            activities: [],
            proposedPlans: [],
            checkpoints: [],
            ...(followUpQueue === undefined ? {} : { followUpQueue }),
          },
          history: { messages: page, activities: page, proposedPlans: page, checkpoints: page },
        }),
      getThreadHistoryPage: () => Effect.die("unused"),
    }) as unknown as ProjectionSnapshotQueryShape;

  it.effect("lists the thread's queued follow-ups on the first page, each text cut short", () =>
    Effect.gen(function* () {
      const long = "x".repeat(600);
      const result = yield* readThreadPage(
        projectionsWith({
          entries: [entry("queued-1", "Run the tests", "user"), entry("queued-2", long, "agent")],
          hold: {
            reason: "error",
            detail: "Provider failed: Authorization: Bearer rycoac_secret-token-value",
            causeKeys: ["session-error:x"],
            heldAt: "2026-10-01T00:00:00.000Z",
          },
        }),
        { threadId: ThreadId.make("thread-001") },
      );
      assert.strictEqual(result.followUpQueue?.hold?.reason, "error");
      // A provider's raw error is redacted like other diagnostics an agent reads.
      assert.notInclude(result.followUpQueue?.hold?.detail ?? "", "secret-token-value");
      assert.deepStrictEqual(
        result.followUpQueue?.entries.map((queued) => [
          queued.messageId,
          queued.author,
          queued.text.length,
          queued.textTruncated ?? false,
        ]),
        [
          ["queued-1", "user", 13, false],
          ["queued-2", "agent", 500, true],
        ],
      );

      const empty = yield* readThreadPage(projectionsWith(undefined), {
        threadId: ThreadId.make("thread-001"),
      });
      assert.notProperty(empty, "followUpQueue");
    }),
  );
});
