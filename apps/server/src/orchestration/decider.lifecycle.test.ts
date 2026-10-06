import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorktreeId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@ryco/contracts";
import { Effect } from "effect";
import { describe, expect, it } from "vite-plus/test";

import { decideOrchestrationCommand } from "./decider.ts";
import { createEmptyReadModel, projectEvent } from "./projector.ts";

const NOW = "2026-10-01T00:00:00.000Z";
const projectId = ProjectId.make("project-lifecycle");
const threadId = ThreadId.make("thread-lifecycle");
const worktreeId = WorktreeId.make("worktree-lifecycle");

let sequence = 0;
const event = (
  input: Pick<OrchestrationEvent, "type" | "payload" | "aggregateKind" | "aggregateId">,
): OrchestrationEvent =>
  ({
    ...input,
    sequence: ++sequence,
    eventId: EventId.make(`evt-${sequence}`),
    occurredAt: NOW,
    commandId: CommandId.make(`cmd-${sequence}`),
    causationEventId: null,
    correlationId: CommandId.make(`cmd-${sequence}`),
    metadata: {},
  }) as OrchestrationEvent;

async function apply(model: OrchestrationReadModel, events: ReadonlyArray<OrchestrationEvent>) {
  let next = model;
  for (const entry of events) next = await Effect.runPromise(projectEvent(next, entry));
  return next;
}

async function decide(model: OrchestrationReadModel, command: OrchestrationCommand) {
  const decided = await Effect.runPromise(
    decideOrchestrationCommand({ command, readModel: model }),
  );
  const events = Array.isArray(decided) ? decided : [decided];
  return {
    events,
    model: await apply(
      model,
      events.map(
        (planned) => Object.assign({}, planned, { sequence: ++sequence }) as OrchestrationEvent,
      ),
    ),
  };
}

const reject = (model: OrchestrationReadModel, command: OrchestrationCommand) =>
  Effect.runPromise(decideOrchestrationCommand({ command, readModel: model }));

/** A project, a worktree record and one used conversation inside it. */
async function seed(): Promise<OrchestrationReadModel> {
  return apply(createEmptyReadModel(NOW), [
    event({
      type: "project.created",
      aggregateKind: "project",
      aggregateId: projectId,
      payload: {
        projectId,
        title: "Lifecycle",
        workspaceRoot: "/tmp/lifecycle",
        defaultModelSelection: null,
        scripts: [],
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    event({
      type: "worktree.created",
      aggregateKind: "worktree",
      aggregateId: worktreeId,
      payload: {
        worktreeId,
        projectId,
        branch: "feature/lifecycle",
        worktreePath: "/tmp/lifecycle-worktree",
        origin: "branch",
        prNumber: null,
        issueNumber: null,
        prTitle: null,
        issueTitle: null,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    event({
      type: "thread.created",
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: {
        threadId,
        projectId,
        title: "Fix the login flow",
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
        interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
        runtimeMode: "approval-required",
        branch: "feature/lifecycle",
        worktreePath: "/tmp/lifecycle-worktree",
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
    event({
      type: "thread.attachedToWorktree",
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: { threadId, worktreeId, attachedAt: NOW },
    }),
    event({
      type: "thread.message-sent",
      aggregateKind: "thread",
      aggregateId: threadId,
      payload: {
        threadId,
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Please fix the login flow",
        turnId: null,
        streaming: false,
        createdAt: NOW,
        updatedAt: NOW,
      },
    }),
  ]);
}

const thread = (model: OrchestrationReadModel) => model.threads.find((t) => t.id === threadId)!;
const cmd = (suffix: string) => CommandId.make(`lifecycle-${suffix}`);

describe("conversation lifecycle transitions", () => {
  it("interrupting a turn and stopping a session never change history or visibility", async () => {
    const model = await seed();
    const interrupted = await decide(model, {
      type: "thread.turn.interrupt",
      commandId: cmd("interrupt"),
      threadId,
      createdAt: NOW,
    });
    const stopped = await decide(model, {
      type: "thread.session.stop",
      commandId: cmd("stop"),
      threadId,
      createdAt: NOW,
    });
    expect(interrupted.events.map((e) => e.type)).toEqual(["thread.turn-interrupt-requested"]);
    expect(stopped.events.map((e) => e.type)).toEqual(["thread.session-stop-requested"]);
    for (const next of [interrupted.model, stopped.model]) {
      expect(thread(next)).toMatchObject({ archivedAt: null, deletedAt: null });
      expect(thread(next).messages).toHaveLength(1);
    }
  });

  it("archives (hidden, kept) and moves to Trash (hidden, recoverable) as distinct states", async () => {
    const model = await seed();
    const archived = await decide(model, { type: "thread.archive", commandId: cmd("a"), threadId });
    expect(thread(archived.model).archivedAt).not.toBeNull();
    expect(thread(archived.model).deletedAt).toBeNull();

    const trashed = await decide(archived.model, {
      type: "thread.trash",
      commandId: cmd("t"),
      threadId,
    });
    expect(trashed.events.map((e) => e.type)).toEqual(["thread.trashed"]);
    expect(thread(trashed.model).trashedAt).not.toBeNull();
    expect(thread(trashed.model).deletedAt).not.toBeNull();
    // Trash preserves the archive state and the conversation itself.
    expect(thread(trashed.model).archivedAt).toBe(thread(archived.model).archivedAt);
    expect(thread(trashed.model).messages).toHaveLength(1);
    await expect(
      reject(trashed.model, { type: "thread.trash", commandId: cmd("t2"), threadId }),
    ).rejects.toThrow("already in Trash");
    await expect(
      reject(trashed.model, { type: "thread.unarchive", commandId: cmd("u"), threadId }),
    ).rejects.toThrow("restore it first");

    const restored = await decide(trashed.model, {
      type: "thread.untrash",
      commandId: cmd("r"),
      threadId,
    });
    expect(restored.events.map((e) => e.type)).toEqual(["thread.untrashed"]);
    expect(thread(restored.model)).toMatchObject({
      deletedAt: null,
      trashedAt: null,
      archivedAt: thread(archived.model).archivedAt,
    });
  });

  it("deletes permanently only from Trash, as a separate step", async () => {
    const model = await seed();
    await expect(
      reject(model, { type: "thread.delete", commandId: cmd("d0"), threadId }),
    ).rejects.toThrow("must be moved to Trash");
    const trashed = await decide(model, { type: "thread.trash", commandId: cmd("t"), threadId });
    const deleted = await decide(trashed.model, {
      type: "thread.delete",
      commandId: cmd("d"),
      threadId,
    });
    expect(deleted.events.map((e) => e.type)).toEqual(["thread.deleted"]);
    expect(thread(deleted.model).trashedAt).toBeNull();
    expect(thread(deleted.model).deletedAt).not.toBeNull();
    await expect(
      reject(deleted.model, { type: "thread.untrash", commandId: cmd("r"), threadId }),
    ).rejects.toThrow("not in Trash");
    await expect(
      reject(deleted.model, { type: "thread.delete", commandId: cmd("d2"), threadId }),
    ).rejects.toThrow("already deleted permanently");
  });

  it("a trashed id is not free; a permanently deleted id may be created again", async () => {
    const model = await seed();
    const create = {
      type: "thread.create",
      commandId: cmd("create"),
      threadId,
      projectId,
      title: "Recreated",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "approval-required",
      interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
      branch: null,
      worktreePath: null,
      createdAt: NOW,
    } satisfies OrchestrationCommand;
    const trashed = await decide(model, { type: "thread.trash", commandId: cmd("t"), threadId });
    await expect(reject(trashed.model, create)).rejects.toThrow("cannot be created twice");
    const deleted = await decide(trashed.model, {
      type: "thread.delete",
      commandId: cmd("d"),
      threadId,
    });
    const recreated = await decide(deleted.model, create);
    expect(recreated.events.map((e) => e.type)).toEqual(["thread.created"]);
  });

  it("replays legacy deletions as permanent: nothing is offered as recoverable", async () => {
    const model = await seed();
    const replayed = await apply(model, [
      event({
        type: "thread.deleted",
        aggregateKind: "thread",
        aggregateId: threadId,
        payload: { threadId, deletedAt: NOW },
      }),
    ]);
    expect(thread(replayed).deletedAt).toBe(NOW);
    expect(thread(replayed).trashedAt ?? null).toBeNull();
    await expect(
      reject(replayed, { type: "thread.untrash", commandId: cmd("r"), threadId }),
    ).rejects.toThrow("not in Trash");
  });
});

describe("resuming without a checkout", () => {
  const turnStart = {
    type: "thread.turn.start",
    commandId: cmd("turn"),
    threadId,
    message: {
      messageId: MessageId.make("message-2"),
      role: "user",
      text: "continue",
      attachments: [],
    },
    runtimeMode: "approval-required",
    interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
    createdAt: NOW,
  } satisfies OrchestrationCommand;

  it("refuses new work in Trash and after checkout removal instead of running in main", async () => {
    const model = await seed();
    const trashed = await decide(model, { type: "thread.trash", commandId: cmd("t"), threadId });
    await expect(reject(trashed.model, turnStart)).rejects.toThrow("in Trash");

    const removed = await decide(model, {
      type: "worktree.checkout.remove",
      commandId: cmd("remove"),
      worktreeId,
      reason: "removed",
      removedAt: NOW,
    });
    expect(removed.events.map((e) => e.type)).toEqual([
      "worktree.checkoutRemoved",
      "worktree.archived",
    ]);
    // History and provenance stay readable on the thread.
    expect(thread(removed.model)).toMatchObject({
      worktreeId,
      worktreePath: "/tmp/lifecycle-worktree",
      branch: "feature/lifecycle",
      deletedAt: null,
    });
    await expect(reject(removed.model, turnStart)).rejects.toThrow("checkout");
    await expect(
      reject(removed.model, {
        type: "worktree.checkout.remove",
        commandId: cmd("remove-again"),
        worktreeId,
        reason: "removed",
        removedAt: NOW,
      }),
    ).rejects.toThrow("already records");

    const recreated = await decide(removed.model, {
      type: "worktree.checkout.restore",
      commandId: cmd("restore"),
      worktreeId,
      worktreePath: "/tmp/lifecycle-worktree",
      restoredAt: NOW,
    });
    expect(
      recreated.model.worktrees?.find((w) => w.worktreeId === worktreeId)?.checkoutRemovedAt,
    ).toBeNull();
    const resumed = await decide(recreated.model, turnStart);
    expect(resumed.events.some((e) => e.type === "thread.turn-start-requested")).toBe(true);

    // Explicitly choosing another checkout (here: the project root) also resumes.
    const repointed = await decide(removed.model, {
      type: "thread.meta.update",
      commandId: cmd("repoint"),
      threadId,
      worktreePath: null,
    });
    const elsewhere = await decide(repointed.model, turnStart);
    expect(elsewhere.events.some((e) => e.type === "thread.turn-start-requested")).toBe(true);
  });

  it("never treats the main checkout as removable or archivable", async () => {
    const model = await seed();
    const mainId = WorktreeId.make("worktree-main");
    const withMain = await apply(model, [
      event({
        type: "worktree.created",
        aggregateKind: "worktree",
        aggregateId: mainId,
        payload: {
          worktreeId: mainId,
          projectId,
          branch: "main",
          worktreePath: null,
          origin: "main",
          prNumber: null,
          issueNumber: null,
          prTitle: null,
          issueTitle: null,
          createdAt: NOW,
          updatedAt: NOW,
        },
      }),
    ]);
    await expect(
      reject(withMain, {
        type: "worktree.checkout.remove",
        commandId: cmd("main-remove"),
        worktreeId: mainId,
        reason: "removed",
        removedAt: NOW,
      }),
    ).rejects.toThrow("never a removable workspace");
    await expect(
      reject(withMain, {
        type: "worktree.archive",
        commandId: cmd("main-archive"),
        worktreeId: mainId,
        archivedAt: NOW,
        deletedBranch: false,
      }),
    ).rejects.toThrow("main workspace cannot be archived");
  });
});
