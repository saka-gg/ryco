/**
 * A narrow orchestration engine double for the Trash purge and retirement tests: an in-memory
 * read model with the decider's lifecycle rules for the commands they dispatch, command receipts,
 * the `admit` hook, and published domain events.
 */
import {
  CommandId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationReadModel,
  ProjectId,
  ThreadId,
  WorktreeId,
} from "@ryco/contracts";
import { Clock, Effect, PubSub } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import Migration0089 from "../../persistence/Migrations/089_RetireThreadTrash.ts";
import { OrchestrationCommandInvariantError } from "../Errors.ts";
import type { OrchestrationEngineShape } from "../Services/OrchestrationEngine.ts";

export const projectId = ProjectId.make("project-purge");
export const removedProjectId = ProjectId.make("project-removed");

export interface FakeThread {
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly deletedAt: string | null;
  readonly trashedAt: string | null;
  readonly archivedAt: string | null;
  readonly worktreeId: WorktreeId | null;
  readonly worktreePath: string | null;
}

export interface FakeWorktree {
  readonly worktreeId: WorktreeId;
  readonly projectId: ProjectId;
  readonly origin: "main" | "managed";
  readonly worktreePath: string | null;
  readonly checkoutRemovalReason: "removed" | "missing" | "deleted" | null;
}

export const iso = (ms: number) => new Date(ms).toISOString();

export const thread = (id: string, fields: Partial<FakeThread> = {}): FakeThread => ({
  id: ThreadId.make(id),
  projectId,
  deletedAt: null,
  trashedAt: null,
  archivedAt: null,
  worktreeId: null,
  worktreePath: null,
  ...fields,
});

export const trashedAt = (ms: number): Partial<FakeThread> => ({
  deletedAt: iso(ms),
  trashedAt: iso(ms),
});

export const worktree = (id: string, fields: Partial<FakeWorktree> = {}): FakeWorktree => ({
  worktreeId: WorktreeId.make(id),
  projectId,
  origin: "managed",
  worktreePath: `/worktrees/${id}`,
  checkoutRemovalReason: "deleted",
  ...fields,
});

export const createMarkerTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`DROP TABLE IF EXISTS lifecycle_markers`;
  yield* Migration0089;
});

export const writeMarker = (value: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* sql`INSERT INTO lifecycle_markers (key, value) VALUES ('trash_retired_at', ${value})`;
  });

export const makeFakeEngine = (initial: {
  readonly threads?: ReadonlyArray<FakeThread>;
  readonly worktrees?: ReadonlyArray<FakeWorktree>;
}) =>
  Effect.gen(function* () {
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    let model = {
      snapshotSequence: 0,
      projects: [
        { id: projectId, deletedAt: null },
        { id: removedProjectId, deletedAt: iso(0) },
      ],
      threads: [...(initial.threads ?? [])],
      worktrees: [...(initial.worktrees ?? [])],
    } as unknown as OrchestrationReadModel;
    const accepted = new Map<string, number>();
    const applied: Array<OrchestrationCommand> = [];
    /** Commands the decider double refused: each would leave a rejected receipt. */
    const rejected: Array<OrchestrationCommand> = [];
    let sequence = 0;

    const threadsOf = () => model.threads as unknown as ReadonlyArray<FakeThread>;
    const findThread = (id: ThreadId) => threadsOf().find((candidate) => candidate.id === id);
    // A new array on every change: the thread index is cached per array.
    const updateThread = (id: ThreadId, fields: Partial<FakeThread>) => {
      const threads = [...threadsOf()];
      const index = threads.findIndex((candidate) => candidate.id === id);
      if (index >= 0) threads[index] = Object.assign({}, threads[index], fields);
      model = { ...model, threads } as unknown as OrchestrationReadModel;
    };
    const reject = (command: OrchestrationCommand, detail: string) =>
      Effect.sync(() => rejected.push(command)).pipe(
        Effect.andThen(
          Effect.fail(
            new OrchestrationCommandInvariantError({ commandType: command.type, detail }),
          ),
        ),
      );
    const publish = (type: string, payload: Record<string, unknown>) => {
      sequence += 1;
      model = { ...model, snapshotSequence: sequence };
      return PubSub.publish(events, {
        sequence,
        type,
        aggregateKind: "thread",
        aggregateId: "aggregate",
        payload,
      } as unknown as OrchestrationEvent).pipe(Effect.as(sequence));
    };

    const apply = (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        const now = iso(yield* Clock.currentTimeMillis);
        switch (command.type) {
          case "thread.trash": {
            const current = findThread(command.threadId);
            if (current?.deletedAt !== null) return yield* reject(command, "not live");
            updateThread(command.threadId, { deletedAt: now, trashedAt: now });
            return yield* publish("thread.trashed", {
              threadId: command.threadId,
              trashedAt: now,
              updatedAt: now,
            });
          }
          case "thread.untrash": {
            const current = findThread(command.threadId);
            if (current?.trashedAt == null) return yield* reject(command, "not in Trash");
            const project = model.projects.find((p) => p.id === current.projectId);
            if (project?.deletedAt !== null) return yield* reject(command, "project removed");
            updateThread(command.threadId, { deletedAt: null, trashedAt: null });
            return yield* publish("thread.untrashed", { threadId: command.threadId });
          }
          case "thread.archive": {
            const current = findThread(command.threadId);
            if (current === undefined || current.archivedAt !== null) {
              return yield* reject(command, "already archived");
            }
            updateThread(command.threadId, { archivedAt: now });
            return yield* publish("thread.archived", { threadId: command.threadId });
          }
          case "thread.delete": {
            const current = findThread(command.threadId);
            if (current?.trashedAt == null) return yield* reject(command, "not in Trash");
            updateThread(command.threadId, { deletedAt: now, trashedAt: null });
            return yield* publish("thread.deleted", { threadId: command.threadId, deletedAt: now });
          }
          case "worktree.delete": {
            model = {
              ...model,
              worktrees: (model.worktrees ?? []).filter(
                (candidate) => candidate.worktreeId !== command.worktreeId,
              ),
            };
            return yield* publish("worktree.deleted", { worktreeId: command.worktreeId });
          }
          default:
            return yield* reject(command, "unsupported by the fake engine");
        }
      });

    const dispatch = (
      command: OrchestrationCommand,
      options?: Parameters<OrchestrationEngineShape["dispatch"]>[1],
    ) =>
      Effect.suspend(() => {
        const receipt = accepted.get(command.commandId);
        if (receipt !== undefined) return Effect.succeed({ sequence: receipt });
        const commit = apply(command).pipe(
          Effect.tap((resultSequence) =>
            Effect.sync(() => {
              accepted.set(command.commandId, resultSequence);
              applied.push(command);
            }),
          ),
          Effect.map((resultSequence) => ({ sequence: resultSequence })),
        );
        return options?.admit ? options.admit(commit) : commit;
      });

    const engine = {
      getReadModel: () => Effect.sync(() => model),
      dispatch,
      subscribeDomainEvents: PubSub.subscribe(events),
    } as unknown as OrchestrationEngineShape;

    return {
      engine,
      applied,
      rejected,
      thread: (id: string) => findThread(ThreadId.make(id)),
      worktreeIds: () => (model.worktrees ?? []).map((candidate) => candidate.worktreeId as string),
      userCommand: (type: "thread.trash" | "thread.untrash", id: string) =>
        dispatch({
          type,
          commandId: CommandId.make(`user:${type}:${id}:${sequence}`),
          threadId: ThreadId.make(id),
        }),
    };
  });

/** Lets forked fibers (and SQLite I/O) run without advancing the test clock. */
export const settle = Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, 5)));
