import {
  CommandId,
  ThreadId,
  ProjectId,
  type OrchestrationCommand,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";
import { createSidebarUndoReceipts } from "./sidebarUndo.ts";

function fixture(id = "synthetic-thread") {
  const before = {
    id: ThreadId.make(id),
    projectId: ProjectId.make("synthetic-project"),
    worktreeId: null,
    worktreePath: null,
    archivedAt: null,
    deletedAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    createdAt: "2020-01-01T00:00:00.000Z",
    messages: [],
    activities: [],
    session: null,
    latestTurn: null,
    goal: null,
    updatedAt: "2020-01-01T00:00:00.000Z",
    settledOverride: null,
    settledAt: null,
  };
  const after = { ...before, settledOverride: "settled", settledAt: "2026-09-30T00:00:00.000Z" };
  const project = { id: before.projectId };
  const model = (thread: unknown): OrchestrationReadModel =>
    ({
      threads: [thread],
      projects: [project],
      worktrees: [],
    }) as unknown as OrchestrationReadModel;
  const command = {
    type: "thread.settle",
    threadId: before.id,
    commandId: CommandId.make(id),
  } satisfies OrchestrationCommand;
  const undo = {
    type: "thread.sidebar.undo",
    threadId: before.id,
    undoCommandId: command.commandId,
    commandId: CommandId.make("undo"),
  } as const;
  return { before, after, model, command, undo };
}
describe("sidebar undo receipt bounds and revisions", () => {
  it("expires at the exact server bound and a fresh engine has no receipts", () => {
    let time = 1_000;
    const receipts = createSidebarUndoReceipts(() => time);
    const f = fixture();
    receipts.record(f.command, f.model(f.before), f.model(f.after));
    time += 29_999;
    expect(receipts.restore(f.undo, f.model(f.after))).not.toBeNull();
    time++;
    expect(receipts.restore(f.undo, f.model(f.after))).toBeNull();
    expect(createSidebarUndoReceipts().restore(f.undo, f.model(f.after))).toBeNull();
  });
  it("refuses same-timestamp ABA revisions but permits unrelated thread changes", () => {
    const receipts = createSidebarUndoReceipts();
    const f = fixture();
    receipts.record(f.command, f.model(f.before), f.model(f.after));
    expect(
      receipts.restore(f.undo, {
        ...f.model(f.after),
        threads: [
          ...f.model(f.after).threads,
          fixture("unrelated").after as unknown as OrchestrationReadModel["threads"][number],
        ],
      }),
    ).not.toBeNull();
    expect(receipts.restore(f.undo, f.model({ ...f.after }))).toBeNull();
  });
  it("evicts old entries while preserving the newest 256 receipts", () => {
    const receipts = createSidebarUndoReceipts();
    const first = fixture("first");
    receipts.record(first.command, first.model(first.before), first.model(first.after));
    for (let i = 0; i < 256; i++) {
      const f = fixture(`thread-${i}`);
      receipts.record(f.command, f.model(f.before), f.model(f.after));
    }
    expect(receipts.restore(first.undo, first.model(first.after))).toBeNull();
  });
});

it.each([true, false])(
  "invalidates a changed or removed parent worktree (ID-backed: %s)",
  (idBacked) => {
    const receipts = createSidebarUndoReceipts();
    const f = fixture();
    const worktree = {
      worktreeId: "synthetic-worktree",
      projectId: f.before.projectId,
      worktreePath: "/synthetic/worktree",
    };
    const before = {
      ...f.before,
      worktreeId: idBacked ? worktree.worktreeId : null,
      worktreePath: worktree.worktreePath,
    };
    const after = { ...f.after, worktreeId: before.worktreeId, worktreePath: before.worktreePath };
    const model = (thread: unknown, trees: unknown[]) =>
      ({ ...f.model(thread), worktrees: trees }) as unknown as OrchestrationReadModel;
    receipts.record(f.command, model(before, [worktree]), model(after, [worktree]));
    expect(receipts.restore(f.undo, model(after, [worktree]))).not.toBeNull();
    expect(receipts.restore(f.undo, model(after, [{ ...worktree }]))).toBeNull();
    expect(receipts.restore(f.undo, model(after, []))).toBeNull();
  },
);

it("never lets provider progress advance a receipt through a lifecycle change", () => {
  const receipts = createSidebarUndoReceipts();
  const f = fixture();
  receipts.record(f.command, f.model(f.before), f.model(f.after));
  const next = { ...f.after, settledOverride: "active", settledAt: null };
  receipts.record(
    {
      type: "thread.activity.append",
      commandId: CommandId.make("progress"),
      threadId: f.before.id,
    } as OrchestrationCommand,
    f.model(f.after),
    f.model(next),
  );
  expect(receipts.restore(f.undo, f.model(next))).toBeNull();
});

// A provider event may advance a receipt while carrying a new pending request.
// Restoring the old settled/snoozed state still requires current eligibility.
it.each([
  { session: { status: "starting" } },
  { latestTurn: { state: "running" } },
  { goal: { status: "active" } },
  { goal: { status: "paused", synchronization: { state: "pending" } } },
  { activities: [{ kind: "approval.requested", payload: { requestId: "synthetic" } }] },
  { activities: [{ kind: "user-input.requested", payload: { requestId: "synthetic" } }] },
])("refuses restoring settled state over pending work: %j", (progress) => {
  const f = fixture();
  const receipts = createSidebarUndoReceipts();
  const before = { ...f.before, settledOverride: "settled", settledAt: "2020-01-01T00:00:00.000Z" };
  const after = {
    ...before,
    snoozedUntil: "2099-01-01T00:00:00.000Z",
    snoozedAt: "2026-01-01T00:00:00.000Z",
  };
  const command = {
    ...f.command,
    type: "thread.snooze",
    snoozedUntil: after.snoozedUntil,
  } as const;
  receipts.record(command, f.model(before), f.model(after));
  const next = { ...after, ...progress };
  receipts.record(
    {
      type: "thread.activity.append",
      commandId: CommandId.make("pending-progress"),
      threadId: f.before.id,
    } as OrchestrationCommand,
    f.model(after),
    f.model(next),
  );
  expect(receipts.restore(f.undo, f.model(next))).toBeNull();
});

it("allows Archive Undo on a settled thread because it only restores visibility", () => {
  const f = fixture();
  const receipts = createSidebarUndoReceipts();
  const before = { ...f.before, settledOverride: "settled", settledAt: "2020-01-01T00:00:00.000Z" };
  const after = { ...before, archivedAt: "2026-01-01T00:00:00.000Z" };
  receipts.record({ ...f.command, type: "thread.archive" }, f.model(before), f.model(after));
  expect(receipts.restore(f.undo, f.model(after))?.type).toBe("thread.unarchived");
});
