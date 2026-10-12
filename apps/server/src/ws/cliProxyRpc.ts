import { WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export const makeCliProxyHandlers = (ctx: WsRpcContext) => {
  const { cliProxyService, ownerEffect } = ctx;

  return defineWsHandlers({
    [WS_METHODS.serverReadCliProxyHubs]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverReadCliProxyHubs,
        ownerEffect(WS_METHODS.serverReadCliProxyHubs, cliProxyService.readHubs(input)),
        { "rpc.aggregate": "server" },
      ),
    [WS_METHODS.serverTestCliProxyHub]: (input) =>
      observeRpcEffect(
        WS_METHODS.serverTestCliProxyHub,
        ownerEffect(WS_METHODS.serverTestCliProxyHub, cliProxyService.testHub(input)),
        { "rpc.aggregate": "server" },
      ),
  });
};
