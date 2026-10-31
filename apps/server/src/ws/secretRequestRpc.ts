import { WS_METHODS } from "@ryco/contracts";
import { Effect } from "effect";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { findThreadInArray } from "../orchestration/threadIndex.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

// The answer path (and the dotenv writer) loads with the first answer: nothing in it is needed
// at boot.
const loadSecretRequests = Effect.promise(() => import("../secretRequests/secretRequests.ts"));

/**
 * `secrets.answerRequest`: the owner's answer to an agent's `ryco_request_secret`, checked
 * against the owner tier before the module loads. The input's value goes only into the
 * request's dotenv file: no trace attribute, log line or response names it. A value is taken
 * only over a connection the node saw as encrypted (`ctx.connection`, from the principal).
 */
export const makeSecretRequestHandlers = (ctx: WsRpcContext) =>
  defineWsHandlers({
    [WS_METHODS.secretsAnswerRequest]: (input) =>
      observeRpcEffect(
        WS_METHODS.secretsAnswerRequest,
        ctx.ownerEffect(
          WS_METHODS.secretsAnswerRequest,
          loadSecretRequests.pipe(
            Effect.flatMap((module) =>
              module.answerSecretRequest(
                {
                  engine: ctx.orchestrationEngine,
                  projections: ctx.projectionSnapshotQuery,
                  workspaceAccess: ctx.workspaceAccessPolicy,
                  findThreadInArray,
                },
                input,
                ctx.connection,
              ),
            ),
          ),
        ),
        { "rpc.aggregate": "secret-requests", "rpc.operation": input.answer.type },
      ),
  });
