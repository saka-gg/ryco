import { assert, describe, it } from "@effect/vitest";
import {
  OrchestrationArchivedThreadStub,
  OrchestrationShellStreamItem,
  OrchestrationThreadShell,
  type OrchestrationShellSnapshot,
  type OrchestrationStubbedShellSnapshot,
} from "@ryco/contracts";
import { Schema } from "effect";
import { vi } from "vitest";

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

const stub = (id: string, titleChars = 10): OrchestrationArchivedThreadStub =>
  Schema.decodeUnknownSync(OrchestrationArchivedThreadStub)({
    id,
    projectId: "project-1",
    title: `${id} ${"t".repeat(titleChars)}`,
    branch: null,
    worktreePath: null,
    worktreeId: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: now,
    latestUserMessageAt: null,
    lineage: null,
  });

const stubbedSnapshotOf = (
  threads: ReadonlyArray<OrchestrationThreadShell>,
  archivedThreadStubs: ReadonlyArray<OrchestrationArchivedThreadStub>,
): OrchestrationStubbedShellSnapshot => ({ ...snapshotOf(threads), archivedThreadStubs });

const stubIdsOf = (items: ReadonlyArray<OrchestrationShellStreamItem>) =>
  items.flatMap((item) =>
    item.kind === "snapshot-archived-threads" ? item.threads.map((entry) => entry.id) : [],
  );

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

  it("sends unarchived threads first, in one message while the shell fits the budget", () => {
    const threads = [
      thread("x1", true),
      thread("a1", false),
      thread("x2", true),
      thread("a2", false),
    ];
    const messages = pageShellSnapshot(snapshotOf(threads));
    // Every message costs an ack round trip; the archive does not get one of its own.
    assert.equal(messages.length, 1);
    assert.deepEqual(threadIdsOf(messages[0]!), ["a1", "a2", "x1", "x2"]);
    const begin = messages[0]![0];
    assert(begin?.kind === "snapshot-begin");
    assert.equal(begin.threadCount, 4);
    assert.equal(begin.archivedThreadCount, 2);
    assert.equal(messages[0]!.at(-1)?.kind, "snapshot-end");
  });

  it("spills the archive into the next message only when the budget is exceeded", () => {
    const threads = [thread("a1", false, 300), thread("x1", true, 300), thread("x2", true, 300)];
    const oneThread = Buffer.byteLength(JSON.stringify(threads[0]));
    const messages = pageShellSnapshot(snapshotOf(threads), oneThread * 2 + 400);
    assert.deepEqual(messages.map(threadIdsOf), [["a1", "x1"], ["x2"]]);
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

  it("sends archived stubs after every full shell, counted in the header", () => {
    const messages = pageShellSnapshot(
      stubbedSnapshotOf([thread("a1", false), thread("a2", false)], [stub("x1"), stub("x2")]),
    );
    assert.equal(messages.length, 1);
    const items = flatten(messages);
    assert.deepEqual(
      items.map((item) => item.kind),
      ["snapshot-begin", "snapshot-threads", "snapshot-archived-threads", "snapshot-end"],
    );
    const begin = items[0];
    assert(begin?.kind === "snapshot-begin");
    assert.equal(begin.threadCount, 4);
    assert.equal(begin.archivedThreadCount, 2);
    assert.deepEqual(threadIdsOf(items), ["a1", "a2"]);
    assert.deepEqual(stubIdsOf(items), ["x1", "x2"]);
  });

  it("keeps stub pages within the byte budget too", () => {
    const budget = 8 * 1024;
    const messages = pageShellSnapshot(
      stubbedSnapshotOf(
        Array.from({ length: 40 }, (_, index) => thread(`a${index}`, false, 200)),
        Array.from({ length: 400 }, (_, index) => stub(`x${index}`, 200)),
      ),
      budget,
    );
    assert(messages.length > 4);
    for (const message of messages) {
      assert(Buffer.byteLength(JSON.stringify(message)) <= budget);
    }
    const items = flatten(messages);
    assert.equal(threadIdsOf(items).length, 40);
    assert.equal(stubIdsOf(items).length, 400);
    // Full shells never follow a stub.
    const kinds = items.map((item) => item.kind);
    assert(kinds.lastIndexOf("snapshot-threads") < kinds.indexOf("snapshot-archived-threads"));
  });

  it("pages a stubbed shell with no archived threads like a full one", () => {
    const messages = pageShellSnapshot(stubbedSnapshotOf([thread("a", false)], []));
    assert.deepEqual(
      flatten(messages).map((item) => item.kind),
      ["snapshot-begin", "snapshot-threads", "snapshot-end"],
    );
  });

  it("is far smaller with archived stubs than with archived full shells", () => {
    const full = pageShellSnapshot(
      snapshotOf(Array.from({ length: 50 }, (_, index) => thread(`x${index}`, true))),
    );
    const stubbed = pageShellSnapshot(
      stubbedSnapshotOf(
        [],
        Array.from({ length: 50 }, (_, index) => stub(`x${index}`)),
      ),
    );
    assert(
      Buffer.byteLength(JSON.stringify(stubbed)) < Buffer.byteLength(JSON.stringify(full)) * 0.7,
    );
  });

  it("pages the same snapshot identically for every subscriber", () => {
    const snapshot = stubbedSnapshotOf(
      Array.from({ length: 60 }, (_, index) => thread(`t${index}`, index % 4 === 0, 150)),
      Array.from({ length: 40 }, (_, index) => stub(`x${index}`, 150)),
    );
    const budget = 8 * 1024;
    const first = pageShellSnapshot(snapshot, budget);
    const second = pageShellSnapshot(snapshot, budget);
    assert(first.length > 2);
    assert.deepEqual(second, first);
  });

  it("measures each thread and stub once, however many subscribers receive the snapshot", () => {
    const threads = [thread("a", false), thread("b", false), thread("x", true)];
    const stubs = [stub("s1"), stub("s2")];
    const snapshot = stubbedSnapshotOf(threads, stubs);
    const measured = new Map<object, number>();
    const stringify = JSON.stringify;
    const spy = vi.spyOn(JSON, "stringify").mockImplementation((...args) => {
      const [value] = args;
      if (typeof value === "object" && value !== null) {
        measured.set(value, (measured.get(value) ?? 0) + 1);
      }
      return stringify(...args);
    });
    try {
      pageShellSnapshot(snapshot);
      pageShellSnapshot(snapshot);
      pageShellSnapshot(snapshot, 1_024);
    } finally {
      spy.mockRestore();
    }
    for (const entry of [...threads, ...stubs]) {
      assert.equal(measured.get(entry), 1);
    }
  });

  it("produces items the wire schema accepts", () => {
    const messages = pageShellSnapshot(snapshotOf([thread("a", false), thread("b", true)]));
    const encode = Schema.encodeSync(Schema.Array(OrchestrationShellStreamItem));
    const decode = Schema.decodeUnknownSync(Schema.Array(OrchestrationShellStreamItem));
    const items = flatten(messages);
    assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(items)))), items);
  });

  it("produces stub items the wire schema accepts", () => {
    const messages = pageShellSnapshot(stubbedSnapshotOf([thread("a", false)], [stub("x")]));
    const encode = Schema.encodeSync(Schema.Array(OrchestrationShellStreamItem));
    const decode = Schema.decodeUnknownSync(Schema.Array(OrchestrationShellStreamItem));
    const items = flatten(messages);
    assert.deepEqual(decode(JSON.parse(JSON.stringify(encode(items)))), items);
  });
});
