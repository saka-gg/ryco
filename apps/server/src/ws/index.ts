import { makeSideQuestionHandlers } from "./sideQuestionRpc.ts";
import { Effect, Layer, Option } from "effect";
import { WsDeviceRpcGroup, WsRpcGroup } from "@ryco/contracts";
import { RpcSerialization } from "effect/unstable/rpc";

import type { AuthenticatedSession } from "../auth/Services/ServerAuth.ts";
import { makeWsRpcContext } from "./context.ts";
import { directRpcPrincipal, type RpcPrincipal } from "./RpcPrincipal.ts";
import { makeAgentControlHandlers } from "./agentControlRpc.ts";
import { makeOrchestrationHandlers } from "./orchestrationRpc.ts";
import { makeGitHandlers } from "./gitRpc.ts";
import { makeTerminalHandlers } from "./terminalRpc.ts";
import { makeProjectHandlers } from "./projectRpc.ts";
import { makeSourceControlHandlers } from "./sourceControlRpc.ts";
import { makeProviderHandlers } from "./providerRpc.ts";
import { makeStatisticsHandlers } from "./statisticsRpc.ts";
import { makeContextHandoffHandlers } from "./contextHandoffRpc.ts";
import { makeDeviceHandlers } from "./deviceRpc.ts";
import { DeviceService } from "../device/Services/DeviceService.ts";
import { authorizeRpcPrincipal, type WsRpcAccess } from "../auth/wsAuthorization.ts";

const makeWsRpcHandlers = (principal: RpcPrincipal) =>
  Effect.gen(function* () {
    const ctx = yield* makeWsRpcContext(principal);
    return WsRpcGroup.of({
      ...makeAgentControlHandlers(ctx),
      ...makeOrchestrationHandlers(ctx),
      ...makeContextHandoffHandlers(ctx),
      ...makeProviderHandlers(ctx),
      ...makeSideQuestionHandlers(ctx),
      ...makeStatisticsHandlers(ctx),
      ...makeSourceControlHandlers(ctx),
      ...makeProjectHandlers(ctx),
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

export const makeWsRpcLayer = (principal: RpcPrincipal) =>
  WsRpcGroup.toLayer(makeWsRpcHandlers(principal));

export const makeDirectWsRpcLayer = (session: AuthenticatedSession) =>
  makeWsRpcLayer(directRpcPrincipal(session));
