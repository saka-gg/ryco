import { Effect, Option, Stream } from "effect";
import {
  ProviderInstanceId,
  type ProviderSignInEvent,
  type ProviderSignInState,
  WS_METHODS,
} from "@ryco/contracts";
import { rpcAccessFor } from "@ryco/shared/rpcAccessPolicy";
import { describe, expect, it, vi } from "vitest";

import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import type { WsRpcContext } from "./context.ts";
import { makeProviderSignInHandlers } from "./providerSignInRpc.ts";
import { relayRpcPrincipal, type RpcPrincipalRole } from "./RpcPrincipal.ts";

const instanceId = ProviderInstanceId.make("codex");
const state: ProviderSignInState = {
  instanceId,
  phase: "waiting",
  flowId: "flow-1",
  method: "codexDeviceCode",
  unavailableReason: null,
  interaction: {
    type: "deviceCode",
    verificationUrl: "https://auth.example.test/codex/device",
    userCode: "FIXT-CODE",
  },
  expiresAt: "2026-10-28T10:15:00.000Z",
  message: null,
};
const respondInput = {
  instanceId,
  flowId: "flow-1",
  action: { type: "cancel" as const },
};

function setup(role: RpcPrincipalRole, available = true) {
  const principal = relayRpcPrincipal(role, "test-channel");
  const service = {
    subscribe: vi.fn(() => Stream.make({ type: "state" as const, state })),
    start: vi.fn(() => Effect.succeed(state)),
    respond: vi.fn(() => Effect.void),
  };
  const withAccess = (access: WsRpcAccess, method: string, effect: Effect.Effect<unknown>) =>
    authorizeRpcPrincipal(principal, access, method).pipe(Effect.andThen(effect));
  const ctx = {
    // Mirror the context guards: the tier comes from the shared access policy.
    ownerEffect: (method: string, effect: Effect.Effect<unknown>) =>
      withAccess(rpcAccessFor(method) as WsRpcAccess, method, effect),
    ownerStream: (method: string, stream: Stream.Stream<unknown>) =>
      Stream.unwrap(
        authorizeRpcPrincipal(principal, rpcAccessFor(method) as WsRpcAccess, method).pipe(
          Effect.as(stream),
        ),
      ),
    providerSignIn: available ? Option.some(Effect.succeed(service)) : Option.none(),
  } as unknown as WsRpcContext;
  return { service, handlers: makeProviderSignInHandlers(ctx) };
}

const run = <E>(effect: Effect.Effect<unknown, E>) => Effect.runPromise(effect);
const collect = (stream: unknown) =>
  Effect.runPromise(Stream.runCollect(stream as Stream.Stream<ProviderSignInEvent, Error>));

describe("provider sign-in RPC", () => {
  it("is owner-only for following, starting and answering a flow", () => {
    expect(rpcAccessFor(WS_METHODS.providerSignInSubscribe)).toBe("owner");
    expect(rpcAccessFor(WS_METHODS.providerSignInStart)).toBe("owner");
    expect(rpcAccessFor(WS_METHODS.providerSignInRespond)).toBe("owner");
  });

  it("lets an owner follow, start and cancel a flow by instance id", async () => {
    const { handlers, service } = setup("owner");

    await expect(
      collect(handlers[WS_METHODS.providerSignInSubscribe]({ instanceId })),
    ).resolves.toEqual([{ type: "state", state }]);
    await expect(run(handlers[WS_METHODS.providerSignInStart]({ instanceId }))).resolves.toEqual(
      state,
    );
    await expect(
      run(handlers[WS_METHODS.providerSignInRespond](respondInput)),
    ).resolves.toBeUndefined();
    expect(service.subscribe).toHaveBeenCalledWith(instanceId);
    expect(service.start).toHaveBeenCalledWith(instanceId);
    expect(service.respond).toHaveBeenCalledWith(respondInput);
  });

  it.each(["viewer", "operator"] as const)(
    "rejects %s before the device code or a flow is reached",
    async (role) => {
      const { handlers, service } = setup(role);

      await expect(
        collect(handlers[WS_METHODS.providerSignInSubscribe]({ instanceId })),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        run(handlers[WS_METHODS.providerSignInStart]({ instanceId })),
      ).rejects.toMatchObject({ status: 403 });
      await expect(
        run(handlers[WS_METHODS.providerSignInRespond](respondInput)),
      ).rejects.toMatchObject({ status: 403 });
      expect(service.subscribe).not.toHaveBeenCalled();
      expect(service.start).not.toHaveBeenCalled();
      expect(service.respond).not.toHaveBeenCalled();
    },
  );

  it("answers a node built without sign-in with an error, not a defect", async () => {
    const { handlers } = setup("owner", false);

    await expect(run(handlers[WS_METHODS.providerSignInStart]({ instanceId }))).rejects.toThrow(
      "Sign-in is unavailable on this node.",
    );
  });
});
