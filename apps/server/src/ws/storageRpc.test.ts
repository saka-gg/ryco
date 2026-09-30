import { expect, it } from "vitest";
import { Effect, Option } from "effect";
import { WS_METHODS, type AuthRpcError, type StorageError } from "@ryco/contracts";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";
import { resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { relayRpcPrincipal } from "./RpcPrincipal.ts";
import { makeStorageHandlers } from "./storageRpc.ts";
import type { WsRpcContext } from "./context.ts";

it("gates storage reads and cleanup by current node owner before evaluating the service", async () => {
  for (const role of ["viewer", "operator", "owner"] as const) {
    let calls = 0;
    const invoke = () =>
      Effect.sync(() => {
        calls++;
        return {};
      });
    const principal = relayRpcPrincipal(role, "fixture");
    const handlers = makeStorageHandlers({
      storageService: Option.some({ scan: invoke, preview: invoke, execute: invoke }),
      storagePrincipalKey: "relay:fixture",
      ownerEffect: <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
        authorizeRpcPrincipal(principal, "owner", method).pipe(Effect.andThen(effect)),
    } as unknown as WsRpcContext);
    for (const method of [
      WS_METHODS.storageScan,
      WS_METHODS.storagePreview,
      WS_METHODS.storageExecute,
    ]) {
      const run = handlers[method] as (
        input: object,
      ) => Effect.Effect<unknown, AuthRpcError | StorageError>;
      expect(
        (
          await Effect.runPromise(
            Effect.exit(
              run({
                entryIds: ["fixture"],
                token: "fixture",
                confirmation: "delete reviewed data",
              }),
            ),
          )
        )._tag,
      ).toBe(role === "owner" ? "Success" : "Failure");
      expect(hostedRoleAllows(role, method)).toBe(role === "owner");
      expect(
        resolveHostedRpcCapability({
          hosted: true,
          role,
          fresh: false,
          browserCurrent: true,
          sessionReady: true,
          method,
        }).allowed,
      ).toBe(false);
    }
    expect(calls).toBe(role === "owner" ? 3 : 0);
  }
});
