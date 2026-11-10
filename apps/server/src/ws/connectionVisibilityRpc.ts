import { Effect } from "effect";
import { WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";
import { rpcAccessFor } from "./RpcAccessPolicy.ts";

/**
 * `server.setConnectionVisibility`: the client of this connection went to the background or came
 * back (`connectionVisibility.ts`). It changes only what this connection is sent.
 */

export const makeConnectionVisibilityHandlers = (ctx: WsRpcContext) =>
  defineWsHandlers({
    [WS_METHODS.serverSetConnectionVisibility]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverSetConnectionVisibility,
        ctx.withAccess(
          rpcAccessFor(WS_METHODS.serverSetConnectionVisibility),
          WS_METHODS.serverSetConnectionVisibility,
          Effect.sync(() => {
            ctx.connectionVisibility.set(input.visibility);
            return {};
          }),
        ),
        { "rpc.aggregate": "server" },
      ),
  });
