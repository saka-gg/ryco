import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
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
  ],
  updatedAt: now,
} as never;

const event = (sequence: number, type: string, payload: Record<string, unknown>) => ({
  kind: "event",
  event: { sequence, type, payload },
});

describe("ryco remote threads", () => {
  it("lists open threads newest first with what they need", () => {
    const lines = formatRemoteThreads(snapshot).split("\n");
    assert.deepEqual(
      lines.map((line) => line.split(/\s{2,}/u).slice(0, 2)),
      [
        ["t-new", "needs approval"],
        ["t-old", "idle"],
      ],
    );
    assert.include(lines[0]!, "ryco / Thread t-new");
  });

  it.effect("sends with the thread's modes and prints the reply until the turn ends", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched: unknown[] = [];
        const printed: string[] = [];
        const client = {
          [ORCHESTRATION_WS_METHODS.subscribeShell]: () =>
            Stream.make({ kind: "snapshot", snapshot }),
          [ORCHESTRATION_WS_METHODS.subscribeThread]: () =>
            Stream.make(
              { kind: "snapshot", snapshot: {} },
              event(9, "thread.message-sent", { role: "assistant", messageId: "m0", text: "old", streaming: false }),
              event(11, "thread.session-set", { session: { status: "running", lastError: null } }),
              event(12, "thread.message-sent", { role: "assistant", messageId: "m1", text: "Hel", streaming: true }),
              event(13, "thread.message-sent", { role: "assistant", messageId: "m1", text: "lo", streaming: true }),
              event(14, "thread.message-sent", { role: "assistant", messageId: "m1", text: "Hello", streaming: false }),
              event(15, "thread.session-set", { session: { status: "ready", lastError: null } }),
              event(16, "thread.message-sent", { role: "assistant", messageId: "m2", text: "later", streaming: false }),
            ),
          [ORCHESTRATION_WS_METHODS.dispatchCommand]: (command: unknown) =>
            Effect.sync(() => {
              dispatched.push(command);
              return { sequence: 11 };
            }),
        } as unknown as CliRemoteRpcClient;

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
});
