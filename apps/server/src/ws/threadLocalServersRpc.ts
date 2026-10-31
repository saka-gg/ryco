import { WS_METHODS } from "@ryco/contracts";
import { Effect, Stream } from "effect";

import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

// The monitor loads with the first subscription or stop: nothing in it is needed at boot.
const loadMonitor = Effect.promise(() => import("../localServers/threadLocalServerMonitor.ts"));

/**
 * `threads.subscribeLocalServers` and `threads.stopLocalServer`: operator access, checked before
 * the monitor loads. A stop signals only what the monitor attributes to the thread again at stop
 * time (`localServers/threadLocalServerMonitor.ts`).
 */
export const makeThreadLocalServerHandlers = (ctx: WsRpcContext) => {
  /** Threads this connection follows now; the monitor enforces its cap. */
  const subscriptions = { active: 0 };
  return defineWsHandlers({
    [WS_METHODS.threadsSubscribeLocalServers]: (input) =>
      observeRpcStream(
        WS_METHODS.threadsSubscribeLocalServers,
        ctx.ownerStream(
          WS_METHODS.threadsSubscribeLocalServers,
          Stream.unwrap(
            loadMonitor.pipe(
              Effect.map((monitor) => monitor.streamThreadLocalServers(input, subscriptions)),
            ),
          ),
        ),
        { "rpc.aggregate": "thread-local-servers" },
      ),
    [WS_METHODS.threadsStopLocalServer]: (input) =>
      observeRpcEffect(
        WS_METHODS.threadsStopLocalServer,
        ctx.ownerEffect(
          WS_METHODS.threadsStopLocalServer,
          loadMonitor.pipe(Effect.flatMap((monitor) => monitor.stopThreadLocalServer(input))),
        ),
        { "rpc.aggregate": "thread-local-servers", "rpc.operation": "stop" },
      ),
  });
};
