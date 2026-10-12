import {
  CheckpointRef,
  CommandId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RuntimeSessionId,
  ThreadForkKey,
  ThreadId,
  TurnId,
  WorktreeId,
} from "@ryco/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/sql/SqlClient";

import {
  threadForkIdentity,
  threadForkRequestDigest,
  type ThreadForkLedgerRow,
  type ThreadForkPlan,
} from "../../threadFork/forkLedger.ts";
import { ThreadForkRepository } from "../Services/ThreadForks.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ThreadForkRepositoryLive } from "./ThreadForks.ts";

const layer = it.layer(ThreadForkRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)));

const createdAt = "2026-10-11T00:00:00.000Z";
const sourceThreadId = ThreadId.make("thread-source");
const sourceMessageId = MessageId.make("assistant:reply-2");
const sourceTurnId = TurnId.make("turn-2");
const projectId = ProjectId.make("project-1");

function ledgerRow(key: string): ThreadForkLedgerRow {
  const forkKey = ThreadForkKey.make(key);
  const identity = threadForkIdentity(forkKey);
  const destination = { kind: "new-worktree", start: { kind: "checkpoint" } } as const;
  const checkout = {
    kind: "new-worktree",
    worktreeId: identity.worktreeId,
    worktreePath: "/worktrees/project/fork",
    branch: identity.branch("ryco"),
    start: "checkpoint",
    baseRef: "a".repeat(40),
  } as const;
  const forked = {
    schemaVersion: 1,
    sourceThreadId,
    sourceMessageId,
    sourceTurnId,
    sourceTitle: "Source",
    inheritedMessageCount: 1,
    providerContext: "native",
    checkout,
    notices: [],
  } as const;
  const plan: ThreadForkPlan = {
    schemaVersion: 1,
    forkThreadId: identity.forkThreadId,
    projectId,
    sourceProjectId: projectId,
    sourceThreadId,
    sourceMessageId,
    sourceTurnId,
    sourceTitle: "Source",
    destination,
    checkout: {
      kind: "new-worktree",
      worktreeId: identity.worktreeId,
      branch: identity.branch("ryco"),
      start: "checkpoint",
      baseRef: "a".repeat(40),
      repositoryRoot: "/project",
      baseCommit: "a".repeat(40),
      baseCommitRef: CheckpointRef.make("refs/ryco/forks/x/base"),
      checkpointCommit: "b".repeat(40),
      checkpointCommitRef: CheckpointRef.make("refs/ryco/forks/x/checkpoint"),
    },
    provider: {
      kind: "native",
      driver: "codex",
      instanceId: ProviderInstanceId.make("codex"),
      configFingerprint: "c".repeat(64),
      sourceNativeId: "codex-thread-1",
      recordedCwd: "/project",
      turnId: sourceTurnId,
      inheritedUserTurnCount: 2,
    },
    attachments: [],
    command: {
      type: "thread.fork.create",
      commandId: identity.commandId("publish"),
      threadId: identity.forkThreadId,
      projectId,
      title: "Source (fork)",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdAt,
      sourceThreadId,
      sourceMessageId,
      sourceTurnId,
      worktreeId: null,
      newWorktree: null,
      messages: [
        {
          id: MessageId.make(`${identity.forkThreadId}:inherited:assistant:reply-2`),
          role: "assistant",
          text: "Done 😀",
          turnId: sourceTurnId,
          streaming: false,
          createdAt,
          updatedAt: createdAt,
        },
      ],
      proposedPlans: [],
      activities: [],
      forked,
    },
    notices: [],
  };
  return {
    forkKey,
    requestDigest: threadForkRequestDigest({ sourceThreadId, sourceMessageId, destination }),
    forkThreadId: identity.forkThreadId,
    sourceThreadId,
    sourceMessageId,
    destinationKind: "new-worktree",
    phase: "accepted",
    plan,
    checkout: null,
    provider: null,
    attachments: null,
    result: null,
    error: null,
    createdAt,
    updatedAt: createdAt,
  };
}

layer("ThreadForkRepository", (it) => {
  it.effect("inserts once per key and round-trips the pinned plan", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadForkRepository;
      const row = ledgerRow("fork-key-roundtrip-0001");
      assert.isTrue(yield* repository.insertIfAbsent(row));
      assert.isFalse(yield* repository.insertIfAbsent({ ...row, requestDigest: "d".repeat(64) }));

      const stored = Option.getOrThrow(yield* repository.getByKey({ forkKey: row.forkKey }));
      assert.deepStrictEqual(stored, row);
      assert.strictEqual(stored.plan.command.messages[0]?.text, "Done 😀");
      assert.isTrue(
        Option.isNone(
          yield* repository.getByKey({ forkKey: ThreadForkKey.make("fork-key-missing-00001") }),
        ),
      );
    }),
  );

  it.effect("refuses a second key that derives the same fork thread id", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadForkRepository;
      const row = ledgerRow("fork-key-unique-thread-01");
      assert.isTrue(yield* repository.insertIfAbsent(row));
      assert.isFalse(
        yield* repository.insertIfAbsent({
          ...row,
          forkKey: ThreadForkKey.make("fork-key-unique-thread-02"),
        }),
      );
    }),
  );

  it.effect("advances phases with one compare-and-set winner and patches only given columns", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadForkRepository;
      const row = ledgerRow("fork-key-cas-000000001");
      yield* repository.insertIfAbsent(row);
      const checkout = {
        kind: "new-worktree",
        worktreeId: WorktreeId.make("worktree-fork-x"),
        branch: "ryco/fork-1234abcd",
        worktreePath: "/worktrees/project/fork",
      } as const;

      const claim = {
        forkKey: row.forkKey,
        expectedPhase: "accepted",
        nextPhase: "checkout-preparing",
        patch: { checkout },
        updatedAt: "2026-10-11T00:00:01.000Z",
      } as const;
      // The winner gets the row as written, without the (unchanged) plan.
      const claimed = Option.getOrThrow(yield* repository.compareAndSetPhase(claim));
      assert.strictEqual(claimed.phase, "checkout-preparing");
      assert.deepStrictEqual(claimed.checkout, checkout);
      assert.strictEqual(claimed.updatedAt, "2026-10-11T00:00:01.000Z");
      assert.isFalse("plan" in claimed);
      assert.isTrue(Option.isNone(yield* repository.compareAndSetPhase(claim)));

      assert.isTrue(
        Option.isSome(
          yield* repository.compareAndSetPhase({
            forkKey: row.forkKey,
            expectedPhase: "checkout-preparing",
            nextPhase: "provider-ready",
            patch: {
              provider: {
                kind: "native",
                driver: "codex",
                instanceId: ProviderInstanceId.make("codex"),
                nativeThreadId: "codex-fork-1",
                resumeCursor: { threadId: "codex-fork-1" },
                cwd: "/worktrees/project/fork",
                runtimeSessionId: RuntimeSessionId.make("fork-x"),
                ownedCopy: { kind: "codex-thread", threadId: "codex-fork-1" },
              },
              attachments: { attachmentIds: ["fork-x-11111111-1111-4111-8111-111111111111"] },
            },
            updatedAt: "2026-10-11T00:00:02.000Z",
          }),
        ),
      );
      const advanced = Option.getOrThrow(yield* repository.getByKey({ forkKey: row.forkKey }));
      assert.strictEqual(advanced.phase, "provider-ready");
      assert.deepStrictEqual(advanced.checkout, checkout);
      assert.deepStrictEqual(
        advanced.provider?.kind === "native" && advanced.provider.resumeCursor,
        {
          threadId: "codex-fork-1",
        },
      );
      assert.strictEqual(advanced.updatedAt, "2026-10-11T00:00:02.000Z");

      // `null` clears a column; omitted columns stay.
      assert.isTrue(
        Option.isSome(
          yield* repository.compareAndSetPhase({
            forkKey: row.forkKey,
            expectedPhase: "provider-ready",
            nextPhase: "failed",
            patch: {
              attachments: null,
              error: { reason: "preparation-failed", message: "Git failed.", retryable: true },
            },
            updatedAt: "2026-10-11T00:00:03.000Z",
          }),
        ),
      );
      const failed = Option.getOrThrow(yield* repository.getByKey({ forkKey: row.forkKey }));
      assert.strictEqual(failed.attachments, null);
      assert.deepStrictEqual(failed.checkout, checkout);
      assert.deepStrictEqual(failed.error, {
        reason: "preparation-failed",
        message: "Git failed.",
        retryable: true,
      });
    }),
  );

  it.effect("fences a transition that keeps the phase on the row version it read", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadForkRepository;
      const row = ledgerRow("fork-key-cas-version-0001");
      yield* repository.insertIfAbsent(row);
      const retryable = {
        reason: "preparation-failed",
        message: "Git failed.",
        retryable: true,
      } as const;
      yield* repository.compareAndSetPhase({
        forkKey: row.forkKey,
        expectedPhase: "accepted",
        nextPhase: "failed",
        patch: { error: retryable },
        updatedAt: "2026-10-11T00:00:01.000Z",
      });
      // A retry revives the row and fails it again: same phase, a new version.
      yield* repository.compareAndSetPhase({
        forkKey: row.forkKey,
        expectedPhase: "failed",
        expectedUpdatedAt: "2026-10-11T00:00:01.000Z",
        nextPhase: "accepted",
        patch: { error: null },
        updatedAt: "2026-10-11T00:00:02.000Z",
      });
      yield* repository.compareAndSetPhase({
        forkKey: row.forkKey,
        expectedPhase: "accepted",
        nextPhase: "failed",
        patch: { error: retryable },
        updatedAt: "2026-10-11T00:00:03.000Z",
      });

      // A writer that read the first failure misses, even though the phase still matches.
      const stale = yield* repository.compareAndSetPhase({
        forkKey: row.forkKey,
        expectedPhase: "failed",
        expectedUpdatedAt: "2026-10-11T00:00:01.000Z",
        nextPhase: "failed",
        patch: { error: { ...retryable, retryable: false } },
        releaseHistory: true,
        updatedAt: "2026-10-11T00:00:04.000Z",
      });
      assert.isTrue(Option.isNone(stale));
      const kept = Option.getOrThrow(yield* repository.getByKey({ forkKey: row.forkKey }));
      assert.deepStrictEqual(kept.error, retryable);
      assert.strictEqual(kept.updatedAt, "2026-10-11T00:00:03.000Z");
      assert.deepStrictEqual(kept.plan, row.plan);

      // The version it holds now matches.
      const current = yield* repository.compareAndSetPhase({
        forkKey: row.forkKey,
        expectedPhase: "failed",
        expectedUpdatedAt: "2026-10-11T00:00:03.000Z",
        nextPhase: "failed",
        patch: { error: { ...retryable, retryable: false } },
        updatedAt: "2026-10-11T00:00:05.000Z",
      });
      assert.strictEqual(Option.getOrThrow(current).error?.retryable, false);
    }),
  );

  it.effect("lists only unfinished forks, oldest first", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadForkRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_forks`;
      const older = ledgerRow("fork-key-list-0000000001");
      const newer = {
        ...ledgerRow("fork-key-list-0000000002"),
        createdAt: "2026-10-11T00:00:05.000Z",
      };
      const done = ledgerRow("fork-key-list-0000000003");
      yield* repository.insertIfAbsent(newer);
      yield* repository.insertIfAbsent(older);
      yield* repository.insertIfAbsent(done);
      yield* repository.compareAndSetPhase({
        forkKey: done.forkKey,
        expectedPhase: "accepted",
        nextPhase: "completed",
        patch: {
          result: {
            threadId: done.forkThreadId,
            projectId,
            replayed: false,
            providerContext: "handoff",
            checkout: { kind: "current-checkout", worktreePath: null, branch: null },
            notices: [],
          },
        },
        updatedAt: createdAt,
      });
      assert.deepStrictEqual(
        (yield* repository.listUnfinished()).map((row) => row.forkKey),
        [older.forkKey, newer.forkKey],
      );
      assert.deepStrictEqual(yield* repository.listUnfinishedKeys(), [
        { forkKey: older.forkKey, phase: "accepted", updatedAt: older.updatedAt },
        { forkKey: newer.forkKey, phase: "accepted", updatedAt: newer.updatedAt },
      ]);
    }),
  );

  it.effect("lists and answers unfinished keys without reading their plans", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadForkRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_forks`;
      const readable = ledgerRow("fork-key-lean-0000000001");
      const unreadable = {
        ...ledgerRow("fork-key-lean-0000000002"),
        createdAt: "2026-10-11T00:00:05.000Z",
      };
      yield* repository.insertIfAbsent(readable);
      yield* repository.insertIfAbsent(unreadable);
      // A plan this build cannot decode (e.g. written by a newer one).
      yield* sql`UPDATE thread_forks SET plan_json = '{"schemaVersion":99}'
        WHERE fork_key = ${unreadable.forkKey}`;

      assert.strictEqual(
        (yield* Effect.exit(repository.listUnfinished()))._tag,
        "Failure",
        "the full list decodes every plan",
      );
      assert.deepStrictEqual(
        (yield* repository.listUnfinishedKeys()).map((entry) => entry.forkKey),
        [readable.forkKey, unreadable.forkKey],
      );
      const state = Option.getOrThrow(
        yield* repository.getStateByKey({ forkKey: unreadable.forkKey }),
      );
      assert.strictEqual(state.phase, "accepted");
      assert.strictEqual("plan" in state, false);
      assert.isTrue(
        Option.isNone(
          yield* repository.getStateByKey({
            forkKey: ThreadForkKey.make("fork-key-lean-missing-01"),
          }),
        ),
      );
    }),
  );

  it.effect("drops a settled row's inherited history but keeps what a replay needs", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadForkRepository;
      const row = ledgerRow("fork-key-release-000001");
      yield* repository.insertIfAbsent(row);
      const result = {
        threadId: row.forkThreadId,
        projectId,
        replayed: false,
        providerContext: "native",
        checkout: { kind: "current-checkout", worktreePath: null, branch: null },
        notices: [],
      } as const;
      // An unsettled transition keeps the full plan.
      yield* repository.compareAndSetPhase({
        forkKey: row.forkKey,
        expectedPhase: "accepted",
        nextPhase: "published",
        patch: {},
        updatedAt: "2026-10-11T00:00:01.000Z",
      });
      const published = Option.getOrThrow(yield* repository.getByKey({ forkKey: row.forkKey }));
      assert.deepStrictEqual(published.plan, row.plan);

      const completed = yield* repository.compareAndSetPhase({
        forkKey: row.forkKey,
        expectedPhase: "published",
        nextPhase: "completed",
        patch: { result },
        releaseHistory: true,
        updatedAt: "2026-10-11T00:00:02.000Z",
      });
      assert.deepStrictEqual(Option.getOrThrow(completed).result, result);
      const stored = Option.getOrThrow(yield* repository.getByKey({ forkKey: row.forkKey }));
      assert.deepStrictEqual(stored.plan.command.messages, []);
      assert.deepStrictEqual(stored.plan.command.activities, []);
      assert.deepStrictEqual(stored.plan.command.proposedPlans, []);
      assert.deepStrictEqual(
        { ...stored.plan, command: { ...stored.plan.command, messages: [] } },
        {
          ...row.plan,
          command: { ...row.plan.command, messages: [], activities: [], proposedPlans: [] },
        },
      );
      assert.deepStrictEqual(stored.result, result);
      assert.strictEqual(stored.requestDigest, row.requestDigest);
    }),
  );

  it.effect("lists failed rows a client may still retry, by age", () =>
    Effect.gen(function* () {
      const repository = yield* ThreadForkRepository;
      const sql = yield* SqlClient.SqlClient;
      yield* sql`DELETE FROM thread_forks`;
      const fail = (key: string, retryable: boolean, updatedAt: string) =>
        Effect.gen(function* () {
          const row = ledgerRow(key);
          yield* repository.insertIfAbsent(row);
          yield* repository.compareAndSetPhase({
            forkKey: row.forkKey,
            expectedPhase: "accepted",
            nextPhase: "failed",
            patch: { error: { reason: "preparation-failed", message: "Git failed.", retryable } },
            updatedAt,
          });
          return row.forkKey;
        });
      const old = yield* fail("fork-key-retry-old-000001", true, "2026-10-01T00:00:00.000Z");
      yield* fail("fork-key-retry-new-000001", true, "2026-10-10T00:00:00.000Z");
      yield* fail("fork-key-final-old-000001", false, "2026-10-01T00:00:00.000Z");
      yield* repository.insertIfAbsent(ledgerRow("fork-key-unfinished-00001"));
      assert.deepStrictEqual(
        (yield* repository.listRetryableFailed({ updatedBefore: "2026-10-05T00:00:00.000Z" })).map(
          (row) => row.forkKey,
        ),
        [old],
      );
    }),
  );

  it.effect("rejects unknown phases at the database boundary", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const insert = sql`
        INSERT INTO thread_forks (
          fork_key, request_digest, fork_thread_id, source_thread_id, source_message_id,
          destination_kind, phase, plan_json, created_at, updated_at
        ) VALUES (
          'fork-key-bad-phase-000001', ${"e".repeat(64)}, 'fork-bad', 'thread', 'message',
          'new-chat', 'forking', '{}', ${createdAt}, ${createdAt}
        )
      `;
      assert.strictEqual((yield* Effect.exit(insert))._tag, "Failure");
    }),
  );
});

it("derives stable, distinct fork identities and request digests", () => {
  const identity = threadForkIdentity("fork-key-identity-000001");
  assert.deepStrictEqual(
    threadForkIdentity("fork-key-identity-000001").forkThreadId,
    identity.forkThreadId,
  );
  assert.match(identity.forkThreadId, /^fork-[0-9a-f]{32}$/);
  assert.strictEqual(identity.worktreeId, `worktree-fork-${identity.keyHash}`);
  assert.strictEqual(
    identity.commandId("publish"),
    CommandId.make(`thread-fork:${identity.keyHash}:publish`),
  );
  assert.strictEqual(identity.branch("ryco/"), `ryco/fork-${identity.keyHash.slice(0, 8)}`);
  assert.strictEqual(identity.branch(""), `fork-${identity.keyHash.slice(0, 8)}`);
  assert.notStrictEqual(threadForkIdentity("fork-key-identity-000002").keyHash, identity.keyHash);

  const base = {
    sourceThreadId,
    sourceMessageId,
    destination: { kind: "current-checkout" },
  } as const;
  assert.strictEqual(
    threadForkRequestDigest(base),
    threadForkRequestDigest({ destination: base.destination, sourceMessageId, sourceThreadId }),
  );
  assert.notStrictEqual(
    threadForkRequestDigest(base),
    threadForkRequestDigest({ ...base, destination: { kind: "new-chat" } }),
  );
});
