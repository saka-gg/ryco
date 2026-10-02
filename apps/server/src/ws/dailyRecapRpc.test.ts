import { Effect, Option } from "effect";
import { DailyRecapReadError, WS_METHODS, type DailyRecapRequest } from "@ryco/contracts";
import { hostedRoleAllows, rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { describe, expect, it } from "vitest";

import { authorizeRpcPrincipal } from "../auth/wsAuthorization.ts";
import type { RpcPrincipal, RpcPrincipalRole } from "./RpcPrincipal.ts";
import type { WsRpcContext } from "./context.ts";
import { makeDailyRecapHandlers } from "./dailyRecapRpc.ts";

const input = { date: "2026-10-02", timeZone: "Europe/Berlin", limit: 7 };
const method = WS_METHODS.serverGetDailyRecap;
const ownerEffect =
  (role: RpcPrincipalRole) => (rpcMethod: string, effect: Effect.Effect<unknown>) =>
    authorizeRpcPrincipal(
      {
        role,
        transport: "relay",
        scopeId: "test",
        canManageLocalAccess: false,
      } satisfies RpcPrincipal,
      "owner",
      rpcMethod,
    ).pipe(Effect.andThen(effect));

describe("daily recap RPC", () => {
  it("keeps all-project recaps owner-only in shared hosted access policy", () => {
    expect(rpcAccessFor(method)).toBe("owner");
    expect(hostedRoleAllows("viewer", method)).toBe(false);
    expect(hostedRoleAllows("operator", method)).toBe(false);
    expect(hostedRoleAllows("owner", method)).toBe(true);
  });

  for (const role of ["viewer", "operator"] as const) {
    it(`denies ${role} before running the recap query`, async () => {
      let queried = false;
      const handlers = makeDailyRecapHandlers({
        ownerEffect: ownerEffect(role),
        dailyRecapQuery: Option.some({
          getDailyRecap: () =>
            Effect.sync(() => {
              queried = true;
            }),
        }),
      } as unknown as WsRpcContext);
      await expect(Effect.runPromise(handlers[method](input))).rejects.toMatchObject({
        status: 403,
      });
      expect(queried).toBe(false);
    });
  }

  it("forwards the owner's requested calendar day, zone and cap without alteration", async () => {
    let received: DailyRecapRequest | undefined;
    const empty = { totalThreads: 0, threads: [], truncated: false };
    const snapshot = {
      ...input,
      from: "2026-10-01T22:00:00.000Z",
      to: "2026-10-02T22:00:00.000Z",
      generatedAt: "2026-10-03T00:00:00.000Z",
      counts: { completedTurns: 0, failedTurns: 0, interruptedTurns: 0 },
      completed: empty,
      failed: empty,
      needsAttention: empty,
    };
    const handlers = makeDailyRecapHandlers({
      ownerEffect: ownerEffect("owner"),
      dailyRecapQuery: Option.some({
        getDailyRecap: (request: DailyRecapRequest) =>
          Effect.sync(() => {
            received = request;
            return snapshot;
          }),
      }),
    } as unknown as WsRpcContext);
    expect(await Effect.runPromise(handlers[method](input))).toEqual(snapshot);
    expect(received).toEqual(input);
  });

  it("returns a typed unavailable error when the node lacks a recap query", async () => {
    const handlers = makeDailyRecapHandlers({
      ownerEffect: ownerEffect("owner"),
      dailyRecapQuery: Option.none(),
    } as unknown as WsRpcContext);
    await expect(Effect.runPromise(handlers[method](input))).rejects.toMatchObject({
      _tag: "DailyRecapReadError",
      reason: "query-failed",
    });
  });

  it("preserves typed validation errors from the query", async () => {
    const error = new DailyRecapReadError({ reason: "invalid-date", detail: "Invalid day." });
    const handlers = makeDailyRecapHandlers({
      ownerEffect: ownerEffect("owner"),
      dailyRecapQuery: Option.some({ getDailyRecap: () => Effect.fail(error) }),
    } as unknown as WsRpcContext);
    await expect(Effect.runPromise(handlers[method](input))).rejects.toBe(error);
  });
});
