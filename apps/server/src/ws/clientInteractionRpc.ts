import { Effect, Option } from "effect";
import { WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";

/**
 * `server.noteClientInteraction`: a person is using a client, so unattended updates wait. Any
 * role may report it (the tier comes from the shared access policy); it only records a time, at
 * most once per 15 s per session, and answers the same whether or not it counted.
 */
export function makeClientInteractionHandlers(ctx: WsRpcContext) {
  return defineWsHandlers({
    [WS_METHODS.serverNoteClientInteraction]: (_input) =>
      observeRpcEffect(
        WS_METHODS.serverNoteClientInteraction,
        ctx.withAccess(
          rpcAccessFor(WS_METHODS.serverNoteClientInteraction),
          WS_METHODS.serverNoteClientInteraction,
          Option.match(ctx.clientInteraction, {
            onNone: () => Effect.void,
            onSome: (clientInteraction) => clientInteraction.note(ctx.currentSessionId),
          }).pipe(Effect.as({})),
        ),
        { "rpc.aggregate": "server" },
      ),
  });
}
