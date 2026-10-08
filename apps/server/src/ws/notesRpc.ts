import { Effect, Option } from "effect";
import { NotesError, WS_METHODS } from "@ryco/contracts";
import type { WorktreeNotesServiceShape } from "../notes/WorktreeNotesService.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export function makeNotesHandlers(ctx: WsRpcContext) {
  const service: Effect.Effect<WorktreeNotesServiceShape, NotesError> = Option.match(
    ctx.worktreeNotesService,
    {
      onNone: () =>
        Effect.fail(
          new NotesError({ reason: "persistence", message: "Notes are unavailable on this node." }),
        ),
      onSome: Effect.succeed,
    },
  );
  return defineWsHandlers({
    [WS_METHODS.notesList]: (input) =>
      ctx.withAccess(
        "viewer",
        WS_METHODS.notesList,
        service.pipe(Effect.flatMap((notes) => notes.list(input))),
      ),
    // Operator tier, from the shared access policy.
    [WS_METHODS.notesCommand]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.notesCommand,
        service.pipe(Effect.flatMap((notes) => notes.command(input))),
      ),
  });
}
