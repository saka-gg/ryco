import { Effect, Option } from "effect";
import { WS_METHODS, LocalTaskError, OrchestrationDispatchCommandError } from "@ryco/contracts";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import type { RpcPrincipal, RpcPrincipalRole } from "./RpcPrincipal.ts";
import type { WsRpcContext } from "./context.ts";
import { makeLocalTaskHandlers } from "./localTaskRpc.ts";

const { apply, normalize } = vi.hoisted(() => ({ apply: vi.fn(), normalize: vi.fn() }));
vi.mock("../orchestration/Layers/OrchestrationCommandApplication.ts", () => ({
  applyOrchestrationNormalizedCommand: apply,
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
] as const;
const ownerEffect = (role: RpcPrincipalRole) => (method: string, effect: Effect.Effect<unknown>) =>
  authorizeRpcPrincipal(
    {
      role,
      transport: "relay",
      scopeId: "test",
      canManageLocalAccess: false,
    } satisfies RpcPrincipal,
    "owner",
    method,
  ).pipe(Effect.andThen(effect));
const input = { taskId: "task", expectedRevision: 0, command: { commandId: "command" } };
const task = { taskId: "task", revision: 2, status: "starting" };
const reservation = {
  task,
  command: { commandId: "command", threadId: "thread" },
  replayed: false,
};
function setup(role: RpcPrincipalRole = "owner") {
  const calls: string[] = [];
  const service = {
    getAcceptedDelegation: vi.fn(() => Effect.succeed(null)),
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
    reserveDelegation: vi.fn(() =>
      Effect.sync(() => {
        calls.push("reserve");
        return reservation;
      }),
    ),
    markDelegated: vi.fn(() =>
      Effect.sync(() => {
        calls.push("mark");
        return task;
      }),
    ),
  };
  normalize.mockReturnValue(Effect.succeed(reservation.command));
  apply.mockImplementation(() =>
    Effect.sync(() => {
      calls.push("dispatch");
    }),
  );
  const ctx = {
    ownerEffect: ownerEffect(role),
    localTaskService: Option.some(service),
    dispatchNormalizedCommand: vi.fn(),
    projectionSnapshotQuery: {},
    terminalManager: {},
  } as unknown as WsRpcContext;
  return { calls, service, ctx, handlers: makeLocalTaskHandlers(ctx) };
}
describe("local task RPC", () => {
  beforeEach(() => vi.clearAllMocks());
  for (const role of ["viewer", "operator"] as const) {
    it(`rejects ${role} before task reads or mutations`, async () => {
      const { calls, handlers, service } = setup(role);
      for (const method of methods) {
        expect(rpcAccessFor(method)).toBe("owner");
        await expect(runMocked(handlers[method](input as never))).rejects.toMatchObject({
          status: 403,
        });
      }
      expect(calls).toEqual([]);
      expect(service.reserveDelegation).not.toHaveBeenCalled();
      expect(apply).not.toHaveBeenCalled();
    });
  }
  it("reserves durably, dispatches the stored command through normal orchestration, then marks it", async () => {
    const { calls, handlers, ctx, service } = setup();
    expect(await runMocked(handlers[WS_METHODS.serverDelegateLocalTask](input as never))).toEqual(
      task,
    );
    expect(calls).toEqual(["reserve", "dispatch", "mark"]);
    expect(apply).toHaveBeenCalledWith(
      expect.objectContaining({
        command: reservation.command,
        dispatch: ctx.dispatchNormalizedCommand,
        projections: ctx.projectionSnapshotQuery,
        terminals: ctx.terminalManager,
      }),
    );
    expect(service.markDelegated).toHaveBeenCalledWith({ taskId: "task", commandId: "command" });
  });
  it("returns an accepted replay without touching attachments or dispatching again", async () => {
    const { handlers, service } = setup();
    service.getAcceptedDelegation.mockReturnValue(Effect.succeed(task) as never);
    expect(await runMocked(handlers[WS_METHODS.serverDelegateLocalTask](input as never))).toEqual(
      task,
    );
    expect(normalize).not.toHaveBeenCalled();
    expect(service.reserveDelegation).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  it("does not reserve a task when command normalization fails", async () => {
    const { handlers, service } = setup();
    normalize.mockReturnValue(
      Effect.fail(new OrchestrationDispatchCommandError({ message: "Invalid attachment" })),
    );
    await expect(
      runMocked(handlers[WS_METHODS.serverDelegateLocalTask](input as never)),
    ).rejects.toMatchObject({ message: "Invalid attachment" });
    expect(service.reserveDelegation).not.toHaveBeenCalled();
    expect(apply).not.toHaveBeenCalled();
  });
  it("leaves an ambiguous dispatch reserved for identical explicit retry", async () => {
    const { calls, handlers, service } = setup();
    const error = new OrchestrationDispatchCommandError({ message: "Disconnected" });
    apply.mockReturnValue(Effect.fail(error));
    await expect(
      runMocked(handlers[WS_METHODS.serverDelegateLocalTask](input as never)),
    ).rejects.toBe(error);
    expect(calls).toEqual(["reserve"]);
    expect(service.markDelegated).not.toHaveBeenCalled();
  });
  it("never dispatches if reservation conflicts", async () => {
    const { handlers, service } = setup();
    service.reserveDelegation.mockReturnValue(
      Effect.fail(new LocalTaskError({ reason: "conflict", message: "Changed" })) as never,
    );
    await expect(
      runMocked(handlers[WS_METHODS.serverDelegateLocalTask](input as never)),
    ).rejects.toMatchObject({ reason: "conflict" });
    expect(apply).not.toHaveBeenCalled();
  });
  it("fails with a typed error on nodes without task storage", async () => {
    const { ctx } = setup();
    const handlers = makeLocalTaskHandlers({ ...ctx, localTaskService: Option.none() });
    await expect(runMocked(handlers[WS_METHODS.serverListLocalTasks]({}))).rejects.toMatchObject({
      _tag: "LocalTaskError",
      reason: "persistence",
    });
  });
});
