import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Effect, Option, Stream } from "effect";
import { WS_METHODS, LocalTaskError, OrchestrationDispatchCommandError } from "@ryco/contracts";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeChatAttachmentUploads } from "../attachmentUpload.ts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { toSafeThreadAttachmentSegment } from "../attachmentStore.ts";
import type { RpcPrincipal, RpcPrincipalRole } from "./RpcPrincipal.ts";
import type { WsRpcContext } from "./context.ts";
import { makeLocalTaskHandlers } from "./localTaskRpc.ts";

const { apply, normalize } = vi.hoisted(() => ({ apply: vi.fn(), normalize: vi.fn() }));
vi.mock("../orchestration/Layers/OrchestrationCommandApplication.ts", async (importOriginal) => ({
  applyOrchestrationNormalizedCommand: apply,
  // The real process-wide flights: concurrent identical delegations must join one attempt.
  orchestrationCommandFlights: (
    await importOriginal<
      typeof import("../orchestration/Layers/OrchestrationCommandApplication.ts")
    >()
  ).orchestrationCommandFlights,
}));
vi.mock("../orchestration/Normalizer.ts", () => ({
  normalizeDispatchCommand: normalize,
  withChatAttachmentAdoption: (_command: unknown, effect: unknown) => effect,
}));
// The module mocks replace both effectful orchestration dependencies with context-free effects.
const runMocked = <E, R>(effect: Effect.Effect<unknown, E, R>) =>
  Effect.runPromise(effect as Effect.Effect<unknown, E>);
const methods = [
  WS_METHODS.serverListLocalTasks,
  WS_METHODS.serverGetLocalTask,
  WS_METHODS.serverCreateLocalTask,
  WS_METHODS.serverUpdateLocalTask,
  WS_METHODS.serverDeleteLocalTask,
  WS_METHODS.serverDelegateLocalTask,
  WS_METHODS.serverCreateLocalTaskFileUpload,
  WS_METHODS.serverAddLocalTaskFile,
  WS_METHODS.serverRemoveLocalTaskFile,
] as const;
const authorizeOwner = (role: RpcPrincipalRole, method: string) =>
  authorizeRpcPrincipal(
    {
      role,
      transport: "relay",
      scopeId: "test",
      canManageLocalAccess: false,
    } satisfies RpcPrincipal,
    "owner",
    method,
  );
const ownerEffect = (role: RpcPrincipalRole) => (method: string, effect: Effect.Effect<unknown>) =>
  authorizeOwner(role, method).pipe(Effect.andThen(effect));
const ownerStream =
  (role: RpcPrincipalRole) =>
  <A, E>(method: string, stream: Stream.Stream<A, E>) =>
    Stream.unwrap(authorizeOwner(role, method).pipe(Effect.as(stream)));

type ChangeStream = Stream.Stream<{ readonly taskId: string }, { readonly status?: number }>;

let commandSequence = 0;
/** Unique per test: the flights are process-wide, keyed by command id. */
const nextCommandId = () => `command-${++commandSequence}`;
const delegateInput = (commandId: string, extra: Record<string, unknown> = {}) => ({
  taskId: "task",
  command: { type: "thread.turn.start", commandId, threadId: "thread", ...extra },
});
const normalizedFor = (commandId: string, extra: Record<string, unknown> = {}) => ({
  type: "thread.turn.start",
  commandId,
  threadId: "thread",
  message: { messageId: "message", role: "user", text: "Do it", attachments: [] },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdAt: "2026-10-02T00:00:00.000Z",
  ...extra,
});
const task = { taskId: "task", revision: 2, status: "starting", files: [] as unknown[] };
const taskFile = {
  fileId: "task-task-11111111-2222-3333-4444-555555555555-txt",
  type: "file" as const,
  name: "notes.txt",
  mimeType: "text/plain",
  sizeBytes: 3,
  addedAt: "2026-10-02T00:00:00.000Z",
};

function setup(role: RpcPrincipalRole = "owner") {
  const calls: string[] = [];
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ryco-task-rpc-"));
  const config = {
    attachmentsDir: path.join(root, "attachments"),
    taskFilesDir: path.join(root, "task-files"),
  };
  fs.mkdirSync(config.attachmentsDir);
  fs.mkdirSync(config.taskFilesDir);
  const service = {
    getSettledDelegation: vi.fn(() => Effect.succeed(null)),
    list: vi.fn(() =>
      Effect.sync(() => {
        calls.push("list");
        return { tasks: [], nextCursor: null };
      }),
    ),
    get: vi.fn(() => Effect.succeed(task)),
    create: vi.fn(() => Effect.succeed(task)),
    update: vi.fn(() => Effect.succeed(task)),
    remove: vi.fn(() => Effect.succeed({ deleted: true })),
    reserveDelegation: vi.fn((input: { command: { commandId: string } }) =>
      Effect.sync(() => {
        calls.push("reserve");
        return {
          task,
          command: input.command,
          files: [] as unknown[],
          replayed: false,
          needsDispatch: true,
        };
      }),
    ),
    markDelegated: vi.fn(() =>
      Effect.sync(() => {
        calls.push("mark");
      }),
    ),
    markDelegationFailed: vi.fn(() =>
      Effect.sync(() => {
        calls.push("mark-failed");
        return true;
      }),
    ),
    addFile: vi.fn(() => Effect.succeed(task)),
    removeFile: vi.fn(() => Effect.succeed(task)),
    changes: Stream.make({ taskId: "task" }, { taskId: "other" }),
  };
  normalize.mockImplementation((command: { commandId: string; bootstrap?: unknown }) =>
    Effect.succeed(
      normalizedFor(
        command.commandId,
        command.bootstrap === undefined ? {} : { bootstrap: command.bootstrap },
      ),
    ),
  );
  apply.mockImplementation(() =>
    Effect.sync(() => {
      calls.push("dispatch");
      return { sequence: 7 };
    }),
  );
  const uploads = Effect.runSync(
    makeChatAttachmentUploads({
      attachmentsDir: config.attachmentsDir,
      taskFilesDir: config.taskFilesDir,
    }),
  );
  const ctx = {
    ownerEffect: ownerEffect(role),
    ownerStream: ownerStream(role),
    localTaskService: Option.some(service),
    chatAttachmentUploads: Option.some(uploads),
    config,
    dispatchNormalizedCommand: vi.fn(),
    projectionSnapshotQuery: {},
    terminalManager: {},
  } as unknown as WsRpcContext;
  return { calls, service, ctx, config, uploads, handlers: makeLocalTaskHandlers(ctx) };
}

describe("local task RPC", () => {
  beforeEach(() => vi.clearAllMocks());
  for (const role of ["viewer", "operator"] as const) {
    it(`rejects ${role} before task reads or mutations`, async () => {
      const { calls, handlers, service } = setup(role);
      for (const method of methods) {
        expect(rpcAccessFor(method)).toBe("owner");
        await expect(
          runMocked(handlers[method](delegateInput(nextCommandId()) as never)),
        ).rejects.toMatchObject({ status: 403 });
      }
      expect(calls).toEqual([]);
      expect(service.reserveDelegation).not.toHaveBeenCalled();
      expect(service.addFile).not.toHaveBeenCalled();
      expect(service.removeFile).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    });
  }

  it("streams the node's task changes to the owner only", async () => {
    const owner = setup();
    const changes = await Effect.runPromise(
      Stream.runCollect(
        owner.handlers[WS_METHODS.serverSubscribeLocalTaskChanges]({}) as unknown as ChangeStream,
      ),
    );
    expect([...changes]).toEqual([{ taskId: "task" }, { taskId: "other" }]);
    expect(rpcAccessFor(WS_METHODS.serverSubscribeLocalTaskChanges)).toBe("owner");
    const viewer = setup("viewer");
    await expect(
      Effect.runPromise(
        Stream.runCollect(
          viewer.handlers[WS_METHODS.serverSubscribeLocalTaskChanges](
            {},
          ) as unknown as ChangeStream,
        ),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });

  it("reserves durably, dispatches through normal orchestration, marks it and answers with the task", async () => {
    const { calls, handlers, ctx, service } = setup();
    const commandId = nextCommandId();
    expect(
      await runMocked(
        handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(commandId) as never),
      ),
    ).toEqual(task);
    expect(calls).toEqual(["reserve", "dispatch", "mark"]);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        command: normalizedFor(commandId),
        dispatch: ctx.dispatchNormalizedCommand,
        projections: ctx.projectionSnapshotQuery,
        terminals: ctx.terminalManager,
      }),
    );
    expect(service.markDelegated).toHaveBeenCalledWith(commandId);
    expect(service.get).toHaveBeenCalledWith("task");
  });

  it("passes a bootstrap start through to orchestration, which creates its thread", async () => {
    const { handlers } = setup();
    const commandId = nextCommandId();
    const bootstrap = {
      createThread: { projectId: "project" },
      prepareWorktree: { branch: "task/x" },
    };
    await runMocked(
      handlers[WS_METHODS.serverDelegateLocalTask](
        delegateInput(commandId, { bootstrap }) as never,
      ),
    );
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({ command: expect.objectContaining({ bootstrap }) }),
    );
  });

  it("dispatches two identical concurrent delegations once", async () => {
    const { calls, handlers, service } = setup();
    const commandId = nextCommandId();
    apply.mockImplementation(() =>
      Effect.sleep("20 millis").pipe(
        Effect.andThen(
          Effect.sync(() => {
            calls.push("dispatch");
            return { sequence: 7 };
          }),
        ),
      ),
    );
    const results = await Promise.all([
      runMocked(handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(commandId) as never)),
      runMocked(handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(commandId) as never)),
    ]);
    expect(results).toEqual([task, task]);
    expect(calls).toEqual(["reserve", "dispatch", "mark"]);
    expect(service.reserveDelegation).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledTimes(1);
  });

  it("copies the task's files into the chat's own attachments before dispatching", async () => {
    const { handlers, service, config } = setup();
    const commandId = nextCommandId();
    fs.writeFileSync(path.join(config.taskFilesDir, taskFile.fileId), "abc");
    service.reserveDelegation.mockImplementation((input: { command: { commandId: string } }) =>
      Effect.succeed({
        task,
        command: input.command,
        files: [taskFile],
        replayed: false,
        needsDispatch: true,
      }),
    );
    await runMocked(
      handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(commandId) as never),
    );
    const dispatched = apply.mock.calls[0]?.[0] as {
      command: { message: { attachments: Array<{ id: string; type: string; name: string }> } };
    };
    const [copy] = dispatched.command.message.attachments;
    expect(copy).toMatchObject({ type: "file", name: "notes.txt", sizeBytes: 3 });
    expect(copy!.id.startsWith(`${toSafeThreadAttachmentSegment("thread")}-`)).toBe(true);
    expect(copy!.id.endsWith("-txt")).toBe(true);
    expect(fs.readFileSync(path.join(config.attachmentsDir, copy!.id), "utf8")).toBe("abc");
  });

  it("returns a settled start without touching attachments or dispatching again", async () => {
    const { handlers, service } = setup();
    service.getSettledDelegation.mockReturnValue(Effect.succeed(task) as never);
    expect(
      await runMocked(
        handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(nextCommandId()) as never),
      ),
    ).toEqual(task);
    expect(normalize).not.toHaveBeenCalled();
    expect(service.reserveDelegation).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not dispatch a replayed start that already settled", async () => {
    const { calls, handlers, service } = setup();
    service.reserveDelegation.mockImplementation((input: { command: { commandId: string } }) =>
      Effect.succeed({
        task,
        command: input.command,
        files: [],
        replayed: true,
        needsDispatch: false,
      }),
    );
    expect(
      await runMocked(
        handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(nextCommandId()) as never),
      ),
    ).toEqual(task);
    expect(apply).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
  });

  it("does not reserve a task when command normalization fails", async () => {
    const { handlers, service } = setup();
    normalize.mockReturnValue(
      Effect.fail(new OrchestrationDispatchCommandError({ message: "Invalid attachment" })),
    );
    await expect(
      runMocked(
        handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(nextCommandId()) as never),
      ),
    ).rejects.toMatchObject({ message: "Invalid attachment" });
    expect(service.reserveDelegation).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("marks the start failed when its dispatch fails", async () => {
    const { calls, handlers, service } = setup();
    const commandId = nextCommandId();
    const error = new OrchestrationDispatchCommandError({ message: "Worktree setup failed." });
    apply.mockReturnValue(Effect.fail(error));
    await expect(
      runMocked(handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(commandId) as never)),
    ).rejects.toBe(error);
    expect(calls).toEqual(["reserve", "mark-failed"]);
    expect(service.markDelegationFailed).toHaveBeenCalledWith(commandId, "Worktree setup failed.");
    expect(service.markDelegated).not.toHaveBeenCalled();
  });

  it("deletes the file copies of a start that failed, but not of one orchestration took", async () => {
    const { handlers, service, config } = setup();
    fs.writeFileSync(path.join(config.taskFilesDir, taskFile.fileId), "abc");
    service.reserveDelegation.mockImplementation((input: { command: { commandId: string } }) =>
      Effect.succeed({
        task,
        command: input.command,
        files: [taskFile],
        replayed: false,
        needsDispatch: true,
      }),
    );
    apply.mockReturnValue(
      Effect.fail(new OrchestrationDispatchCommandError({ message: "Worktree setup failed." })),
    );
    await expect(
      runMocked(
        handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(nextCommandId()) as never),
      ),
    ).rejects.toMatchObject({ message: "Worktree setup failed." });
    expect(fs.readdirSync(config.attachmentsDir)).toEqual([]);

    // Accepted before the failure: the message references its copies, which stay.
    service.markDelegationFailed.mockReturnValue(Effect.succeed(false) as never);
    await expect(
      runMocked(
        handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(nextCommandId()) as never),
      ),
    ).rejects.toMatchObject({ message: "Worktree setup failed." });
    expect(fs.readdirSync(config.attachmentsDir)).toHaveLength(1);
  });

  it("marks the start failed when a task file cannot be copied", async () => {
    const { handlers, service } = setup();
    const commandId = nextCommandId();
    service.reserveDelegation.mockImplementation((input: { command: { commandId: string } }) =>
      Effect.succeed({
        task,
        command: input.command,
        files: [taskFile],
        replayed: false,
        needsDispatch: true,
      }),
    );
    await expect(
      runMocked(handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(commandId) as never)),
    ).rejects.toMatchObject({ _tag: "LocalTaskError", reason: "persistence" });
    expect(service.markDelegationFailed).toHaveBeenCalledWith(
      commandId,
      "Task file 'notes.txt' could not be added to the chat.",
    );
    expect(apply).not.toHaveBeenCalled();
  });

  it("never dispatches if reservation conflicts", async () => {
    const { handlers, service } = setup();
    service.reserveDelegation.mockReturnValue(
      Effect.fail(new LocalTaskError({ reason: "conflict", message: "Changed" })) as never,
    );
    await expect(
      runMocked(
        handlers[WS_METHODS.serverDelegateLocalTask](delegateInput(nextCommandId()) as never),
      ),
    ).rejects.toMatchObject({ _tag: "LocalTaskError", reason: "conflict" });
    expect(apply).not.toHaveBeenCalled();
    expect(service.markDelegationFailed).not.toHaveBeenCalled();
  });

  it("fails with a typed error on nodes without task storage", async () => {
    const { ctx } = setup();
    const handlers = makeLocalTaskHandlers({ ...ctx, localTaskService: Option.none() });
    await expect(runMocked(handlers[WS_METHODS.serverListLocalTasks]({}))).rejects.toMatchObject({
      _tag: "LocalTaskError",
      reason: "persistence",
    });
  });

  it("uploads a task file and adds it from its token, once", async () => {
    const { handlers, service, uploads, config } = setup();
    const file = { name: "notes.txt", mimeType: "text/plain", sizeBytes: 3 };
    const created = (await runMocked(
      handlers[WS_METHODS.serverCreateLocalTaskFileUpload]({ taskId: "task", ...file }),
    )) as { uploadToken: string };
    const lease = await Effect.runPromise(uploads.beginUpload(created.uploadToken));
    expect(path.dirname(lease.finalPath)).toBe(path.resolve(config.taskFilesDir));
    fs.writeFileSync(lease.finalPath, "abc");
    await Effect.runPromise(uploads.completeUpload(created.uploadToken));
    const add = {
      taskId: "task",
      expectedRevision: 2,
      ...file,
      uploadToken: created.uploadToken,
    };
    await runMocked(handlers[WS_METHODS.serverAddLocalTaskFile](add));
    await runMocked(handlers[WS_METHODS.serverAddLocalTaskFile](add));
    const [first, second] = service.addFile.mock.calls.map(
      (call) => (call as unknown as [{ file: { fileId: string; type: string } }])[0].file,
    );
    expect(first).toMatchObject({ fileId: lease.attachmentId, type: "file", name: "notes.txt" });
    expect(second?.fileId).toBe(first?.fileId);
    // Another task cannot take it.
    await expect(
      runMocked(handlers[WS_METHODS.serverAddLocalTaskFile]({ ...add, taskId: "other" })),
    ).rejects.toMatchObject({ _tag: "LocalTaskError", reason: "invalid" });
  });

  it("hands a claimed upload back when the task refuses the add", async () => {
    const { handlers, service, uploads, config } = setup();
    const releaseTaskClaim = vi.spyOn(uploads, "releaseTaskClaim");
    const file = { name: "notes.txt", mimeType: "text/plain", sizeBytes: 3 };
    const created = (await runMocked(
      handlers[WS_METHODS.serverCreateLocalTaskFileUpload]({ taskId: "task", ...file }),
    )) as { uploadToken: string };
    const lease = await Effect.runPromise(uploads.beginUpload(created.uploadToken));
    fs.writeFileSync(lease.finalPath, "abc");
    await Effect.runPromise(uploads.completeUpload(created.uploadToken));
    service.addFile.mockReturnValue(
      Effect.fail(new LocalTaskError({ reason: "not-found", message: "Task not found." })) as never,
    );
    const add = { taskId: "task", expectedRevision: 2, ...file, uploadToken: created.uploadToken };
    await expect(runMocked(handlers[WS_METHODS.serverAddLocalTaskFile](add))).rejects.toMatchObject(
      { reason: "not-found" },
    );
    expect(releaseTaskClaim).toHaveBeenCalledWith({
      uploadToken: created.uploadToken,
      taskId: "task",
    });
    // Unclaimed again: its expiry deletes the file, or a retry claims it.
    service.addFile.mockReturnValue(Effect.succeed(task) as never);
    await runMocked(handlers[WS_METHODS.serverAddLocalTaskFile](add));
    expect(fs.readdirSync(config.taskFilesDir)).toEqual([lease.attachmentId]);
  });

  it("refuses an upload the task could never hold", async () => {
    const { handlers, service } = setup();
    service.get.mockReturnValue(
      Effect.succeed({ ...task, files: Array.from({ length: 8 }, () => taskFile) }) as never,
    );
    await expect(
      runMocked(
        handlers[WS_METHODS.serverCreateLocalTaskFileUpload]({
          taskId: "task",
          name: "notes.txt",
          mimeType: "text/plain",
          sizeBytes: 3,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "LocalTaskError", reason: "invalid" });
  });

  it("stores an inline task file and deletes it again when the add fails", async () => {
    const { handlers, service, config } = setup();
    const add = {
      taskId: "task",
      expectedRevision: 2,
      name: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 3,
      dataUrl: "data:text/plain;base64,YWJj",
    };
    await runMocked(handlers[WS_METHODS.serverAddLocalTaskFile](add));
    const stored = (service.addFile.mock.calls[0] as unknown as [{ file: { fileId: string } }])[0]
      .file;
    expect(stored.fileId.startsWith("task-task-")).toBe(true);
    expect(fs.readFileSync(path.join(config.taskFilesDir, stored.fileId), "utf8")).toBe("abc");

    service.addFile.mockReturnValue(
      Effect.fail(new LocalTaskError({ reason: "conflict", message: "Changed" })) as never,
    );
    await expect(runMocked(handlers[WS_METHODS.serverAddLocalTaskFile](add))).rejects.toMatchObject(
      { reason: "conflict" },
    );
    expect(fs.readdirSync(config.taskFilesDir)).toEqual([stored.fileId]);

    await expect(
      runMocked(
        handlers[WS_METHODS.serverAddLocalTaskFile]({
          ...add,
          dataUrl: "data:text/plain;base64,YWJjZA==",
        }),
      ),
    ).rejects.toMatchObject({ _tag: "LocalTaskError", reason: "invalid" });
  });

  it("removes a task file through the service", async () => {
    const { handlers, service } = setup();
    const input = { taskId: "task", expectedRevision: 2, fileId: taskFile.fileId };
    expect(await runMocked(handlers[WS_METHODS.serverRemoveLocalTaskFile](input))).toEqual(task);
    expect(service.removeFile).toHaveBeenCalledWith(input);
  });
});
