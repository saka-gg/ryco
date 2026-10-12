import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationShellStreamItem,
  OrchestrationThreadShell,
  type OrchestrationShellSnapshot,
} from "@ryco/contracts";
import { Schema } from "effect";

import { pageShellSnapshot } from "./shellSnapshotPages.ts";

const now = "2026-10-12T00:00:00.000Z";
const thread = (id: string, archived: boolean, titleChars = 10): OrchestrationThreadShell =>
  Schema.decodeUnknownSync(OrchestrationThreadShell)({
    id,
    projectId: "project-1",
    title: `${id} ${"t".repeat(titleChars)}`,
    modelSelection: { instanceId: "codex", model: "fixture" },
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: archived ? now : null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
  });

const snapshotOf = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
): OrchestrationShellSnapshot => ({
  snapshotSequence: 42,
  projects: [],
  worktrees: [],
  threads,
  updatedAt: now,
});

const flatten = (messages: ReturnType<typeof pageShellSnapshot>) => messages.flat();
const threadIdsOf = (items: ReadonlyArray<OrchestrationShellStreamItem>) =>
  items.flatMap((item) =>
    item.kind === "snapshot-threads" ? item.threads.map((entry) => entry.id) : [],
  );

describe("pageShellSnapshot", () => {
  it("frames the snapshot with a header and an end marker", () => {
    const messages = pageShellSnapshot(snapshotOf([thread("a", false)]));
    const items = flatten(messages);
    assert.equal(messages.length, 1);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["snapshot-begin", "snapshot-threads", "snapshot-end"],
    );
    const begin = items[0];
    assert(begin?.kind === "snapshot-begin");
    assert.equal(begin.snapshotSequence, 42);
    assert.equal(begin.threadCount, 1);
    assert.equal(begin.archivedThreadCount, 0);
  });

  it("sends unarchived threads first and starts the archive in a new message", () => {
    const threads = [
      thread("x1", true),
      thread("a1", false),
      thread("x2", true),
      thread("a2", false),
    ];
    const messages = pageShellSnapshot(snapshotOf(threads));
    assert.equal(messages.length, 2);
    assert.deepEqual(threadIdsOf(messages[0]!), ["a1", "a2"]);
    assert.deepEqual(threadIdsOf(messages[1]!), ["x1", "x2"]);
    const begin = messages[0]![0];
    assert(begin?.kind === "snapshot-begin");
    assert.equal(begin.threadCount, 4);
    assert.equal(begin.archivedThreadCount, 2);
    assert.equal(messages[1]!.at(-1)?.kind, "snapshot-end");
  });

  it("keeps every message within the byte budget", () => {
    const threads = Array.from({ length: 300 }, (_, index) =>
      thread(`t${index}`, index % 3 === 0, 200),
    );
    const budget = 16 * 1024;
    const messages = pageShellSnapshot(snapshotOf(threads), budget);
    assert(messages.length > 4);
    for (const message of messages) {
      assert(Buffer.byteLength(JSON.stringify(message)) <= budget);
    }
    const ids = threadIdsOf(messages.flat());
    assert.equal(ids.length, threads.length);
    assert.deepEqual(new Set(ids), new Set(threads.map((entry) => entry.id)));
  });

  it("sends a thread larger than the budget alone", () => {
    const messages = pageShellSnapshot(
      snapshotOf([thread("small", false), thread("huge", false, 4_000), thread("tail", false)]),
      1_024,
    );
    assert.deepEqual(messages.map(threadIdsOf), [["small"], ["huge"], ["tail"]]);
  });

  it("pages an empty shell as header and end only", () => {
    const messages = pageShellSnapshot(snapshotOf([]));
    assert.deepEqual(
      flatten(messages).map((item) => item.kind),
      ["snapshot-begin", "snapshot-end"],
    );
  });

  it("produces items the wire schema accepts", () => {
    const messages = pageShellSnapshot(snapshotOf([thread("a", false), thread("b", true)]));
    const encode = Schema.encodeSync(Schema.Array(OrchestrationShellStreamItem));
    const decode = Schema.decodeUnknownSync(Schema.Array(OrchestrationShellStreamItem));
    const items = flatten(messages);
    assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(items)))), items);
  });
});
