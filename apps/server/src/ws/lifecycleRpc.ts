import { Effect, Option } from "effect";
import { WorkspaceLifecycleError, WS_METHODS } from "@ryco/contracts";

import type { WorkspaceLifecycleShape } from "../workspace/WorkspaceLifecycle.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export function makeLifecycleHandlers(ctx: WsRpcContext) {
  const service = <A>(
    call: (lifecycle: WorkspaceLifecycleShape) => Effect.Effect<A, WorkspaceLifecycleError>,
  ) =>
    Option.match(ctx.workspaceLifecycle, {
      onNone: () =>
        Effect.fail(
          new WorkspaceLifecycleError({
            detail: "Workspace lifecycle management is unavailable on this node.",
          }),
        ),
      onSome: call,
    });
  return defineWsHandlers({
    [WS_METHODS.lifecycleListWorkspaces]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.lifecycleListWorkspaces,
        service((lifecycle) => lifecycle.list(input.projectId)),
      ),
    [WS_METHODS.lifecyclePreviewWorkspace]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.lifecyclePreviewWorkspace,
        service((lifecycle) => lifecycle.preview(input)),
      ),
    [WS_METHODS.lifecycleApplyWorkspace]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.lifecycleApplyWorkspace,
        service((lifecycle) => lifecycle.apply(input)),
      ),
    [WS_METHODS.lifecycleSuggestions]: () =>
      ctx.ownerEffect(
        WS_METHODS.lifecycleSuggestions,
        service((lifecycle) => lifecycle.suggestions()),
      ),
    [WS_METHODS.lifecycleListTrash]: () =>
      ctx.withAccess(
        "viewer",
        WS_METHODS.lifecycleListTrash,
        service((lifecycle) => lifecycle.listTrash()),
      ),
  });
}
