import { Effect, Option } from "effect";
import { PushRpcError, WS_METHODS } from "@ryco/contracts";

import type { NodePushRegistryShape, PushDeviceIdentity } from "../push/NodePushRegistry.ts";
import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

/**
 * A native device's push alerts on this node (`docs/push-alerts.md`). The Hub
 * routes push by device enrollment, so only an account-enrolled relay channel
 * qualifies, and the device comes from that channel's verified grant, never
 * from the request: a device can only register itself. The Hub connector
 * provides the registry to relay channels alone.
 */
export function makePushHandlers(ctx: WsRpcContext) {
  const forDevice = <A>(
    method: string,
    use: (registry: NodePushRegistryShape, device: PushDeviceIdentity) => Effect.Effect<A>,
  ) =>
    observeRpcEffect(
      method,
      ctx.withAccess(
        "relay_native",
        method,
        Effect.suspend(() => {
          const authority = ctx.relayAuthority();
          return Option.isSome(ctx.nodePushRegistry) && authority.trustSource === "account-enrolled"
            ? use(ctx.nodePushRegistry.value, authority)
            : Effect.fail(
                new PushRpcError({
                  message: "Push alerts need a device signed in to this node's Hub.",
                }),
              );
        }),
      ),
      { "rpc.aggregate": "push" },
    );
  return defineWsHandlers({
    [WS_METHODS.pushRegisterDevice]: (input) =>
      forDevice(WS_METHODS.pushRegisterDevice, (registry, device) =>
        registry.register(device, input),
      ),
    [WS_METHODS.pushUnregisterDevice]: (input) =>
      forDevice(WS_METHODS.pushUnregisterDevice, (registry, device) =>
        registry.unregister(device, input.keyId),
      ),
    [WS_METHODS.pushSetPresence]: (input) =>
      forDevice(WS_METHODS.pushSetPresence, (registry, device) =>
        registry.setPresence(device, input.state).pipe(Effect.as({})),
      ),
  });
}
