import {
  ORCHESTRATION_WS_METHODS,
  OrchestrationShellStreamWireItem,
  ProjectId,
  ThreadId,
  type OrchestrationArchivedThreadStub,
  type OrchestrationShellStreamItem,
  type OrchestrationShellSubscriptionItem,
  type OrchestrationThreadShell,
} from "@ryco/contracts";
import { isUnknownUnionMember } from "@ryco/contracts/base-schemas";
import * as Schema from "effect/Schema";
import { Stream } from "effect";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("./wsTransport.ts", () => ({
  WsTransport: class WsTransport {
    readonly mocked = true;
  },
}));

import { createShellSnapshotAssembler } from "./shellSnapshotAssembly.ts";
import { createWsRpcClient } from "./wsRpcClient.ts";
import type { WsTransport } from "./wsTransport.ts";

const now = "2026-10-12T00:00:00.000Z";
const thread = (id: string, archivedAt: string | null = null): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-1"),
  title: id,
  modelSelection: {
    instanceId: "codex",
    model: "fixture",
  } as OrchestrationThreadShell["modelSelection"],
  runtimeMode: "approval-required",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  goal: null,
  createdAt: now,
  updatedAt: now,
  archivedAt,
  settledOverride: null,
  settledAt: null,
  session: null,
  latestUserMessageAt: null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
});

const stub = (id: string): OrchestrationArchivedThreadStub => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project-1"),
  title: id,
  branch: null,
  worktreePath: null,
  worktreeId: null,
  createdAt: now,
  updatedAt: now,
  archivedAt: now,
  latestUserMessageAt: null,
  lineage: null,
});

const begin = (threadCount: number, archivedThreadCount = 0): OrchestrationShellStreamItem => ({
  kind: "snapshot-begin",
  snapshotSequence: 9,
  updatedAt: now,
  projects: [],
  worktrees: [],
  threadCount,
  archivedThreadCount,
});
const removed = (sequence: number): OrchestrationShellStreamItem => ({
  kind: "thread-removed",
  sequence,
  threadId: ThreadId.make("gone"),
});

/** The snapshot an `accept` delivered, if it delivered one. */
const snapshotOf = (delivered: OrchestrationShellSubscriptionItem | null) =>
  delivered !== null && !isUnknownUnionMember(delivered) && delivered.kind === "snapshot"
    ? delivered.snapshot
    : undefined;

describe("createShellSnapshotAssembler", () => {
  it("reassembles pages into one snapshot item in order", () => {
    const assembler = createShellSnapshotAssembler();
    const delivered = [
      begin(3, 1),
      { kind: "snapshot-threads", threads: [thread("a"), thread("b")] },
      { kind: "snapshot-threads", threads: [thread("x", now)] },
      { kind: "snapshot-end" },
    ].flatMap((item) => assembler.accept(item as OrchestrationShellStreamItem) ?? []);

    expect(delivered).toEqual([
      {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 9,
          projects: [],
          worktrees: [],
          threads: [thread("a"), thread("b"), thread("x", now)],
          updatedAt: now,
        },
      },
    ]);
  });

  it("keeps the node's settlement policy from the header", () => {
    const assembler = createShellSnapshotAssembler();
    assembler.accept({
      ...begin(0),
      settlementPolicy: { autoSettleAfterDays: null },
    } as OrchestrationShellStreamItem);
    const delivered = assembler.accept({ kind: "snapshot-end" });
    expect(snapshotOf(delivered)?.settlementPolicy).toEqual({ autoSettleAfterDays: null });
  });

  it("passes a legacy snapshot and other items through unchanged", () => {
    const assembler = createShellSnapshotAssembler();
    const legacy: OrchestrationShellStreamItem = {
      kind: "snapshot",
      snapshot: { snapshotSequence: 1, projects: [], threads: [thread("a")], updatedAt: now },
    };
    expect(assembler.accept(legacy)).toBe(legacy);
    expect(assembler.accept(removed(2))).toEqual(removed(2));
  });

  it("delivers events that arrive between pages as they arrive", () => {
    const assembler = createShellSnapshotAssembler();
    expect(assembler.accept(begin(1))).toBeNull();
    expect(assembler.accept(removed(10))).toEqual(removed(10));
    expect(assembler.accept({ kind: "snapshot-threads", threads: [thread("a")] })).toBeNull();
    expect(assembler.accept({ kind: "snapshot-end" })).toMatchObject({ kind: "snapshot" });
  });

  it("passes a kind a newer node added through without breaking the snapshot around it", () => {
    const assembler = createShellSnapshotAssembler();
    const [unknown] = Schema.decodeUnknownSync(
      Schema.toCodecJson(Schema.NonEmptyArray(OrchestrationShellStreamWireItem)),
    )([{ kind: "thread-teleported", sequence: 11, threadId: "thread-a" }]);
    expect(assembler.accept(begin(1))).toBeNull();
    expect(assembler.accept(unknown!)).toBe(unknown);
    expect(assembler.accept({ kind: "snapshot-threads", threads: [thread("a")] })).toBeNull();
    expect(snapshotOf(assembler.accept({ kind: "snapshot-end" }))?.threads).toEqual([thread("a")]);
  });

  it("never completes a snapshot from pages of an earlier attempt", () => {
    const assembler = createShellSnapshotAssembler();
    assembler.accept(begin(2));
    assembler.accept({ kind: "snapshot-threads", threads: [thread("stale")] });
    assembler.reset();
    expect(assembler.accept({ kind: "snapshot-threads", threads: [thread("orphan")] })).toBeNull();
    expect(assembler.accept({ kind: "snapshot-end" })).toBeNull();
  });

  it("lets a new header supersede an unfinished snapshot", () => {
    const assembler = createShellSnapshotAssembler();
    assembler.accept(begin(2));
    assembler.accept({ kind: "snapshot-threads", threads: [thread("old")] });
    assembler.accept(begin(1));
    assembler.accept({ kind: "snapshot-threads", threads: [thread("new")] });
    const snapshot = assembler.accept({ kind: "snapshot-end" });
    expect(snapshotOf(snapshot)?.threads.map((t) => t.id)).toEqual(["new"]);
  });

  it("assembles archived stub pages into the snapshot's stubs, counted with the shells", () => {
    const onIncomplete = vi.fn();
    const assembler = createShellSnapshotAssembler(onIncomplete);
    const delivered = [
      begin(4, 2),
      { kind: "snapshot-threads", threads: [thread("a"), thread("b")] },
      { kind: "snapshot-archived-threads", threads: [stub("x")] },
      { kind: "snapshot-archived-threads", threads: [stub("y")] },
      { kind: "snapshot-end" },
    ].flatMap((item) => assembler.accept(item as OrchestrationShellStreamItem) ?? []);
    expect(delivered).toEqual([
      {
        kind: "snapshot",
        snapshot: {
          snapshotSequence: 9,
          projects: [],
          worktrees: [],
          threads: [thread("a"), thread("b")],
          archivedThreadStubs: [stub("x"), stub("y")],
          updatedAt: now,
        },
      },
    ]);
    expect(onIncomplete).not.toHaveBeenCalled();
  });

  it("leaves stubs out of a snapshot from a server that sent none (an older server)", () => {
    const assembler = createShellSnapshotAssembler();
    assembler.accept(begin(1, 1));
    assembler.accept({ kind: "snapshot-threads", threads: [thread("x", now)] });
    const delivered = snapshotOf(assembler.accept({ kind: "snapshot-end" }));
    expect(delivered).toBeDefined();
    expect(delivered).not.toHaveProperty("archivedThreadStubs");
  });

  it("never carries stubs of an unfinished snapshot into the next one", () => {
    const assembler = createShellSnapshotAssembler();
    assembler.accept(begin(1, 1));
    assembler.accept({ kind: "snapshot-archived-threads", threads: [stub("stale")] });
    assembler.accept(begin(1));
    assembler.accept({ kind: "snapshot-threads", threads: [thread("a")] });
    const delivered = snapshotOf(assembler.accept({ kind: "snapshot-end" }));
    expect(delivered).toBeDefined();
    expect(delivered).not.toHaveProperty("archivedThreadStubs");
  });

  it("reports a count mismatch but still delivers what arrived", () => {
    const onIncomplete = vi.fn();
    const assembler = createShellSnapshotAssembler(onIncomplete);
    assembler.accept(begin(2));
    assembler.accept({ kind: "snapshot-threads", threads: [thread("a")] });
    expect(assembler.accept({ kind: "snapshot-end" })).toMatchObject({ kind: "snapshot" });
    expect(onIncomplete).toHaveBeenCalledWith({ expected: 2, received: 1 });
  });
});

describe("wsRpcClient shell subscription", () => {
  type Connect = (client: unknown) => Stream.Stream<OrchestrationShellStreamItem>;
  const makeClient = () => {
    const connects: Array<Connect> = [];
    const listeners: Array<(value: OrchestrationShellStreamItem) => void> = [];
    const transport = {
      subscribe: vi.fn(
        (connect: Connect, listener: (value: OrchestrationShellStreamItem) => void) => {
          connects.push(connect);
          listeners.push(listener);
          return () => undefined;
        },
      ),
    };
    return {
      client: createWsRpcClient(transport as unknown as WsTransport),
      connect: () => {
        const input = vi.fn((_input: unknown) => Stream.empty);
        connects[0]!({ [ORCHESTRATION_WS_METHODS.subscribeShell]: input });
        return input.mock.calls[0]?.[0];
      },
      emit: (item: OrchestrationShellStreamItem) => listeners[0]!(item),
    };
  };

  it("asks for paged snapshots and keeps the other inputs", () => {
    const harness = makeClient();
    harness.client.orchestration.subscribeShell(() => undefined, {
      threadPriorities: "delta",
      resumeFromSequence: () => 4,
    });
    expect(harness.connect()).toEqual({
      resumeFromSequence: 4,
      threadPriorities: "delta",
      snapshotDelivery: "paged",
    });
  });

  it("asks for archived stubs only when the subscriber says it keeps them", () => {
    const harness = makeClient();
    harness.client.orchestration.subscribeShell(() => undefined, { archivedThreads: "stub" });
    expect(harness.connect()).toEqual({ snapshotDelivery: "paged", archivedThreads: "stub" });
    const plain = makeClient();
    plain.client.orchestration.subscribeShell(() => undefined);
    expect(plain.connect()).toEqual({ snapshotDelivery: "paged" });
  });

  it("delivers a paged snapshot (new server) as one snapshot item", () => {
    const harness = makeClient();
    const listener = vi.fn();
    harness.client.orchestration.subscribeShell(listener);
    harness.connect();
    harness.emit(begin(1));
    harness.emit({ kind: "snapshot-threads", threads: [thread("a")] });
    expect(listener).not.toHaveBeenCalled();
    harness.emit({ kind: "snapshot-end" });
    harness.emit(removed(10));
    expect(listener.mock.calls.map(([item]) => item.kind)).toEqual(["snapshot", "thread-removed"]);
  });

  it("delivers a single snapshot item (old server) unchanged", () => {
    const harness = makeClient();
    const listener = vi.fn();
    harness.client.orchestration.subscribeShell(listener);
    harness.connect();
    const legacy: OrchestrationShellStreamItem = {
      kind: "snapshot",
      snapshot: { snapshotSequence: 3, projects: [], threads: [thread("a")], updatedAt: now },
    };
    harness.emit(legacy);
    expect(listener).toHaveBeenCalledWith(legacy);
  });

  it("drops a half-received snapshot when the subscription restarts", () => {
    const harness = makeClient();
    const listener = vi.fn();
    harness.client.orchestration.subscribeShell(listener);
    harness.connect();
    harness.emit(begin(2));
    harness.emit({ kind: "snapshot-threads", threads: [thread("a")] });
    // The transport reconnects and opens a new stream.
    harness.connect();
    harness.emit({ kind: "snapshot-threads", threads: [thread("b")] });
    harness.emit({ kind: "snapshot-end" });
    expect(listener).not.toHaveBeenCalled();
  });
});
