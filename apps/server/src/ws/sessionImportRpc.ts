import { SessionImportError, WS_METHODS } from "@ryco/contracts";
import { Effect, Option } from "effect";
import type { SessionImportShape } from "../imports/SessionImport.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";
export const makeSessionImportHandlers = (ctx: WsRpcContext) => {
  const service = (): Effect.Effect<SessionImportShape, SessionImportError> =>
    Option.match(ctx.sessionImport, {
      onNone: () =>
        Effect.fail(
          new SessionImportError({
            message: "Local history import is unavailable on this server.",
          }),
        ),
      onSome: Effect.succeed,
    });
  return defineWsHandlers({
    [WS_METHODS.sessionImportSources]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.sessionImportSources,
        service().pipe(Effect.flatMap((importer) => importer.sources(input))),
      ),
    [WS_METHODS.sessionImportReconcile]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.sessionImportReconcile,
        service().pipe(Effect.flatMap((importer) => importer.reconcile(input))),
      ),
    [WS_METHODS.sessionImportAdopt]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.sessionImportAdopt,
        service().pipe(Effect.flatMap((importer) => importer.adopt(input))),
      ),
    [WS_METHODS.sessionImportDiscover]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.sessionImportDiscover,
        service().pipe(Effect.flatMap((importer) => importer.discover(input))),
      ),
    [WS_METHODS.sessionImportRun]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.sessionImportRun,
        service().pipe(Effect.flatMap((importer) => importer.importSession(input))),
      ),
  });
};
