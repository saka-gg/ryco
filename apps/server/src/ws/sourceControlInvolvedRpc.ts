import { Effect } from "effect";
import { WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

// The cross-repository read loads when it first runs: nothing in it is needed at boot.
const loadInvolvedChangeRequests = Effect.promise(
  () => import("../sourceControl/involvedChangeRequests.ts"),
);

export const makeSourceControlInvolvedHandlers = (ctx: WsRpcContext) =>
  defineWsHandlers({
    [WS_METHODS.sourceControlListInvolvedChangeRequests]: (input) =>
      observeRpcEffect(
        WS_METHODS.sourceControlListInvolvedChangeRequests,
        ctx.ownerEffect(
          WS_METHODS.sourceControlListInvolvedChangeRequests,
          loadInvolvedChangeRequests.pipe(
            Effect.flatMap((module) =>
              module.listInvolvedChangeRequests(
                {
                  resolveHandle: (cwd) => ctx.sourceControlRegistry.resolveHandle({ cwd }),
                  cachedInvolvedList: ctx.gitWorkflow.cachedInvolvedList,
                },
                input,
              ),
            ),
          ),
        ),
        { "rpc.aggregate": "source-control" },
      ),
  });
