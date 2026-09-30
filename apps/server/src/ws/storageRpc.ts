import { Effect, Option } from "effect";
import { StorageError, WS_METHODS } from "@ryco/contracts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export function makeStorageHandlers(ctx: WsRpcContext) {
  const service = <A>(
    call: (
      storage: NonNullable<typeof ctx.storageService extends Option.Option<infer S> ? S : never>,
    ) => Effect.Effect<A, StorageError>,
  ) =>
    Option.match(ctx.storageService, {
      onNone: () =>
        Effect.fail(
          new StorageError({ detail: "Storage management is unavailable on this node." }),
        ),
      onSome: call,
    });
  return defineWsHandlers({
    [WS_METHODS.storageScan]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.storageScan,
        service((storage) => storage.scan(input.projectId, input.cursor)),
      ),
    [WS_METHODS.storagePreview]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.storagePreview,
        service((storage) => storage.preview(ctx.storagePrincipalKey, input.entryIds)),
      ),
    [WS_METHODS.storageExecute]: (input) =>
      ctx.ownerEffect(
        WS_METHODS.storageExecute,
        service((storage) => storage.execute(ctx.storagePrincipalKey, input.token)),
      ),
  });
}
