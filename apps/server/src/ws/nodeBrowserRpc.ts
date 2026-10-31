import { NODE_BROWSER_WS_METHODS, NodeBrowserRpcError } from "@ryco/contracts/node-browser";
import { Effect, Option, Stream } from "effect";

import type { NodeBrowserRuntime } from "../nodeBrowser/NodeBrowser.ts";
import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const AGGREGATE = { "rpc.aggregate": "server" };

/**
 * Node browser tabs: operators only, reads included (the access policy), since a page shows
 * whatever the node's browser profile is signed in to. The runtime loads on the first call.
 */
export function makeNodeBrowserHandlers(ctx: WsRpcContext) {
  const runtime: Effect.Effect<NodeBrowserRuntime, NodeBrowserRpcError> = Option.match(
    ctx.nodeBrowser,
    {
      onNone: () =>
        Effect.fail(
          new NodeBrowserRpcError({
            code: "unavailable",
            message: "Node browser tabs are not available on this node.",
            retryable: false,
          }),
        ),
      onSome: (nodeBrowser) => nodeBrowser.runtime,
    },
  );
  const guarded = <A>(
    method: string,
    run: (browser: NodeBrowserRuntime) => Effect.Effect<A, NodeBrowserRpcError>,
  ) => observeRpcEffect(method, ctx.ownerEffect(method, Effect.flatMap(runtime, run)), AGGREGATE);
  return defineWsHandlers({
    [NODE_BROWSER_WS_METHODS.read]: (input) =>
      guarded(NODE_BROWSER_WS_METHODS.read, (browser) => browser.read(input)),
    [NODE_BROWSER_WS_METHODS.command]: (input) =>
      guarded(NODE_BROWSER_WS_METHODS.command, (browser) => browser.command(input)),
    [NODE_BROWSER_WS_METHODS.input]: (input) =>
      guarded(NODE_BROWSER_WS_METHODS.input, (browser) => browser.input(input)),
    [NODE_BROWSER_WS_METHODS.subscribe]: () =>
      observeRpcStream(
        NODE_BROWSER_WS_METHODS.subscribe,
        ctx.ownerStream(
          NODE_BROWSER_WS_METHODS.subscribe,
          Stream.unwrap(Effect.map(runtime, (browser) => browser.subscribe)),
        ),
        AGGREGATE,
      ),
  });
}
