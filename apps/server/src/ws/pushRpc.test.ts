import { Effect, Option } from "effect";
import { type AuthRpcError, type PushRpcError, WS_METHODS } from "@ryco/contracts";
import { describe, expect, it, vi } from "vitest";

import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";
import type { NodePushRegistryShape } from "../push/NodePushRegistry.ts";
import type { WsRpcContext } from "./context.ts";
import { makePushHandlers } from "./pushRpc.ts";
import {
  relayRpcPrincipal,
  type RelayChannelAuthority,
  type RpcPrincipal,
} from "./RpcPrincipal.ts";

const input = {
  keyId: "AAAAAAAAAAAAAAAAAAAAAA",
  publicKey: "x".repeat(43),
  kinds: ["completed" as const],
  sound: true,
};
const fingerprint = new Uint8Array(32);

function setup(principal: RpcPrincipal, withRegistry = true) {
  const registry = {
    register: vi.fn(() =>
      Effect.succeed({
        eligible: true,
        registered: true,
        keyId: input.keyId,
        kinds: ["completed" as const],
        hubDelivery: "unknown" as const,
      }),
    ),
    unregister: vi.fn(() => Effect.succeed({ removed: true })),
    setPresence: vi.fn(() =>
      Effect.succeed({
        eligible: true,
        registered: true,
        keyId: input.keyId,
        kinds: ["completed" as const],
        hubDelivery: "available" as const,
      }),
    ),
  };
  const ctx = {
    withAccess: (access: WsRpcAccess, method: string, effect: Effect.Effect<unknown>) =>
      authorizeRpcPrincipal(principal, access, method).pipe(Effect.andThen(effect)),
    nodePushRegistry: withRegistry
      ? Option.some(registry as unknown as NodePushRegistryShape)
      : Option.none(),
    relayAuthority: (): RelayChannelAuthority =>
      principal.relayAuthority?.() ?? { trustSource: "none" },
  } as unknown as WsRpcContext;
  return { registry, handlers: makePushHandlers(ctx) };
}

const enrolled = (role: "viewer" | "owner") =>
  relayRpcPrincipal(role, "channel", () => ({
    trustSource: "account-enrolled",
    enrollmentId: "enr_device00000000000000000",
    clientIdentityFingerprint: fingerprint,
    role,
  }));

const run = (effect: Effect.Effect<unknown, AuthRpcError | PushRpcError>) =>
  Effect.runPromise(effect);

describe("push RPCs", () => {
  it("registers the device the channel's grant names, at the channel's role", async () => {
    const { handlers, registry } = setup(enrolled("viewer"));
    await run(handlers[WS_METHODS.pushRegisterDevice](input));
    expect(registry.register).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentId: "enr_device00000000000000000", role: "viewer" }),
      input,
    );
    // Presence answers the registration as the node holds it, so the app need not register again.
    expect(await run(handlers[WS_METHODS.pushSetPresence]({ state: "foreground" }))).toEqual({
      status: expect.objectContaining({ registered: true, keyId: input.keyId }),
    });
    expect(registry.setPresence).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentId: "enr_device00000000000000000" }),
      "foreground",
    );
    // A retired key's public half reaches the registry.
    const retire = { keyId: input.keyId, publicKey: input.publicKey };
    await run(handlers[WS_METHODS.pushUnregisterDevice](retire));
    expect(registry.unregister).toHaveBeenCalledWith(
      expect.objectContaining({ enrollmentId: "enr_device00000000000000000" }),
      retire,
    );
  });

  it("refuses a locally approved device: the Hub cannot route to it", async () => {
    const { handlers, registry } = setup(
      relayRpcPrincipal("owner", "channel", () => ({
        trustSource: "locally-verified",
        clientIdentityFingerprint: fingerprint,
        role: "owner",
      })),
    );
    await expect(run(handlers[WS_METHODS.pushRegisterDevice](input))).rejects.toMatchObject({
      _tag: "PushRpcError",
    });
    expect(registry.register).not.toHaveBeenCalled();
  });

  it("refuses a channel without an E2EE device and a connection without the registry", async () => {
    await expect(
      run(
        setup(relayRpcPrincipal("owner", "channel")).handlers[WS_METHODS.pushRegisterDevice](input),
      ),
    ).rejects.toMatchObject({ _tag: "AuthRpcError" });
    await expect(
      run(
        setup(enrolled("owner"), false).handlers[WS_METHODS.pushUnregisterDevice]({
          keyId: input.keyId,
        }),
      ),
    ).rejects.toMatchObject({ _tag: "PushRpcError" });
  });
});
