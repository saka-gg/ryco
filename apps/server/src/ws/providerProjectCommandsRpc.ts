import { Effect, Option } from "effect";
import { type ProviderProjectCommands, WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const EMPTY: ProviderProjectCommands = { skills: [], slashCommands: [] };

export function makeProviderProjectCommandsHandlers(ctx: WsRpcContext) {
  const { projectionSnapshotQuery, projectionWorktrees } = ctx;

  /** Only a directory the node already works in: an active project root or workspace checkout. */
  const isKnownWorkspace = (cwd: string) =>
    projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(cwd).pipe(
      Effect.flatMap((project) =>
        Option.isSome(project)
          ? Effect.succeed(true)
          : projectionWorktrees
              .findActiveByWorktreePath({ worktreePath: cwd })
              .pipe(Effect.map(Option.isSome)),
      ),
      Effect.catch(() => Effect.succeed(false)),
    );

  return defineWsHandlers({
    [WS_METHODS.providerReadProjectCommands]: (input) =>
      observeRpcEffect(
        WS_METHODS.providerReadProjectCommands,
        ctx.ownerEffect(
          WS_METHODS.providerReadProjectCommands,
          Effect.gen(function* () {
            const providerService = Option.getOrUndefined(ctx.providerService);
            if (!providerService?.readProjectCommands) return EMPTY;
            if (!(yield* isKnownWorkspace(input.cwd))) return EMPTY;
            return yield* providerService.readProjectCommands(input.instanceId, input.cwd);
          }),
        ),
        { "rpc.aggregate": "provider" },
      ),
  });
}
