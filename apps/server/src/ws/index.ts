import { makeLocalTaskHandlers } from "./localTaskRpc.ts";
import { makeNotesHandlers } from "./notesRpc.ts";
import { makeNodeUpdateHandlers } from "./nodeUpdateRpc.ts";
import { makeDailyRecapHandlers } from "./dailyRecapRpc.ts";
import { makeStorageHandlers } from "./storageRpc.ts";
import { makeLifecycleHandlers } from "./lifecycleRpc.ts";
import { makeSessionImportHandlers } from "./sessionImportRpc.ts";
import { makeThreadForkHandlers } from "./threadForkRpc.ts";
import { makeAutomationCentreHandlers } from "./automationCentreRpc.ts";
import { makeSideQuestionHandlers } from "./sideQuestionRpc.ts";
import { Effect, Layer, Option, type Scope, type Stream } from "effect";
import { WsDeviceRpcGroup, WsRpcGroup } from "@ryco/contracts";
import { type Rpc, type RpcGroup, RpcSerialization } from "effect/rpc";

import { makeWsRpcContext } from "./context.ts";
import type { RpcPrincipal } from "./RpcPrincipal.ts";
import { makeAgentControlHandlers } from "./agentControlRpc.ts";
import { makeOrchestrationHandlers } from "./orchestrationRpc.ts";
import { makeGitHandlers } from "./gitRpc.ts";
import { makeTerminalHandlers } from "./terminalRpc.ts";
import { makeProjectHandlers } from "./projectRpc.ts";
import { makeChatProjectHandlers } from "./chatProjectRpc.ts";
import { makeSourceControlHandlers } from "./sourceControlRpc.ts";
import { makeProviderHandlers } from "./providerRpc.ts";
import { makeProviderSessionPrewarmHandlers } from "./providerSessionPrewarmRpc.ts";
import { makeProviderProjectCommandsHandlers } from "./providerProjectCommandsRpc.ts";
import { makeStatisticsHandlers } from "./statisticsRpc.ts";
import { makeCliProxyHandlers } from "./cliProxyRpc.ts";
import { makeContextHandoffHandlers } from "./contextHandoffRpc.ts";
import { makeDeviceHandlers } from "./deviceRpc.ts";
import { DeviceService } from "../device/Services/DeviceService.ts";
import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";

const makeWsRpcHandlers = (principal: RpcPrincipal) =>
  Effect.gen(function* () {
    const ctx = yield* makeWsRpcContext(principal);
    yield* Effect.addFinalizer(() => ctx.clientWorkspaceUse.release);
    return WsRpcGroup.of({
      ...makeAgentControlHandlers(ctx),
      ...makeAutomationCentreHandlers(ctx),
      ...makeOrchestrationHandlers(ctx),
      ...makeContextHandoffHandlers(ctx),
      ...makeProviderHandlers(ctx),
      ...makeProviderSessionPrewarmHandlers(ctx),
      ...makeProviderProjectCommandsHandlers(ctx),
      ...makeSideQuestionHandlers(ctx),
      ...makeStatisticsHandlers(ctx),
      ...makeCliProxyHandlers(ctx),
      ...makeSourceControlHandlers(ctx),
      ...makeProjectHandlers(ctx),
      ...makeChatProjectHandlers(ctx),
      ...makeSessionImportHandlers(ctx),
      ...makeThreadForkHandlers(ctx),
      ...makeStorageHandlers(ctx),
      ...makeLifecycleHandlers(ctx),
      ...makeDailyRecapHandlers(ctx),
      ...makeLocalTaskHandlers(ctx),
      ...makeNotesHandlers(ctx),
      ...makeNodeUpdateHandlers(ctx),
      ...makeGitHandlers(ctx),
      ...makeTerminalHandlers(ctx),
    });
  });

const makeDeviceRpcHandlers = (principal: RpcPrincipal) =>
  Effect.gen(function* () {
    const deviceService = Option.some(yield* DeviceService);
    const withAccess = <A, E, R>(
      access: WsRpcAccess,
      method: string,
      effect: Effect.Effect<A, E, R>,
    ) => authorizeRpcPrincipal(principal, access, method).pipe(Effect.andThen(effect));
    return WsDeviceRpcGroup.of(makeDeviceHandlers({ deviceService, withAccess }));
  });

export const makeDeviceWsRpcLayer = (principal: RpcPrincipal) =>
  WsDeviceRpcGroup.toLayer(makeDeviceRpcHandlers(principal)).pipe(
    Layer.provideMerge(RpcSerialization.layerJson),
  );

type HandlerResultServices<Result> =
  Result extends Rpc.Wrapper<infer Inner>
    ? HandlerResultServices<Inner>
    : Result extends Effect.Effect<infer _A, infer _E, infer R>
      ? R
      : Result extends Stream.Stream<infer _A, infer _E, infer R>
        ? R
        : never;

/**
 * The services a handler map's effects and streams need, one handler at a time.
 * `RpcGroup.toLayer` infers the same union, but its inference is quadratic in the number of
 * RPCs and the application group outgrew TypeScript's instantiation budget. The group has no
 * middleware, so nothing beyond the handlers' own services is provided or required.
 */
type HandlerMapServices<Handlers> = {
  [K in keyof Handlers]: Handlers[K] extends (...args: never) => infer Result
    ? HandlerResultServices<Result>
    : never;
}[keyof Handlers];

export const makeWsRpcLayer = (principal: RpcPrincipal) => {
  const build = makeWsRpcHandlers(principal);
  // `WsRpcGroup.of` in `makeWsRpcHandlers` already checks every RPC has its handler.
  const toLayer = WsRpcGroup.toLayer as unknown as (
    handlers: typeof build,
  ) => Layer.Layer<
    Rpc.ToHandler<RpcGroup.Rpcs<typeof WsRpcGroup>>,
    Effect.Error<typeof build>,
    Exclude<
      Effect.Services<typeof build> | HandlerMapServices<Effect.Success<typeof build>>,
      Scope.Scope
    >
  >;
  return toLayer.call(WsRpcGroup, build);
};
