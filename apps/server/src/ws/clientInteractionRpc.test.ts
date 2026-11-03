import { Effect, Option } from "effect";
import { WS_METHODS } from "@ryco/contracts";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { describe, expect, it } from "vitest";

import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import type { WsRpcContext } from "./context.ts";
import { makeClientInteractionHandlers } from "./clientInteractionRpc.ts";
import { relayRpcPrincipal, type RpcPrincipalRole } from "./RpcPrincipal.ts";

function setup(role: RpcPrincipalRole, available = true) {
  const noted: Array<string> = [];
  const principal = relayRpcPrincipal(role, "test-channel");
  const ctx = {
    withAccess: (access: WsRpcAccess, method: string, effect: Effect.Effect<unknown>) =>
      authorizeRpcPrincipal(principal, access, method).pipe(Effect.andThen(effect)),
    currentSessionId: "relay-scope-test-channel",
    clientInteraction: available
      ? Option.some({
          note: (sessionKey: string) => Effect.sync(() => noted.push(sessionKey)),
          sinceLast: Effect.die("unused"),
        })
      : Option.none(),
  } as unknown as WsRpcContext;
  return { noted, handlers: makeClientInteractionHandlers(ctx) };
}

const call = (handlers: ReturnType<typeof setup>["handlers"]) =>
  Effect.runPromise(handlers[WS_METHODS.serverNoteClientInteraction]({}));

describe("client interaction RPC", () => {
  it("is open to every role, since it can only delay an update", () => {
    expect(rpcAccessFor(WS_METHODS.serverNoteClientInteraction)).toBe("viewer");
  });

  it.each(["viewer", "operator", "owner"] as const)(
    "records the session's input for a %s",
    async (role) => {
      const { noted, handlers } = setup(role);
      await expect(call(handlers)).resolves.toEqual({});
      expect(noted).toEqual(["relay-scope-test-channel"]);
    },
  );

  it("answers without recording on a node that keeps no interaction time", async () => {
    const { noted, handlers } = setup("owner", false);
    await expect(call(handlers)).resolves.toEqual({});
    expect(noted).toEqual([]);
  });
});
