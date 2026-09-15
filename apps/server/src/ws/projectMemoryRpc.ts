import { PROJECT_MEMORY_WS_METHODS, ProjectMemoryError } from "@ryco/contracts";
import { Effect, Option } from "effect";
import type { ProjectMemoryServiceShape } from "../projectMemory/ProjectMemoryService.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export const makeProjectMemoryHandlers = (ctx: WsRpcContext) => {
  const run = <A>(
    method: string,
    use: (service: ProjectMemoryServiceShape) => Effect.Effect<A, ProjectMemoryError>,
  ) =>
    ctx.withAccess(
      "operator",
      method,
      Option.match(ctx.projectMemory, {
        onNone: () =>
          Effect.fail(
            new ProjectMemoryError({
              reason: "unavailable",
              message: "Project memory is unavailable on this node.",
            }),
          ),
        onSome: use,
      }),
    );
  return defineWsHandlers({
    [PROJECT_MEMORY_WS_METHODS.list]: (input) =>
      run(PROJECT_MEMORY_WS_METHODS.list, (service) => service.list(input)),
    [PROJECT_MEMORY_WS_METHODS.mutate]: (input) =>
      run(PROJECT_MEMORY_WS_METHODS.mutate, (service) =>
        service.mutate(input, ctx.currentSessionId),
      ),
    [PROJECT_MEMORY_WS_METHODS.preview]: (input) =>
      run(PROJECT_MEMORY_WS_METHODS.preview, (service) => service.preview(input)),
    [PROJECT_MEMORY_WS_METHODS.export]: (input) =>
      run(PROJECT_MEMORY_WS_METHODS.export, (service) => service.export(input)),
  });
};
