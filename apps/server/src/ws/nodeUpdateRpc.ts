import { Effect, Option } from "effect";
import { NodeUpdateError, WS_METHODS } from "@ryco/contracts";

import type { NodeUpdateServiceShape } from "../nodeUpdate/NodeUpdateService.ts";
import { observeRpcEffect, observeRpcStreamEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";

/**
 * The node's own release and its one-click update. Following the state is a viewer read;
 * checking and updating are owner calls. Each tier comes from the shared access policy.
 */
export function makeNodeUpdateHandlers(ctx: WsRpcContext) {
  const service: Effect.Effect<NodeUpdateServiceShape, NodeUpdateError> = Option.match(
    ctx.nodeUpdate,
    {
      onNone: () =>
        Effect.fail(new NodeUpdateError({ reason: "Node updates are unavailable on this node." })),
      onSome: Effect.succeed,
    },
  );
  return defineWsHandlers({
    [WS_METHODS.serverSubscribeNodeUpdate]: (_input) =>
      observeRpcStreamEffect(
        WS_METHODS.serverSubscribeNodeUpdate,
        ctx.withAccess(
          rpcAccessFor(WS_METHODS.serverSubscribeNodeUpdate),
          WS_METHODS.serverSubscribeNodeUpdate,
          Effect.map(service, (nodeUpdate) => nodeUpdate.changes),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverCheckNodeUpdate]: (_input) =>
      observeRpcEffect(
        WS_METHODS.serverCheckNodeUpdate,
        ctx.ownerEffect(
          WS_METHODS.serverCheckNodeUpdate,
          Effect.flatMap(service, (nodeUpdate) => nodeUpdate.check),
        ),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverUpdateNode]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverUpdateNode,
        ctx.ownerEffect(
          WS_METHODS.serverUpdateNode,
          Effect.flatMap(service, (nodeUpdate) => nodeUpdate.update(input)),
        ),
        { "rpc.aggregate": "server" },
      ),
  });
}
