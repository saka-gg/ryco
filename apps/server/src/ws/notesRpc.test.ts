import { Effect, Option } from "effect";
import { NotesError, WS_METHODS } from "@ryco/contracts";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { describe, expect, it, vi } from "vitest";
import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import { relayRpcPrincipal, type RpcPrincipalRole } from "./RpcPrincipal.ts";
import type { WsRpcContext } from "./context.ts";
import { makeNotesHandlers } from "./notesRpc.ts";

const snapshot = { projectId: "project", notes: [], limit: 500, truncated: false };
const listInput = { projectId: "project" };
const commandInput = {
  kind: "delete",
  noteId: "note",
  projectId: "project",
  expectedRevision: 0,
};

function setup(role: RpcPrincipalRole) {
  const principal = relayRpcPrincipal(role, "test-channel");
  const service = {
    list: vi.fn(() => Effect.succeed(snapshot)),
    command: vi.fn(() => Effect.succeed(snapshot)),
  };
  const withAccess = (access: WsRpcAccess, method: string, effect: Effect.Effect<unknown>) =>
    authorizeRpcPrincipal(principal, access, method).pipe(Effect.andThen(effect));
  const ctx = {
    withAccess,
    // Mirrors the context guard: the tier comes from the shared access policy.
    ownerEffect: (method: string, effect: Effect.Effect<unknown>) =>
      withAccess(rpcAccessFor(method) as WsRpcAccess, method, effect),
    worktreeNotesService: Option.some(service),
  } as unknown as WsRpcContext;
  return { service, ctx, handlers: makeNotesHandlers(ctx) };
}
const run = <E>(effect: Effect.Effect<unknown, E>) => Effect.runPromise(effect);

describe("notes RPC", () => {
  it("classifies list as a viewer read and command as an operator mutation", () => {
    expect(rpcAccessFor(WS_METHODS.notesList)).toBe("viewer");
    expect(rpcAccessFor(WS_METHODS.notesCommand)).toBe("operator");
  });

  it.each(["viewer", "operator", "owner"] as const)("lets %s list notes", async (role) => {
    const { handlers, service } = setup(role);
    await expect(run(handlers[WS_METHODS.notesList](listInput as never))).resolves.toEqual(
      snapshot,
    );
    expect(service.list).toHaveBeenCalledWith(listInput);
  });

  it("rejects a viewer before the command reaches storage", async () => {
    const { handlers, service } = setup("viewer");
    await expect(
      run(handlers[WS_METHODS.notesCommand](commandInput as never)),
    ).rejects.toMatchObject({ status: 403 });
    expect(service.command).not.toHaveBeenCalled();
  });

  it.each(["operator", "owner"] as const)("lets %s run commands", async (role) => {
    const { handlers, service } = setup(role);
    await expect(run(handlers[WS_METHODS.notesCommand](commandInput as never))).resolves.toEqual(
      snapshot,
    );
    expect(service.command).toHaveBeenCalledWith(commandInput);
  });

  it("passes typed service failures through", async () => {
    const { handlers, service } = setup("operator");
    service.command.mockReturnValue(
      Effect.fail(new NotesError({ reason: "conflict", message: "Changed" })) as never,
    );
    await expect(
      run(handlers[WS_METHODS.notesCommand](commandInput as never)),
    ).rejects.toMatchObject({ _tag: "NotesError", reason: "conflict" });
  });

  it("fails with a typed error on nodes without notes storage", async () => {
    const { ctx } = setup("owner");
    const handlers = makeNotesHandlers({ ...ctx, worktreeNotesService: Option.none() });
    for (const effect of [
      handlers[WS_METHODS.notesList](listInput as never),
      handlers[WS_METHODS.notesCommand](commandInput as never),
    ])
      await expect(run(effect)).rejects.toMatchObject({
        _tag: "NotesError",
        reason: "persistence",
        message: "Notes are unavailable on this node.",
      });
  });
});
