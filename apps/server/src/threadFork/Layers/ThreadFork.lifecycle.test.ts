/**
 * Fork lifecycle: what every error reports about the key, crashes between steps, forks the node
 * finishes on its own, destinations that disappear before publication, filesystem errors, copies
 * that could not be verified or recorded, inherited attachments, settled ledger rows and answers
 * that never wait behind running forks.
 */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  type ChatAttachment,
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeSessionId,
  type ThreadForkInput,
  ThreadId,
} from "@ryco/contracts";
import { readThreadForkedActivity } from "@ryco/shared/threadFork";
import { Deferred, Effect, Option, PlatformError } from "effect";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { readAttachmentChunk } from "../../attachmentRead.ts";
import {
  attachmentRelativePath,
  createAttachmentId,
  createFileAttachmentId,
  inheritedAttachmentId,
} from "../../attachmentStore.ts";
import { inheritedItemId } from "../../orchestration/forkInheritance.ts";
import { PersistenceSqlError } from "../../persistence/Errors.ts";
import { threadForkIdentity } from "../forkLedger.ts";
import { FORK_SKIPPED_ATTACHMENTS_NOTICE } from "../forkPlan.ts";
import { type NativeForkOutcome, NativeForkUncertain } from "../nativeFork.ts";
import {
  createForkHarness,
  fakeNative,
  type ForkHarness,
  type ForkHarnessOptions,
  type ForkTestInstance,
  seedCompletedTurn,
  seedNativeBinding,
  seedProject,
  seedThread,
} from "../threadFork.fixtures.ts";

const roots: string[] = [];
const harnesses: ForkHarness[] = [];

afterEach(async () => {
  await Promise.all(harnesses.splice(0).map((harness) => harness.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function tempRoot(prefix: string) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), prefix)));
  roots.push(root);
  return root;
}

async function harness(options: ForkHarnessOptions = {}) {
  const created = await createForkHarness(options);
  harnesses.push(created);
  return created;
}

const projectId = ProjectId.make("fork-lifecycle-project");
const sourceId = ThreadId.make("fork-lifecycle-source");

async function workspace(prefix: string) {
  const root = await tempRoot(prefix);
  const folder = path.join(root, "workspace");
  await mkdir(folder);
  return { root, folder };
}

/** A project thread with completed turns, optionally bound to a native Codex session. */
async function seedSource(
  h: ForkHarness,
  input: {
    readonly folder: string;
    readonly turns: number;
    readonly instance?: ForkTestInstance;
    readonly threadId?: ThreadId;
    readonly nativeId?: string;
    readonly seedProjectToo?: boolean;
  },
) {
  const threadId = input.threadId ?? sourceId;
  const instance = input.instance ?? "codex";
  if (input.seedProjectToo !== false) {
    await seedProject(h, { projectId, workspaceRoot: input.folder });
  }
  await seedThread(h, { threadId, projectId, instance });
  const turns = [];
  for (let index = 1; index <= input.turns; index++) {
    turns.push(await seedCompletedTurn(h, { threadId, index, instance }));
  }
  if (input.nativeId !== undefined) {
    await seedNativeBinding(h, {
      threadId,
      instance: "codex",
      cwd: input.folder,
      nativeId: input.nativeId,
    });
  }
  return turns;
}

const forkInput = (
  forkKey: string,
  sourceMessageId: MessageId,
  overrides: Partial<ThreadForkInput> = {},
): ThreadForkInput => ({
  forkKey,
  sourceThreadId: sourceId,
  sourceMessageId,
  destination: { kind: "current-checkout" },
  ...overrides,
});

const failure = (h: ForkHarness, input: ThreadForkInput) => h.run(Effect.flip(h.forks.fork(input)));

const forkedActivity = async (h: ForkHarness, forkThreadId: ThreadId) => {
  const detail = await h.detail(forkThreadId);
  const activity = detail?.activities.find((entry) => entry.kind === "thread.forked");
  return activity === undefined ? null : readThreadForkedActivity(activity);
};

describe("ThreadFork errors report what the node holds for the key", () => {
  it("none before anything is recorded, running while a row is unfinished, stopped once settled", async () => {
    const { folder } = await workspace("ryco-fork-attempt-");
    let crash = true;
    const h = await harness({
      service: {
        native: fakeNative().native,
        onRunPoint: (point) =>
          point === "provider-forking" && crash
            ? Effect.sync(() => {
                crash = false;
              }).pipe(Effect.andThen(Effect.die(new Error("simulated crash"))))
            : Effect.void,
      },
    });
    const turns = await seedSource(h, { folder, turns: 2, nativeId: "codex-source" });

    // Refused at acceptance: nothing recorded, the key is free.
    expect(
      await failure(h, forkInput("fork-key-attempt-none-1", MessageId.make("no-such-message"))),
    ).toMatchObject({ reason: "boundary-stale", attempt: "none" });

    // A run that stopped mid-way: the row stays unfinished and the node finishes it.
    const input = forkInput("fork-key-attempt-run-01", turns[0]!.replyId);
    expect(await failure(h, input)).toMatchObject({
      reason: "preparation-failed",
      retryable: true,
      attempt: "running",
    });
    const result = await h.run(h.forks.fork(input));
    expect(result.providerContext).toBe("handoff");
    expect(await h.run(h.forks.attemptState(input.forkKey))).toBe("stopped");

    // The same key with another request: the key's attempt has ended.
    expect(await failure(h, { ...input, sourceMessageId: turns[1]!.replyId })).toMatchObject({
      reason: "idempotency-conflict",
      attempt: "stopped",
    });
    expect(await h.run(h.forks.attemptState("fork-key-attempt-free-1"))).toBe("none");

    // A fork deleted since: the key's attempt has ended.
    await h.run(
      h.engine.dispatch({
        type: "thread.trash",
        commandId: CommandId.make("trash-fork-attempt"),
        threadId: result.threadId,
      }),
    );
    expect(await failure(h, input)).toMatchObject({ reason: "deleted", attempt: "stopped" });
  });
});

describe("ThreadFork recovery", () => {
  it("finishes a fork whose publication committed before its phase was recorded, without admitting it twice", async () => {
    const { root, folder } = await workspace("ryco-fork-committed-");
    const databasePath = path.join(root, "state.sqlite");
    const crashed = fakeNative();
    const first = await createForkHarness({
      databasePath,
      service: {
        native: crashed.native,
        onRunPoint: (point) =>
          point === "publish-committed" ? Effect.die(new Error("simulated crash")) : Effect.void,
      },
    });
    const input = forkInput("fork-key-committed-0001", MessageId.make(`${sourceId}-reply-1`));
    const forkId = threadForkIdentity(input.forkKey).forkThreadId;
    try {
      await seedSource(first, { folder, turns: 2, nativeId: "codex-source" });
      expect(await failure(first, input)).toMatchObject({ retryable: true, attempt: "running" });
      expect(await first.ledgerRows()).toEqual([
        { forkKey: input.forkKey, phase: "provider-ready" },
      ]);
      // The thread and its binding committed together.
      expect(await first.shell(forkId)).toBeDefined();
      // The fork's session moves on before the node restarts.
      await first.run(
        first.directory.upsert({
          threadId: forkId,
          provider: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          runtimeSessionId: RuntimeSessionId.make("fork-session-moved-on"),
          status: "stopped",
          runtimeMode: "full-access",
          resumeCursor: { threadId: "moved-on" },
          runtimePayload: { cwd: folder },
        }),
      );
    } finally {
      await first.dispose();
    }
    expect(crashed.calls).toHaveLength(1);

    const restarted = fakeNative();
    const second = await harness({ databasePath, service: { native: restarted.native } });
    await second.run(second.forks.recover());
    expect(await second.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]);
    expect(restarted.calls).toHaveLength(0);
    expect(restarted.removed).toEqual([]);
    expect((await second.threadIds()).filter((id) => id === forkId)).toHaveLength(1);
    // The publication was answered by its receipt: the binding was not written again.
    const binding = Option.getOrThrow(await second.run(second.directory.getBinding(forkId)));
    expect(binding.resumeCursor).toEqual({ threadId: "moved-on" });
    const replay = await second.run(second.forks.fork(input));
    expect(replay).toMatchObject({ threadId: forkId, replayed: true, providerContext: "native" });
  });

  for (const point of ["accepted", "provider-ready"] as const) {
    it(`recovers a new-chat fork that stopped at '${point}' into exactly one chat`, async () => {
      const root = await tempRoot("ryco-fork-chat-crash-");
      const chatsRoot = path.join(root, "chats");
      const sourceFolder = path.join(chatsRoot, "source-chat");
      await mkdir(sourceFolder, { recursive: true });
      const databasePath = path.join(root, "state.sqlite");
      const chatProject = ProjectId.make("chat-source-project");
      const input = forkInput("fork-key-chat-crash-01", MessageId.make(`${sourceId}-reply-1`), {
        destination: { kind: "new-chat" },
      });
      const identity = threadForkIdentity(input.forkKey);
      const first = await createForkHarness({
        databasePath,
        chatsRoot,
        service: {
          onRunPoint: (at) =>
            at === point ? Effect.die(new Error("simulated crash")) : Effect.void,
        },
      });
      try {
        await seedProject(first, {
          projectId: chatProject,
          workspaceRoot: sourceFolder,
          kind: "chat",
        });
        await seedThread(first, {
          threadId: sourceId,
          projectId: chatProject,
          instance: "opencode",
        });
        await seedCompletedTurn(first, { threadId: sourceId, index: 1, instance: "opencode" });
        expect(await failure(first, input)).toMatchObject({ retryable: true, attempt: "running" });
      } finally {
        await first.dispose();
      }

      const second = await harness({ databasePath, chatsRoot });
      await second.run(second.forks.recover());
      expect(await second.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]);
      const snapshot = await second.run(second.snapshots.getShellSnapshot());
      expect(
        snapshot.projects.filter((project) => project.kind === "chat").map((project) => project.id),
      ).toEqual(expect.arrayContaining([chatProject, identity.chatProjectId]));
      expect(snapshot.projects.filter((project) => project.kind === "chat")).toHaveLength(2);
      expect((await readdir(chatsRoot)).toSorted()).toEqual(
        [`chat-${identity.chatProjectId}`, "source-chat"].toSorted(),
      );
      const forkThreads = snapshot.threads.filter((thread) => thread.id === identity.forkThreadId);
      expect(forkThreads).toHaveLength(1);
      expect(forkThreads[0]?.projectId).toBe(identity.chatProjectId);
      const replay = await second.run(second.forks.fork(input));
      expect(replay).toMatchObject({ replayed: true, projectId: identity.chatProjectId });
    });
  }
});

describe("ThreadFork finishes unfinished forks on its own", () => {
  it("finishes a fork whose run stopped, without a retry or a restart", async () => {
    const { folder } = await workspace("ryco-fork-redrive-");
    let stops = 0;
    const native = fakeNative();
    const h = await harness({
      service: {
        native: native.native,
        redriveBackoff: ["20 millis"],
        // The run stops once after recording the native copy, e.g. a write that failed.
        onRunPoint: (point) =>
          point === "provider-ready" && stops++ === 0
            ? Effect.die(new Error("simulated stop"))
            : Effect.void,
      },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-redrive-000001", turns[0]!.replyId);
    const forkId = threadForkIdentity(input.forkKey).forkThreadId;

    expect(await failure(h, input)).toMatchObject({ retryable: true, attempt: "running" });

    // Nobody retries and the node does not restart: it finishes what it reported as running.
    await vi.waitFor(
      async () =>
        expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]),
      { timeout: 10_000, interval: 20 },
    );
    expect(await h.shell(forkId)).toBeDefined();
    expect(native.calls).toHaveLength(1);
    expect(native.removed).toEqual([]);
    expect(await h.run(h.forks.fork(input))).toMatchObject({
      threadId: forkId,
      replayed: true,
      providerContext: "native",
    });
  });

  it("waits longer after every stop and keeps driving the fork until it finishes", async () => {
    const { folder } = await workspace("ryco-fork-backoff-");
    const backoff = [20, 80, 160];
    const reached: number[] = [];
    const h = await harness({
      service: {
        native: fakeNative().native,
        redriveBackoff: backoff.map((millis) => `${millis} millis` as const),
        onRunPoint: (point) =>
          point !== "provider-ready"
            ? Effect.void
            : Effect.suspend(() => {
                reached.push(Date.now());
                return reached.length <= 4 ? Effect.die(new Error("simulated stop")) : Effect.void;
              }),
      },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-backoff-000001", turns[0]!.replyId);

    expect(await failure(h, input)).toMatchObject({ attempt: "running" });
    await vi.waitFor(
      async () =>
        expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]),
      { timeout: 10_000, interval: 20 },
    );
    // One request, then four drives by the node: each after its wait, the last one repeating.
    expect(reached).toHaveLength(5);
    const waits = reached.slice(1).map((at, index) => at - reached[index]!);
    for (const [index, wait] of waits.entries()) {
      expect(wait).toBeGreaterThanOrEqual(backoff[Math.min(index, backoff.length - 1)]! - 5);
    }
  });

  it("leaves a fork that is running to its attempt when it sweeps", async () => {
    const { folder } = await workspace("ryco-fork-sweep-skip-");
    const release = Deferred.makeUnsafe<void>();
    let blocking: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      blocking = resolve;
    });
    const native = fakeNative(() =>
      Effect.sync(() => blocking()).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as<NativeForkOutcome>({
          kind: "forked",
          nativeThreadId: "slow-copy",
          ownedCopy: { kind: "codex-thread", threadId: "slow-copy" },
        }),
      ),
    );
    const h = await harness({ service: { native: native.native } });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const running = h.run(h.forks.fork(forkInput("fork-key-sweep-skip-0001", turns[0]!.replyId)));
    await blocked;

    // The sweep neither starts a second run nor waits behind the native call.
    await h.run(h.forks.recover().pipe(Effect.timeout("2 seconds")));
    expect(native.calls).toHaveLength(1);

    await h.run(Deferred.succeed(release, undefined));
    expect((await running).providerContext).toBe("native");
    expect(native.calls).toHaveLength(1);
  });
});

describe("ThreadFork forks the node cannot finish", () => {
  const unreadable = (candidate: string) =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "PermissionDenied",
        module: "FileSystem",
        method: "access",
        pathOrDescriptor: candidate,
      }),
    );
  const ledgerPhase = async (h: ForkHarness, forkKey: string, phase: string) =>
    vi.waitFor(async () => expect(await h.ledgerRows()).toEqual([{ forkKey, phase }]), {
      timeout: 10_000,
      interval: 20,
    });

  it("settles a fork whose runs keep stopping, so its key stops reporting running, and a retry starts it again", async () => {
    const { folder } = await workspace("ryco-fork-give-up-");
    let broken = false;
    let stops = 0;
    let fullReads = 0;
    const h = await harness({
      ledger: (ledger) => ({
        ...ledger,
        getByKey: (request) =>
          Effect.sync(() => {
            fullReads += 1;
          }).pipe(Effect.andThen(ledger.getByKey(request))),
      }),
      // After acceptance, the fork's folder can never be checked (a mount that stays stalled).
      fileSystem: (fileSystem) => ({
        ...fileSystem,
        exists: (candidate) =>
          Effect.suspend(() => {
            if (!(broken && candidate === folder)) return fileSystem.exists(candidate);
            stops += 1;
            return unreadable(candidate);
          }),
      }),
      service: {
        native: fakeNative().native,
        redriveBackoff: ["20 millis"],
        redriveLimit: 3,
        onRunPoint: (point) =>
          point === "accepted"
            ? Effect.sync(() => {
                broken = true;
              })
            : Effect.void,
      },
    });
    const turns = await seedSource(h, { folder, turns: 1 });
    const input = forkInput("fork-key-give-up-0000001", turns[0]!.replyId);
    const forkId = threadForkIdentity(input.forkKey).forkThreadId;

    expect(await failure(h, input)).toMatchObject({ retryable: true, attempt: "running" });
    await ledgerPhase(h, input.forkKey, "failed");
    // The request's run and two of the node's stopped; the node's next run settled the fork.
    expect(stops).toBe(3);
    expect(await h.run(h.forks.attemptState(input.forkKey))).toBe("stopped");
    const row = Option.getOrThrow(await h.run(h.ledger.getByKey({ forkKey: input.forkKey })));
    expect(row.error).toMatchObject({ reason: "preparation-failed", retryable: true });
    expect(row.error?.message).toContain("stopped trying");
    // Nothing drives it anymore.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(stops).toBe(3);
    expect(await h.shell(forkId)).toBeUndefined();
    // Each run read the fork's full row (and its inherited history) once; what the key holds
    // was answered from the row without its plan.
    expect(fullReads).toBe(4);

    // Nothing native was made yet, so the same request may start it again.
    broken = false;
    const result = await h.run(h.forks.fork(input));
    expect(result).toMatchObject({ threadId: forkId, replayed: false });
  });

  it("settles a fork that stopped after its native copy for good, and never asks the provider again", async () => {
    const { folder } = await workspace("ryco-fork-give-up-native-");
    let stops = 0;
    const native = fakeNative();
    const h = await harness({
      service: {
        native: native.native,
        redriveBackoff: ["20 millis"],
        redriveLimit: 2,
        onRunPoint: (point) =>
          point === "provider-ready"
            ? Effect.suspend(() => {
                stops += 1;
                return Effect.die(new Error("simulated stop"));
              })
            : Effect.void,
      },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-give-up-native-01", turns[0]!.replyId);

    expect(await failure(h, input)).toMatchObject({ retryable: true, attempt: "running" });
    await ledgerPhase(h, input.forkKey, "failed");
    expect(stops).toBe(2);
    // The copy it made is removed; a retry answers the failure and makes no second copy.
    expect(native.removed).toEqual(["copy-of-codex-source"]);
    expect(await failure(h, input)).toMatchObject({
      reason: "preparation-failed",
      retryable: false,
      attempt: "stopped",
    });
    expect(native.calls).toHaveLength(1);
    expect(await h.shell(threadForkIdentity(input.forkKey).forkThreadId)).toBeUndefined();
  });

  for (const write of ["published", "completed"] as const) {
    it(`never settles a fork whose publication committed (its '${write}' write keeps failing): it completes it`, async () => {
      const { folder } = await workspace("ryco-fork-give-up-published-");
      let failedWrites = 0;
      const native = fakeNative();
      const h = await harness({
        ledger: (ledger) => ({
          ...ledger,
          compareAndSetPhase: (request) =>
            request.nextPhase === write && failedWrites < 4
              ? Effect.suspend(() => {
                  failedWrites += 1;
                  return Effect.fail(
                    new PersistenceSqlError({ operation: "test", detail: "busy" }),
                  );
                })
              : ledger.compareAndSetPhase(request),
        }),
        service: { native: native.native, redriveBackoff: ["20 millis"], redriveLimit: 2 },
      });
      const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
      const input = forkInput(`fork-key-give-up-${write}-1`, turns[0]!.replyId);
      const forkId = threadForkIdentity(input.forkKey).forkThreadId;

      expect(await failure(h, input)).toMatchObject({ retryable: true, attempt: "running" });
      await ledgerPhase(h, input.forkKey, "completed");
      expect(failedWrites).toBe(4);
      // The created fork keeps everything it uses.
      expect(native.removed).toEqual([]);
      expect(await h.shell(forkId)).toBeDefined();
      expect(await h.run(h.forks.fork(input))).toMatchObject({
        threadId: forkId,
        replayed: true,
        providerContext: "native",
      });
    });
  }

  it("settles sooner a fork that has not advanced for a day, after a few runs here stopped", async () => {
    const { folder } = await workspace("ryco-fork-give-up-stalled-");
    let clock = () => new Date();
    let stops = 0;
    const native = fakeNative();
    const h = await harness({
      service: {
        native: native.native,
        now: () => clock(),
        redriveBackoff: ["20 millis"],
        redriveLimit: 1_000,
        onRunPoint: (point) =>
          point === "provider-ready"
            ? Effect.suspend(() => {
                stops += 1;
                return Effect.die(new Error("simulated stop"));
              })
            : Effect.void,
      },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-give-up-stalled1", turns[0]!.replyId);

    expect(await failure(h, input)).toMatchObject({ attempt: "running" });
    // The fork made no progress for two days (e.g. the node kept restarting meanwhile).
    const later = Date.now() + 2 * 24 * 60 * 60 * 1000;
    clock = () => new Date(later);
    await ledgerPhase(h, input.forkKey, "failed");
    expect(stops).toBe(3);
    expect(native.removed).toEqual(["copy-of-codex-source"]);
  });

  it("resumes every unfinished fork at startup although another fork's row cannot be read", async () => {
    const { root, folder } = await workspace("ryco-fork-sweep-unreadable-");
    const databasePath = path.join(root, "state.sqlite");
    const input = forkInput("fork-key-sweep-readable-1", MessageId.make(`${sourceId}-reply-1`));
    const unreadableKey = "fork-key-sweep-unreadable";
    const first = await createForkHarness({
      databasePath,
      service: {
        native: fakeNative().native,
        onRunPoint: (point) =>
          point === "provider-ready" ? Effect.die(new Error("simulated crash")) : Effect.void,
      },
    });
    try {
      await seedSource(first, { folder, turns: 1, nativeId: "codex-source" });
      expect(await failure(first, input)).toMatchObject({ attempt: "running" });
      // Another fork's plan was written by a build that this one cannot read.
      await first.run(
        first.sql`INSERT INTO thread_forks (
          fork_key, request_digest, fork_thread_id, source_thread_id, source_message_id,
          destination_kind, phase, plan_json, created_at, updated_at
        ) VALUES (
          ${unreadableKey}, ${"0".repeat(64)}, 'fork-unreadable-plan', ${sourceId}, 'message-x',
          'current-checkout', 'accepted', '{"schemaVersion":99}',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )`,
      );
    } finally {
      await first.dispose();
    }

    const second = await harness({
      databasePath,
      service: { native: fakeNative().native, redriveBackoff: ["1 hour"] },
    });
    await second.run(second.forks.recover());
    expect(await second.ledgerRows()).toEqual([
      { forkKey: unreadableKey, phase: "accepted" },
      { forkKey: input.forkKey, phase: "completed" },
    ]);
    expect(await second.run(second.forks.attemptState(unreadableKey))).toBe("running");
  });
});

describe("ThreadFork filesystem errors", () => {
  it("keeps a fork unfinished while its folder cannot be checked, and finishes it once it can", async () => {
    const { folder } = await workspace("ryco-fork-fs-error-");
    let unreadable = false;
    let flipped = false;
    const native = fakeNative();
    const h = await harness({
      // The folder exists, but checking it fails (a stalled network mount, a permission flap).
      fileSystem: (fileSystem) => ({
        ...fileSystem,
        exists: (candidate) =>
          unreadable && candidate === folder
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "access",
                  pathOrDescriptor: candidate,
                }),
              )
            : fileSystem.exists(candidate),
      }),
      service: {
        native: native.native,
        redriveBackoff: ["50 millis"],
        onRunPoint: (point) =>
          point === "provider-ready" && !flipped
            ? Effect.sync(() => {
                flipped = true;
                unreadable = true;
              })
            : Effect.void,
      },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-fs-error-00001", turns[0]!.replyId);
    const forkId = threadForkIdentity(input.forkKey).forkThreadId;

    // Never "the folder no longer exists": the fork keeps what it made and stays unfinished.
    const error = await failure(h, input);
    expect(error).toMatchObject({
      reason: "preparation-failed",
      retryable: true,
      attempt: "running",
    });
    expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "provider-ready" }]);
    expect(native.removed).toEqual([]);
    expect(await h.shell(forkId)).toBeUndefined();

    unreadable = false;
    await vi.waitFor(
      async () =>
        expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]),
      { timeout: 10_000, interval: 20 },
    );
    expect(await h.run(h.forks.fork(input))).toMatchObject({
      threadId: forkId,
      replayed: true,
      providerContext: "native",
    });
    expect(native.calls).toHaveLength(1);
    expect(native.removed).toEqual([]);
  });

  it("keeps the native copy when the fork's folder cannot be resolved for a moment", async () => {
    const { folder } = await workspace("ryco-fork-fs-realpath-");
    let unresolvable = true;
    const native = fakeNative();
    const h = await harness({
      fileSystem: (fileSystem) => ({
        ...fileSystem,
        realPath: (candidate) =>
          unresolvable && candidate === folder
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Unknown",
                  module: "FileSystem",
                  method: "realPath",
                  description: "EIO",
                  pathOrDescriptor: candidate,
                }),
              )
            : fileSystem.realPath(candidate),
      }),
      service: { native: native.native, redriveBackoff: ["50 millis"] },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-fs-realpath-001", turns[0]!.replyId);

    // Not "the fork's folder is unavailable" for good: no handoff, no native call yet.
    expect(await failure(h, input)).toMatchObject({ retryable: true, attempt: "running" });
    expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "checkout-ready" }]);
    expect(native.calls).toHaveLength(0);

    unresolvable = false;
    await vi.waitFor(
      async () =>
        expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]),
      { timeout: 10_000, interval: 20 },
    );
    expect(await h.run(h.forks.fork(input))).toMatchObject({
      replayed: true,
      providerContext: "native",
    });
    expect(native.calls).toHaveLength(1);
  });
});

describe("ThreadFork destinations that disappear before publication", () => {
  it("fails for good and removes what it made when the fork's folder is gone", async () => {
    const { folder } = await workspace("ryco-fork-gone-");
    const native = fakeNative();
    const h = await harness({
      service: {
        native: native.native,
        onRunPoint: (point) =>
          point === "provider-ready"
            ? Effect.promise(() => rm(folder, { recursive: true, force: true }))
            : Effect.void,
      },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-folder-gone-01", turns[0]!.replyId);

    const error = await failure(h, input);
    expect(error).toMatchObject({
      reason: "destination-unavailable",
      retryable: false,
      attempt: "stopped",
    });
    expect(error.message).toContain("no longer exists");
    expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "failed" }]);
    // The native copy it made and recorded was removed; nothing was published.
    expect(native.removed).toEqual(["copy-of-codex-source"]);
    expect(await h.shell(threadForkIdentity(input.forkKey).forkThreadId)).toBeUndefined();
    // A retry answers the stored failure; recovery has nothing left to resume.
    expect(await failure(h, input)).toMatchObject({ reason: "destination-unavailable" });
    await h.run(h.forks.recover());
    expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "failed" }]);
    expect(native.calls).toHaveLength(1);
  });
});

describe("ThreadFork native copies", () => {
  it("records a copy it created but could not verify, never uses it, and removes it after publishing", async () => {
    const { folder } = await workspace("ryco-fork-orphan-");
    const native = fakeNative(() =>
      Effect.fail(
        new NativeForkUncertain({
          detail: "Codex created a fork that could not be verified or removed.",
          nativeThreadId: "orphan-copy",
          ownedCopy: { kind: "codex-thread", threadId: "orphan-copy" },
        }),
      ),
    );
    const h = await harness({ service: { native: native.native } });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-orphan-copy-01", turns[0]!.replyId);

    const result = await h.run(h.forks.fork(input));
    expect(result.providerContext).toBe("handoff");
    expect(result.notices.some((notice) => notice.includes("did not repeat the copy"))).toBe(true);
    expect(Option.isNone(await h.run(h.directory.getBinding(result.threadId)))).toBe(true);
    const row = Option.getOrThrow(await h.run(h.ledger.getByKey({ forkKey: input.forkKey })));
    expect(row.provider).toMatchObject({
      kind: "handoff",
      reason: "native-fork-uncertain",
      orphan: {
        nativeThreadId: "orphan-copy",
        copy: { kind: "codex-thread", threadId: "orphan-copy" },
      },
    });
    expect(native.removed).toEqual(["orphan-copy"]);
  });

  it("removes a confirmed copy it could not record, and never uses it", async () => {
    const { folder } = await workspace("ryco-fork-unrecorded-copy-");
    let failWrite = true;
    const native = fakeNative();
    const h = await harness({
      ledger: (ledger) => ({
        ...ledger,
        compareAndSetPhase: (request) =>
          failWrite &&
          request.nextPhase === "provider-ready" &&
          request.patch.provider?.kind === "native"
            ? Effect.sync(() => {
                failWrite = false;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new PersistenceSqlError({ operation: "test", detail: "disk I/O" })),
                ),
              )
            : ledger.compareAndSetPhase(request),
      }),
      service: { native: native.native, redriveBackoff: ["1 hour"] },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-unrecorded-copy-1", turns[0]!.replyId);

    expect(await failure(h, input)).toMatchObject({ retryable: true, attempt: "running" });
    expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "provider-forking" }]);
    // Nothing records the copy, so it is removed at once instead of being left behind.
    expect(native.removed).toEqual(["copy-of-codex-source"]);

    const result = await h.run(h.forks.fork(input));
    expect(result.providerContext).toBe("handoff");
    expect(native.calls).toHaveLength(1);
    expect(Option.isNone(await h.run(h.directory.getBinding(result.threadId)))).toBe(true);
  });

  it("removes an unconfirmed copy whose id it got but could not record, and never uses it", async () => {
    const { folder } = await workspace("ryco-fork-unrecorded-orphan-");
    let failWrite = true;
    const native = fakeNative(() =>
      Effect.fail(
        new NativeForkUncertain({
          detail: "Codex created a fork that could not be verified or removed.",
          nativeThreadId: "unrecorded-orphan",
          ownedCopy: { kind: "codex-thread", threadId: "unrecorded-orphan" },
        }),
      ),
    );
    const h = await harness({
      ledger: (ledger) => ({
        ...ledger,
        compareAndSetPhase: (request) =>
          failWrite &&
          request.nextPhase === "provider-ready" &&
          request.patch.provider?.kind === "handoff" &&
          request.patch.provider.orphan !== undefined
            ? Effect.sync(() => {
                failWrite = false;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new PersistenceSqlError({ operation: "test", detail: "disk I/O" })),
                ),
              )
            : ledger.compareAndSetPhase(request),
      }),
      service: { native: native.native, redriveBackoff: ["1 hour"] },
    });
    const turns = await seedSource(h, { folder, turns: 1, nativeId: "codex-source" });
    const input = forkInput("fork-key-unrecorded-orphan-1", turns[0]!.replyId);

    expect(await failure(h, input)).toMatchObject({ retryable: true, attempt: "running" });
    expect(await h.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "provider-forking" }]);
    // Nothing records the copy's id, so it is removed at once instead of being left behind.
    expect(native.removed).toEqual(["unrecorded-orphan"]);

    const result = await h.run(h.forks.fork(input));
    expect(result.providerContext).toBe("handoff");
    expect(native.calls).toHaveLength(1);
    expect(native.removed).toEqual(["unrecorded-orphan"]);
    expect(Option.isNone(await h.run(h.directory.getBinding(result.threadId)))).toBe(true);
  });

  it("records a confirmed copy even when the node shuts down while writing it", async () => {
    const { root, folder } = await workspace("ryco-fork-copy-shutdown-");
    const databasePath = path.join(root, "state.sqlite");
    let writing: () => void = () => {};
    const entered = new Promise<void>((resolve) => {
      writing = resolve;
    });
    const native = fakeNative();
    const first = await createForkHarness({
      databasePath,
      ledger: (ledger) => ({
        ...ledger,
        compareAndSetPhase: (request) =>
          request.nextPhase === "provider-ready" && request.patch.provider?.kind === "native"
            ? Effect.sync(() => writing()).pipe(
                Effect.andThen(Effect.sleep("200 millis")),
                Effect.andThen(ledger.compareAndSetPhase(request)),
              )
            : ledger.compareAndSetPhase(request),
      }),
      service: { native: native.native },
    });
    const input = forkInput("fork-key-copy-shutdown-01", MessageId.make(`${sourceId}-reply-1`));
    let forking: Promise<unknown> = Promise.resolve();
    try {
      await seedSource(first, { folder, turns: 1, nativeId: "codex-source" });
      forking = first.run(first.forks.fork(input)).catch(() => undefined);
      await entered;
    } finally {
      // The node shuts down while the copy the provider returned is being recorded.
      await first.dispose();
    }
    await forking;
    expect(native.calls).toHaveLength(1);

    const restarted = fakeNative();
    const second = await harness({ databasePath, service: { native: restarted.native } });
    await second.run(second.forks.recover());
    expect(await second.ledgerRows()).toEqual([{ forkKey: input.forkKey, phase: "completed" }]);
    expect(await second.run(second.forks.fork(input))).toMatchObject({
      replayed: true,
      providerContext: "native",
    });
    expect(restarted.calls).toHaveLength(0);
    expect(restarted.removed).toEqual([]);
  });
});

describe("ThreadFork ledger", () => {
  it("keeps only what a replay needs once a fork completed", async () => {
    const { folder } = await workspace("ryco-fork-settled-");
    const h = await harness({ service: { native: fakeNative().native } });
    const turns = await seedSource(h, { folder, turns: 2, instance: "opencode" });
    const input = forkInput("fork-key-settled-row-01", turns[1]!.replyId);
    const result = await h.run(h.forks.fork(input));
    expect((await h.detail(result.threadId))?.messages).toHaveLength(4);

    const row = Option.getOrThrow(await h.run(h.ledger.getByKey({ forkKey: input.forkKey })));
    expect(row.phase).toBe("completed");
    expect(row.plan.command.messages).toEqual([]);
    expect(row.plan.command.activities).toEqual([]);
    expect(row.result).toEqual(result);
    expect(await h.run(h.forks.fork(input))).toEqual({ ...result, replayed: true });
  });

  it("answers replays and conflicts without waiting for forks that hold every permit", async () => {
    const { folder } = await workspace("ryco-fork-permits-");
    const release = Deferred.makeUnsafe<void>();
    let blocking: () => void = () => {};
    const blocked = new Promise<void>((resolve) => {
      blocking = resolve;
    });
    const native = fakeNative(() =>
      Effect.sync(() => blocking()).pipe(
        Effect.andThen(Deferred.await(release)),
        Effect.as<NativeForkOutcome>({
          kind: "forked",
          nativeThreadId: "slow-copy",
          ownedCopy: { kind: "codex-thread", threadId: "slow-copy" },
        }),
      ),
    );
    const h = await harness({ service: { native: native.native, maxConcurrentForks: 1 } });
    const turns = await seedSource(h, { folder, turns: 1, instance: "opencode" });
    const done = await h.run(h.forks.fork(forkInput("fork-key-permit-done-01", turns[0]!.replyId)));

    const slowSource = ThreadId.make("fork-lifecycle-slow");
    const [slowTurn] = await seedSource(h, {
      folder,
      turns: 1,
      threadId: slowSource,
      nativeId: "codex-slow",
      seedProjectToo: false,
    });
    const slow = h.run(
      h.forks.fork(
        forkInput("fork-key-permit-slow-01", slowTurn!.replyId, { sourceThreadId: slowSource }),
      ),
    );
    await blocked;

    const answers = await h.run(
      Effect.all([
        h.forks.fork(forkInput("fork-key-permit-done-01", turns[0]!.replyId)),
        Effect.flip(
          h.forks.fork(
            forkInput("fork-key-permit-done-01", turns[0]!.replyId, {
              destination: { kind: "new-chat" },
            }),
          ),
        ),
      ]).pipe(Effect.timeout("5 seconds")),
    );
    expect(answers[0]).toEqual({ ...done, replayed: true });
    expect(answers[1]).toMatchObject({ reason: "idempotency-conflict" });

    await h.run(Deferred.succeed(release, undefined));
    expect((await slow).providerContext).toBe("native");
  });
});

describe("ThreadFork inherited attachments", () => {
  async function storedAttachments(h: ForkHarness) {
    const image = {
      type: "image",
      id: createAttachmentId(sourceId)!,
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    } as const satisfies ChatAttachment;
    const file = {
      type: "file",
      id: createFileAttachmentId(sourceId, "spec.pdf")!,
      name: "spec.pdf",
      mimeType: "application/pdf",
      sizeBytes: 7,
    } as const satisfies ChatAttachment;
    const write = async (attachment: ChatAttachment, bytes: string) => {
      const filePath = path.join(h.config.attachmentsDir, attachmentRelativePath(attachment)!);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, bytes);
      return filePath;
    };
    return { image, file, write };
  }

  it("copies them under the fork's own ids, readable there and independent of the source", async () => {
    const { folder } = await workspace("ryco-fork-attachments-");
    let crash = true;
    const h = await harness({
      service: {
        native: fakeNative().native,
        // Stops once after linking the copies; the retry must not link or lose them again.
        onRunPoint: (point) =>
          point === "provider-ready" && crash
            ? Effect.sync(() => {
                crash = false;
              }).pipe(Effect.andThen(Effect.die(new Error("simulated crash"))))
            : Effect.void,
      },
    });
    const { image, file, write } = await storedAttachments(h);
    const sourceFiles = [await write(image, "png!"), await write(file, "%PDF-1.")];
    await seedProject(h, { projectId, workspaceRoot: folder });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const turn = await seedCompletedTurn(h, {
      threadId: sourceId,
      index: 1,
      instance: "opencode",
      promptAttachments: [image, file],
    });
    const input = forkInput("fork-key-attachments-01", turn.replyId);
    expect(await failure(h, input)).toMatchObject({ attempt: "running" });
    const result = await h.run(h.forks.fork(input));

    const forkPromptId = MessageId.make(
      inheritedItemId({
        forkThreadId: result.threadId,
        sourceThreadId: sourceId,
        sourceItemId: turn.promptId,
      }),
    );
    const prompt = (await h.detail(result.threadId))?.messages.find(
      (message) => message.id === forkPromptId,
    );
    const copies = [image, file].map((attachment) => ({
      ...attachment,
      id: inheritedAttachmentId({
        forkThreadId: result.threadId,
        sourceAttachmentId: attachment.id,
      })!,
    }));
    expect(prompt?.attachments).toEqual(copies);
    expect(result.notices).toEqual([]);
    for (const copy of copies) {
      const chunk = await h.run(
        readAttachmentChunk(
          { threadId: result.threadId, messageId: forkPromptId, attachmentId: copy.id, offset: 0 },
          { attachmentsDir: h.config.attachmentsDir, projections: h.snapshots },
        ),
      );
      expect(chunk.totalBytes).toBe(copy.sizeBytes);
    }

    // Deleting the original removes its files; the fork keeps its own.
    for (const type of ["thread.trash", "thread.delete"] as const) {
      await h.run(
        h.engine.dispatch({
          type,
          commandId: CommandId.make(`${type}-attachments-source`),
          threadId: sourceId,
        }),
      );
    }
    expect(sourceFiles.map((filePath) => existsSync(filePath))).toEqual([false, false]);
    expect(
      copies.map((copy) =>
        existsSync(path.join(h.config.attachmentsDir, attachmentRelativePath(copy)!)),
      ),
    ).toEqual([true, true]);
  });

  it("drops an attachment it could not copy instead of referencing a missing file", async () => {
    const { folder } = await workspace("ryco-fork-attachment-gone-");
    const h = await harness({ service: { native: fakeNative().native } });
    const { image, file, write } = await storedAttachments(h);
    // The image's file is gone (e.g. the original was reverted) before the fork copies it.
    await write(file, "%PDF-1.");
    await seedProject(h, { projectId, workspaceRoot: folder });
    await seedThread(h, { threadId: sourceId, projectId, instance: "opencode" });
    const turn = await seedCompletedTurn(h, {
      threadId: sourceId,
      index: 1,
      instance: "opencode",
      promptAttachments: [image, file],
    });
    const input = forkInput("fork-key-attach-gone-01", turn.replyId);
    const result = await h.run(h.forks.fork(input));

    const fileCopy = inheritedAttachmentId({
      forkThreadId: result.threadId,
      sourceAttachmentId: file.id,
    })!;
    const imageCopy = inheritedAttachmentId({
      forkThreadId: result.threadId,
      sourceAttachmentId: image.id,
    })!;
    const prompt = (await h.detail(result.threadId))?.messages.find(
      (message) => message.role === "user",
    );
    expect(prompt?.attachments?.map((attachment) => attachment.id)).toEqual([fileCopy]);
    expect(result.notices).toEqual([FORK_SKIPPED_ATTACHMENTS_NOTICE]);
    expect((await forkedActivity(h, result.threadId))?.notices).toEqual([
      FORK_SKIPPED_ATTACHMENTS_NOTICE,
    ]);
    const row = Option.getOrThrow(await h.run(h.ledger.getByKey({ forkKey: input.forkKey })));
    expect(row.attachments?.attachmentIds).toEqual([fileCopy]);
    expect(
      existsSync(
        path.join(h.config.attachmentsDir, attachmentRelativePath({ ...image, id: imageCopy })!),
      ),
    ).toBe(false);
  });
});
