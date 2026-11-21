import { WS_METHODS } from "@ryco/contracts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { findThreadInArray } from "../orchestration/threadIndex.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

// The request module loads with the first answer: nothing in it is needed at boot.
const loadUserActionRequests = Effect.promise(
  () => import("../userActionRequests/userActionRequests.ts"),
);

/**
 * `userActions.answerRequest`: the owner's Done or Won't do on an agent's user action request (a
 * browser tab or terminal handed to them), checked against the owner tier before the module
 * loads. Ending the request gives the tab or terminal back to the agent through its surface.
 */
export const makeUserActionRequestHandlers = (ctx: WsRpcContext) =>
  defineWsHandlers({
    [WS_METHODS.userActionsAnswerRequest]: (input) =>
      observeRpcEffect(
        WS_METHODS.userActionsAnswerRequest,
        ctx.ownerEffect(
          WS_METHODS.userActionsAnswerRequest,
          loadUserActionRequests.pipe(
            Effect.flatMap((module) =>
              module.answerUserActionRequest(
                { engine: ctx.orchestrationEngine, findThreadInArray },
                input,
              ),
            ),
          ),
        ),
        { "rpc.aggregate": "user-action-requests", "rpc.operation": input.answer },
      ),
  });
