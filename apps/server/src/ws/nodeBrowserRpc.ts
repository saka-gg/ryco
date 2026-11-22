import { NODE_BROWSER_WS_METHODS, NodeBrowserRpcError } from "@ryco/contracts/node-browser";
import { Effect, Option, Stream } from "effect";

import {
  handoffTabSource,
  isHandoffTabId,
  type HandoffTabSource,
} from "../nodeBrowser/handoffTabs.ts";
import type { NodeBrowserRuntime } from "../nodeBrowser/NodeBrowser.ts";
import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const AGGREGATE = { "rpc.aggregate": "server" };

/**
 * Node browser tabs: operators only, reads included (the access policy), since a page shows
 * whatever the node's browser profile is signed in to. The runtime loads on the first call.
 */
export function makeNodeBrowserHandlers(
  ctx: Pick<WsRpcContext, "nodeBrowser" | "ownerEffect" | "ownerStream" | "withAccess">,
) {
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
  // A handed-off desktop tab (`handoff-` id): its owner only, and never through the node's own
  // browser runtime (which need not run at all).
  const handoff = <A>(
    method: string,
    run: (source: HandoffTabSource) => Effect.Effect<A, NodeBrowserRpcError>,
  ) =>
    observeRpcEffect(
      method,
      ctx.ownerEffect(
        method,
        ctx.withAccess(
          "owner",
          method,
          Effect.suspend(() => {
            const source = handoffTabSource();
            return source === undefined
              ? Effect.fail(
                  new NodeBrowserRpcError({
                    code: "unavailable",
                    message: "This node cannot show handed-off desktop tabs.",
                    retryable: false,
                  }),
                )
              : Effect.flatMap(source, run);
          }),
        ),
      ),
      AGGREGATE,
    );
  return defineWsHandlers({
    [NODE_BROWSER_WS_METHODS.read]: (input) =>
      input.type === "still" && isHandoffTabId(input.tabId)
        ? handoff(NODE_BROWSER_WS_METHODS.read, (source) =>
            Effect.map(source.still(input), (still) => ({ type: "still" as const, still })),
          )
        : guarded(NODE_BROWSER_WS_METHODS.read, (browser) => browser.read(input)),
    [NODE_BROWSER_WS_METHODS.command]: (input) =>
      "tabId" in input && isHandoffTabId(input.tabId)
        ? handoff(NODE_BROWSER_WS_METHODS.command, (source) =>
            source.command(input.tabId, input.type),
          )
        : guarded(NODE_BROWSER_WS_METHODS.command, (browser) => browser.command(input)),
    [NODE_BROWSER_WS_METHODS.input]: (input) =>
      isHandoffTabId(input.tabId)
        ? handoff(NODE_BROWSER_WS_METHODS.input, (source) => source.input(input))
        : guarded(NODE_BROWSER_WS_METHODS.input, (browser) => browser.input(input)),
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
