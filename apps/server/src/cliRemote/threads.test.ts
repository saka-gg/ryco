import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
import { ORPHANED_PROVIDER_SESSION_ERROR } from "@ryco/shared/restartContinuation";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Stream } from "effect";

import type { CliRemoteRpcClient } from "./remotes.ts";
import { formatRemoteThreads, sendToRemoteThread } from "./threads.ts";

const now = "2026-09-30T00:00:00.000Z";
const thread = (id: string, updatedAt: string, extra: Record<string, unknown> = {}) => ({
  id,
  projectId: "project-1",
  title: `Thread ${id}`,
  runtimeMode: "full-access",
  interactionMode: "default",
  updatedAt,
  archivedAt: null,
  session: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  ...extra,
});
const snapshot = {
  snapshotSequence: 10,
  projects: [{ id: "project-1", title: "ryco" }],
  threads: [
    thread("t-old", "2026-09-01T00:00:00.000Z"),
    thread("t-new", "2026-09-29T00:00:00.000Z", { hasPendingApprovals: true }),
    thread("t-gone", "2026-09-30T00:00:00.000Z", { archivedAt: now }),
    thread("t-restarted", "2026-08-31T00:00:00.000Z", {
      session: { status: "error", lastError: ORPHANED_PROVIDER_SESSION_ERROR },
    }),
    thread("t-failed", "2026-08-30T00:00:00.000Z", {
      session: { status: "error", lastError: "The provider crashed." },
    }),
  ],
  updatedAt: now,
} as never;

const event = (sequence: number, type: string, payload: Record<string, unknown>) => ({
  kind: "event",
  event: { sequence, type, payload },
});

/** A remote serving `snapshot` and, for every thread, `threadEvents`. */
const remoteClient = (threadEvents: ReadonlyArray<unknown>, dispatched: unknown[] = []) =>
  ({
    [ORCHESTRATION_WS_METHODS.subscribeShell]: () => Stream.make({ kind: "snapshot", snapshot }),
    [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
      Stream.fromIterable([{ kind: "snapshot", snapshot: {} }, ...threadEvents]),
    [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: unknown) =>
      Effect.sync(() => {
        dispatched.push(command);
        return { sequence: 11 };
      }),
  }) as unknown as CliRemoteRpcClient;

const running = event(11, "thread.session-set", {
  session: { status: "running", lastError: null },
});

describe("ryco remote threads", () => {
  it("lists open threads newest first with what they need", () => {
    const lines = formatRemoteThreads(snapshot).split("\n");
    assert.deepEqual(
      lines.map((line) => line.split(/\s{2,}/u).slice(0, 2)),
      [
        ["t-new", "needs approval"],
        ["t-old", "idle"],
        // A node restart cut the turn off; nothing failed.
        ["t-restarted", "interrupted"],
        ["t-failed", "error"],
      ],
    );
    assert.include(lines[0]!, "ryco / Thread t-new");
  });

  it.effect("sends with the thread's modes and prints the reply until the turn ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: unknown[] = [];
        const printed: string[] = [];
        const client = remoteClient(
          [
            event(9, "thread.message-sent", {
              role: "assistant",
              messageId: "m0",
              text: "old",
              streaming: false,
            }),
            running,
            event(12, "thread.message-sent", {
              role: "assistant",
              messageId: "m1",
              text: "Hel",
              streaming: true,
            }),
            event(13, "thread.message-sent", {
              role: "assistant",
              messageId: "m1",
              text: "lo",
              streaming: true,
            }),
            event(14, "thread.message-sent", {
              role: "assistant",
              messageId: "m1",
              text: "Hello",
              streaming: false,
            }),
            event(15, "thread.session-set", { session: { status: "ready", lastError: null } }),
            event(16, "thread.message-sent", {
              role: "assistant",
              messageId: "m2",
              text: "later",
              streaming: false,
            }),
          ],
          dispatched,
        );

        const error = yield* sendToRemoteThread(client, {
          threadId: "t-old",
          text: "hi there",
          onAssistantText: (text) => printed.push(text),
        });

        assert.isNull(error);
        assert.deepEqual(printed, ["Hel", "lo"]);
        assert.deepInclude(dispatched[0] as object, {
          type: "thread.turn.start",
          threadId: "t-old",
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      }),
    ),
  );

  it.effect("reports the session's error when the turn fails", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = remoteClient([
          running,
          event(12, "thread.session-set", {
            session: { status: "error", lastError: "The provider crashed." },
          }),
        ]);
        const error = yield* sendToRemoteThread(client, {
          threadId: "t-old",
          text: "hi there",
          onAssistantText: () => undefined,
        });
        assert.strictEqual(error, "The provider crashed.");
      }),
    ),
  );

  it.effect("reports a turn a node restart cut off as interrupted, not failed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const client = remoteClient([
          running,
          event(12, "thread.session-set", {
            session: { status: "error", lastError: ORPHANED_PROVIDER_SESSION_ERROR },
          }),
        ]);
        const failure = yield* sendToRemoteThread(client, {
          threadId: "t-old",
          text: "hi there",
          onAssistantText: () => undefined,
        }).pipe(Effect.flip);
        assert.strictEqual(failure._tag, "CliRemoteError");
        assert.strictEqual(
          failure.message,
          `The turn was interrupted. ${ORPHANED_PROVIDER_SESSION_ERROR}`,
        );
      }),
    ),
  );
});
