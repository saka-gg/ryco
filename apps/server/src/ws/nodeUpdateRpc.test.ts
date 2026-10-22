import { Effect, Option, Stream } from "effect";
import { NodeUpdateError, type NodeUpdateState, WS_METHODS } from "@ryco/contracts";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { describe, expect, it, vi } from "vitest";

import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import { IDLE_NODE_UPDATE_RUN } from "../nodeUpdate/NodeUpdateService.ts";
import type { WsRpcContext } from "./context.ts";
import { makeNodeUpdateHandlers } from "./nodeUpdateRpc.ts";
import { relayRpcPrincipal, type RpcPrincipalRole } from "./RpcPrincipal.ts";

const state: NodeUpdateState = {
  currentVersion: "0.1.35",
  latestVersion: "0.1.36",
  channel: "latest",
  availability: "behind_latest",
  installation: { kind: "npm-global", service: "launchd" },
  canUpdate: true,
  manualReason: null,
  manualCommand: null,
  checkedAt: "2026-10-21T10:00:00.000Z",
  run: IDLE_NODE_UPDATE_RUN,
};
const updateInput = { targetVersion: "0.1.36", requestId: "update-1" };

function setup(role: RpcPrincipalRole, available = true) {
  const principal = relayRpcPrincipal(role, "test-channel");
  const service = {
    current: Effect.succeed(state),
    changes: Stream.make(state),
    check: Effect.succeed(state),
    update: vi.fn(() => Effect.succeed(state)),
  };
  const checked = vi.fn();
  const withAccess = (access: WsRpcAccess, method: string, effect: Effect.Effect<unknown>) =>
    authorizeRpcPrincipal(principal, access, method).pipe(Effect.andThen(effect));
  const ctx = {
    withAccess,
    // Mirrors the context guard: the tier comes from the shared access policy.
    ownerEffect: (method: string, effect: Effect.Effect<unknown>) =>
      withAccess(rpcAccessFor(method) as WsRpcAccess, method, effect),
    nodeUpdate: available
      ? Option.some({ ...service, check: Effect.sync(checked).pipe(Effect.as(state)) })
      : Option.none(),
  } as unknown as WsRpcContext;
  return { service, checked, handlers: makeNodeUpdateHandlers(ctx) };
}
const run = <E>(effect: Effect.Effect<unknown, E>) => Effect.runPromise(effect);
const collect = (stream: unknown) =>
  Effect.runPromise(Stream.runCollect(stream as Stream.Stream<NodeUpdateState, NodeUpdateError>));

describe("node update RPC", () => {
  it("lets any session follow the state and only owners check or update", () => {
    expect(rpcAccessFor(WS_METHODS.serverSubscribeNodeUpdate)).toBe("viewer");
    expect(rpcAccessFor(WS_METHODS.serverCheckNodeUpdate)).toBe("owner");
    expect(rpcAccessFor(WS_METHODS.serverUpdateNode)).toBe("owner");
  });

  it.each(["viewer", "operator", "owner"] as const)("streams the state to %s", async (role) => {
    const { handlers } = setup(role);
    await expect(collect(handlers[WS_METHODS.serverSubscribeNodeUpdate]({}))).resolves.toEqual([
      state,
    ]);
  });

  it.each(["viewer", "operator"] as const)(
    "rejects %s before a check or update reaches the node",
    async (role) => {
      const { handlers, service, checked } = setup(role);
      await expect(run(handlers[WS_METHODS.serverCheckNodeUpdate]({}))).rejects.toMatchObject({
        status: 403,
      });
      await expect(
        run(handlers[WS_METHODS.serverUpdateNode](updateInput as never)),
      ).rejects.toMatchObject({ status: 403 });
      expect(checked).not.toHaveBeenCalled();
      expect(service.update).not.toHaveBeenCalled();
    },
  );

  it("passes an owner's check and update to the node", async () => {
    const { handlers, service, checked } = setup("owner");
    await expect(run(handlers[WS_METHODS.serverCheckNodeUpdate]({}))).resolves.toEqual(state);
    await expect(run(handlers[WS_METHODS.serverUpdateNode](updateInput as never))).resolves.toEqual(
      state,
    );
    expect(checked).toHaveBeenCalledOnce();
    expect(service.update).toHaveBeenCalledWith(updateInput);
  });

  it("answers with a node update error where the service is absent", async () => {
    const { handlers } = setup("owner", false);
    const failure = await run(
      Effect.flip(handlers[WS_METHODS.serverUpdateNode](updateInput as never)),
    );
    expect(failure).toBeInstanceOf(NodeUpdateError);
  });
});
