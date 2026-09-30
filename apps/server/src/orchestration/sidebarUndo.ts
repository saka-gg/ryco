import { canSettleThread } from "@ryco/shared/threadSettlement";
import { canSnoozeThread } from "@ryco/shared/threadSnooze";
import { threadSettlementInput } from "./threadSettlementInput.ts";
import { findThreadWorktree } from "./commandInvariants.ts";
import type {
  CommandId,
  OrchestrationCommand,
  OrchestrationEvent,
  OrchestrationReadModel,
} from "@ryco/contracts";

type Thread = OrchestrationReadModel["threads"][number];
type Receipt = {
  before: Pick<
    Thread,
    "updatedAt" | "settledOverride" | "settledAt" | "snoozedUntil" | "snoozedAt"
  >;
  threadId: Thread["id"];
  after: WeakRef<Thread>;
  restoredUpdatedAt: string;
  project: OrchestrationReadModel["projects"][number] | undefined;
  worktree: NonNullable<OrchestrationReadModel["worktrees"]>[number] | undefined;
  type: "thread.archive" | "thread.settle" | "thread.snooze";
  expiresAt: number;
};

// These commands are provider/internal-only. Client actions always invalidate the prior receipt.
function isProviderProgress(command: OrchestrationCommand) {
  return (
    command.type === "thread.message.assistant.delta" ||
    command.type === "thread.message.assistant.complete" ||
    command.type === "thread.activity.append" ||
    command.type === "thread.turn.diff.complete" ||
    command.type === "thread.proposed-plan.upsert"
  );
}
function sameSidebarState(before: Thread, after: Thread) {
  return (
    before.archivedAt === after.archivedAt &&
    before.deletedAt === after.deletedAt &&
    before.projectId === after.projectId &&
    before.worktreeId === after.worktreeId &&
    before.worktreePath === after.worktreePath &&
    before.manualPosition === after.manualPosition &&
    before.settledOverride === after.settledOverride &&
    before.settledAt === after.settledAt &&
    before.snoozedUntil === after.snoozedUntil &&
    before.snoozedAt === after.snoozedAt
  );
}

/** Owned by the serialized command engine. Nothing survives a server restart. */
export function createSidebarUndoReceipts(now = Date.now) {
  const receipts = new Map<CommandId, Receipt>();
  const receiptByThread = new Map<Thread["id"], CommandId>();
  const remove = (id: CommandId) => {
    const receipt = receipts.get(id);
    if (receipt && receiptByThread.get(receipt.threadId) === id)
      receiptByThread.delete(receipt.threadId);
    receipts.delete(id);
  };
  const prune = () => {
    for (const [id, receipt] of receipts) {
      if (receipt.expiresAt <= now()) remove(id);
    }
  };
  return {
    record(
      command: OrchestrationCommand,
      before: OrchestrationReadModel,
      after: OrchestrationReadModel,
    ) {
      prune();
      if ("threadId" in command) {
        const receiptId = receiptByThread.get(command.threadId);
        const receipt = receiptId ? receipts.get(receiptId) : undefined;
        if (receipt && receiptId) {
          const previous = before.threads.find((thread) => thread.id === command.threadId);
          const current = after.threads.find((thread) => thread.id === command.threadId);
          if (
            isProviderProgress(command) &&
            previous &&
            current &&
            receipt.after.deref() === previous &&
            sameSidebarState(previous, current)
          ) {
            // Advance the conditional revision for safe provider progress, keeping its timestamp.
            receipt.after = new WeakRef(current);
            if (previous !== current) receipt.restoredUpdatedAt = current.updatedAt;
          } else remove(receiptId);
        }
      }
      if (
        command.type !== "thread.archive" &&
        command.type !== "thread.settle" &&
        command.type !== "thread.snooze"
      )
        return;
      const previous = before.threads.find((thread) => thread.id === command.threadId);
      const current = after.threads.find((thread) => thread.id === command.threadId);
      if (!previous || !current || previous === current) return;
      receipts.set(command.commandId, {
        before: {
          updatedAt: previous.updatedAt,
          settledOverride: previous.settledOverride,
          settledAt: previous.settledAt,
          snoozedUntil: previous.snoozedUntil ?? null,
          snoozedAt: previous.snoozedAt ?? null,
        },
        threadId: current.id,
        after: new WeakRef(current),
        restoredUpdatedAt: previous.updatedAt,
        project: after.projects.find((project) => project.id === current.projectId),
        worktree: findThreadWorktree(after, current),
        type: command.type,
        expiresAt: now() + 30_000,
      });
      receiptByThread.set(current.id, command.commandId);
      while (receipts.size > 256) remove(receipts.keys().next().value!);
    },
    restore(
      command: Extract<OrchestrationCommand, { type: "thread.sidebar.undo" }>,
      model: OrchestrationReadModel,
    ): Omit<OrchestrationEvent, "sequence"> | null {
      prune();
      const receipt = receipts.get(command.undoCommandId);
      // Object identity is an engine-local revision: even ABA changes in the same millisecond
      // replace the projection. Unrelated thread updates do not invalidate this receipt.
      const after = receipt?.after.deref();
      if (
        !receipt ||
        !after ||
        after.id !== command.threadId ||
        model.threads.find((thread) => thread.id === command.threadId) !== after ||
        model.projects.find((project) => project.id === after.projectId) !== receipt.project ||
        findThreadWorktree(model, after) !== receipt.worktree
      )
        return null;
      const occurredAt = new Date(now()).toISOString();
      // Provider progress may keep a receipt current, but it cannot restore a
      // hidden/settled state after new requests, queued work or goal authority.
      const restoresSettled = receipt.before.settledOverride === "settled";
      const restoresSnooze = Date.parse(receipt.before.snoozedUntil ?? "") > now();
      if (receipt.type !== "thread.archive" && (restoresSettled || restoresSnooze)) {
        const eligibility = threadSettlementInput(model, after, occurredAt);
        if (
          after.goal?.status === "active" ||
          after.goal?.synchronization?.state === "pending" ||
          (restoresSettled && !canSettleThread(eligibility).canSettle) ||
          (restoresSnooze && !canSnoozeThread(eligibility).canSnooze)
        )
          return null;
      }
      const base = {
        eventId: crypto.randomUUID() as OrchestrationEvent["eventId"],
        aggregateKind: "thread" as const,
        aggregateId: command.threadId,
        occurredAt,
        commandId: command.commandId,
        correlationId: command.commandId,
        causationEventId: null,
        metadata: {},
      };
      const payload = { threadId: command.threadId, updatedAt: receipt.restoredUpdatedAt };
      if (receipt.type === "thread.archive") return { ...base, type: "thread.unarchived", payload };
      const restoredSidebarState = {
        settledOverride: receipt.before.settledOverride,
        settledAt: receipt.before.settledAt,
        snoozedUntil: receipt.before.snoozedUntil ?? null,
        snoozedAt: receipt.before.snoozedAt ?? null,
      };
      return receipt.type === "thread.settle"
        ? {
            ...base,
            type: "thread.unsettled",
            payload: { ...payload, reason: "user", restoredSidebarState },
          }
        : { ...base, type: "thread.unsnoozed", payload: { ...payload, restoredSidebarState } };
    },
    consume(commandId: CommandId) {
      remove(commandId);
    },
  };
}
