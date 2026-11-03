import { Effect, Option, Stream } from "effect";
import { ProviderSignInError, WS_METHODS } from "@ryco/contracts";

import { observeRpcEffect, observeRpcStream } from "../observability/RpcInstrumentation.ts";
import type { ProviderSignInShape } from "../provider/signIn/ProviderSignIn.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

const AGGREGATE = { "rpc.aggregate": "server" };

/**
 * Provider sign-in. Owners only, following a flow included: it carries the device code and the
 * login's output. Any owner session may follow or cancel a flow another one started.
 */
export function makeProviderSignInHandlers(ctx: WsRpcContext) {
  const runtime: Effect.Effect<ProviderSignInShape, ProviderSignInError> = Option.getOrElse(
    ctx.providerSignIn,
    () => Effect.fail(new ProviderSignInError({ message: "Sign-in is unavailable on this node." })),
  );
  const owner = <A>(
    method: string,
    run: (signIn: ProviderSignInShape) => Effect.Effect<A, ProviderSignInError>,
  ) => observeRpcEffect(method, ctx.ownerEffect(method, Effect.flatMap(runtime, run)), AGGREGATE);
  return defineWsHandlers({
    [WS_METHODS.providerSignInSubscribe]: (input) =>
      observeRpcStream(
        WS_METHODS.providerSignInSubscribe,
        ctx.ownerStream(
          WS_METHODS.providerSignInSubscribe,
          Stream.unwrap(Effect.map(runtime, (signIn) => signIn.subscribe(input.instanceId))),
        ),
        AGGREGATE,
      ),
    [WS_METHODS.providerSignInStart]: (input) =>
      owner(WS_METHODS.providerSignInStart, (signIn) => signIn.start(input.instanceId)),
    [WS_METHODS.providerSignInRespond]: (input) =>
      owner(WS_METHODS.providerSignInRespond, (signIn) => signIn.respond(input)),
  });
}
