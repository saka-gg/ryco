import {
  WS_METHODS,
  ProjectId,
  ProviderInstanceId,
  type SessionImportError,
  type AuthRpcError,
} from "@ryco/contracts";
import { expect, it } from "vitest";
import { Effect, Option } from "effect";
import { makeSessionImportHandlers } from "./sessionImportRpc.ts";
import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import { relayRpcPrincipal } from "./RpcPrincipal.ts";
import type { WsRpcContext } from "./context.ts";
import { hostedRoleAllows } from "@ryco/shared/rpcAccessPolicy";
import { resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
it("denies viewers/operators before evaluating source discovery or import", async () => {
  for (const role of ["viewer", "operator", "owner"] as const) {
    let calls = 0;
    const invoke = () =>
      Effect.sync(() => {
        calls++;
        return {};
      });
    const principal = relayRpcPrincipal(role, "fixture");
    const ctx = {
      sessionImport: Option.some({
        discover: invoke,
        importSession: invoke,
        sources: invoke,
        reconcile: invoke,
        adopt: invoke,
      }),
      ownerEffect: <A, E, R>(method: string, effect: Effect.Effect<A, E, R>) =>
        authorizeRpcPrincipal(principal, "owner", method).pipe(Effect.andThen(effect)),
    } as unknown as WsRpcContext;
    const handlers = makeSessionImportHandlers(ctx);
    const input = {
      source: "codex" as const,
      search: "",
      offset: 0,
      includeArchived: false,
      key: "a".repeat(64),
      adoptionToken: "fixture",
      projectId: ProjectId.make("project"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "fixture" },
    };
    for (const method of [
      WS_METHODS.sessionImportDiscover,
      WS_METHODS.sessionImportRun,
      WS_METHODS.sessionImportSources,
      WS_METHODS.sessionImportReconcile,
      WS_METHODS.sessionImportAdopt,
    ]) {
      const run = handlers[method] as (
        request: typeof input,
      ) => Effect.Effect<unknown, SessionImportError | AuthRpcError>;
      expect((await Effect.runPromise(Effect.exit(run(input))))._tag).toBe(
        role === "owner" ? "Success" : "Failure",
      );
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
    expect(calls).toBe(role === "owner" ? 5 : 0);
  }
});
