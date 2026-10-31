import { makeLocalTaskHandlers } from "./localTaskRpc.ts";
import { makeNotesHandlers } from "./notesRpc.ts";
import { makeNodeUpdateHandlers } from "./nodeUpdateRpc.ts";
import { makeClientInteractionHandlers } from "./clientInteractionRpc.ts";
import { makeProviderSignInHandlers } from "./providerSignInRpc.ts";
import { makeNodeBrowserHandlers } from "./nodeBrowserRpc.ts";
import { makePushHandlers } from "./pushRpc.ts";
import { makeDailyRecapHandlers } from "./dailyRecapRpc.ts";
import { makeStorageHandlers } from "./storageRpc.ts";
import { makeLifecycleHandlers } from "./lifecycleRpc.ts";
import { makeSessionImportHandlers } from "./sessionImportRpc.ts";
import { makeThreadForkHandlers } from "./threadForkRpc.ts";
import { makeThreadLocalServerHandlers } from "./threadLocalServersRpc.ts";
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
import { makeSourceControlInvolvedHandlers } from "./sourceControlInvolvedRpc.ts";
import { makeProviderHandlers } from "./providerRpc.ts";
import { makeProviderSessionPrewarmHandlers } from "./providerSessionPrewarmRpc.ts";
import { makeProviderProjectCommandsHandlers } from "./providerProjectCommandsRpc.ts";
import { makeStatisticsHandlers } from "./statisticsRpc.ts";
import { makeCliProxyHandlers } from "./cliProxyRpc.ts";
import { makeContextHandoffHandlers } from "./contextHandoffRpc.ts";
import { makeDeviceHandlers } from "./deviceRpc.ts";
import { DeviceService } from "../device/Services/DeviceService.ts";
import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";

/**
 * The application group's handlers, named through each module's own factory. Inferred, the
 * handler map is spelled out with every RPC's payload, once for each place the layer's type
 * mentions it, and that outgrew the length TypeScript serializes a declaration's type to.
 */
type WsRpcHandlerMap = ReturnType<typeof makeAgentControlHandlers> &
  ReturnType<typeof makeAutomationCentreHandlers> &
  ReturnType<typeof makeOrchestrationHandlers> &
  ReturnType<typeof makeContextHandoffHandlers> &
  ReturnType<typeof makeProviderHandlers> &
  ReturnType<typeof makeProviderSessionPrewarmHandlers> &
  ReturnType<typeof makeProviderProjectCommandsHandlers> &
  ReturnType<typeof makeSideQuestionHandlers> &
  ReturnType<typeof makeStatisticsHandlers> &
  ReturnType<typeof makeCliProxyHandlers> &
  ReturnType<typeof makeSourceControlHandlers> &
  ReturnType<typeof makeProjectHandlers> &
  ReturnType<typeof makeChatProjectHandlers> &
  ReturnType<typeof makeSessionImportHandlers> &
  ReturnType<typeof makeThreadForkHandlers> &
  ReturnType<typeof makeThreadLocalServerHandlers> &
  ReturnType<typeof makeStorageHandlers> &
  ReturnType<typeof makeLifecycleHandlers> &
  ReturnType<typeof makeDailyRecapHandlers> &
  ReturnType<typeof makeLocalTaskHandlers> &
  ReturnType<typeof makeNotesHandlers> &
  ReturnType<typeof makeNodeUpdateHandlers> &
  ReturnType<typeof makeClientInteractionHandlers> &
  ReturnType<typeof makeGitHandlers> &
  ReturnType<typeof makeTerminalHandlers> &
  ReturnType<typeof makeNodeBrowserHandlers>;

type WsRpcContextBuild = ReturnType<typeof makeWsRpcContext>;

const makeWsRpcHandlers = (
  principal: RpcPrincipal,
): Effect.Effect<
  WsRpcHandlerMap,
  Effect.Error<WsRpcContextBuild>,
  Effect.Services<WsRpcContextBuild> | Scope.Scope
> =>
  Effect.gen(function* () {
    const ctx = yield* makeWsRpcContext(principal);
    yield* Effect.addFinalizer(() => ctx.clientWorkspaceUse.release);
    return WsRpcGroup.of({
      ...makeAgentControlHandlers(ctx),
      ...makeAutomationCentreHandlers(ctx),
      ...makeOrchestrationHandlers(ctx),
      ...makeContextHandoffHandlers(ctx),
      ...makeProviderHandlers(ctx),
      ...makeProviderSignInHandlers(ctx),
      ...makeProviderSessionPrewarmHandlers(ctx),
      ...makeProviderProjectCommandsHandlers(ctx),
      ...makeSideQuestionHandlers(ctx),
      ...makeStatisticsHandlers(ctx),
      ...makeCliProxyHandlers(ctx),
      ...makeSourceControlHandlers(ctx),
      ...makeSourceControlInvolvedHandlers(ctx),
      ...makeProjectHandlers(ctx),
      ...makeChatProjectHandlers(ctx),
      ...makeSessionImportHandlers(ctx),
      ...makeThreadForkHandlers(ctx),
      ...makeThreadLocalServerHandlers(ctx),
      ...makeStorageHandlers(ctx),
      ...makeLifecycleHandlers(ctx),
      ...makeDailyRecapHandlers(ctx),
      ...makeLocalTaskHandlers(ctx),
      ...makeNotesHandlers(ctx),
      ...makeNodeUpdateHandlers(ctx),
      ...makeClientInteractionHandlers(ctx),
      ...makePushHandlers(ctx),
      ...makeGitHandlers(ctx),
      ...makeTerminalHandlers(ctx),
      ...makeNodeBrowserHandlers(ctx),
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

type WsRpcHandlersBuild = ReturnType<typeof makeWsRpcHandlers>;

/**
 * Named, so the layer's type is written by reference: inlined, it outgrew what the compiler
 * serializes for an inferred export (TS7056).
 */
type WsRpcLayer = Layer.Layer<
  Rpc.ToHandler<RpcGroup.Rpcs<typeof WsRpcGroup>>,
  Effect.Error<WsRpcHandlersBuild>,
  Exclude<
    Effect.Services<WsRpcHandlersBuild> | HandlerMapServices<Effect.Success<WsRpcHandlersBuild>>,
    Scope.Scope
  >
>;

export const makeWsRpcLayer = (principal: RpcPrincipal): WsRpcLayer => {
  const build = makeWsRpcHandlers(principal);
  // `WsRpcGroup.of` in `makeWsRpcHandlers` already checks every RPC has its handler.
  const toLayer = WsRpcGroup.toLayer as unknown as (handlers: WsRpcHandlersBuild) => WsRpcLayer;
  return toLayer.call(WsRpcGroup, build);
};
