import { AGENT_CONTROL_WS_METHODS, AgentControlRpcError } from "@ryco/contracts";
import { Effect, Option } from "effect";
import type { AutomationCentreShape } from "../agentControl/Services/AutomationCentre.ts";
import { defineWsHandlers, type WsRpcContext } from "./context.ts";

export const makeAutomationCentreHandlers = (ctx: WsRpcContext) => {
  const service = (): Effect.Effect<AutomationCentreShape, AgentControlRpcError> =>
    Option.match(ctx.automationCentre, {
      onNone: () =>
        Effect.fail(
          new AgentControlRpcError({
            code: "unsupported",
            message: "Automation centre is unavailable on this server.",
          }),
        ),
      onSome: Effect.succeed,
    });
  return defineWsHandlers({
    [AGENT_CONTROL_WS_METHODS.automationCentre]: (input) =>
      ctx.ownerEffect(
        AGENT_CONTROL_WS_METHODS.automationCentre,
        service().pipe(Effect.flatMap((centre) => centre.snapshot(input))),
      ),
    [AGENT_CONTROL_WS_METHODS.automationCommand]: (input) =>
      ctx.ownerEffect(
        AGENT_CONTROL_WS_METHODS.automationCommand,
        service().pipe(Effect.flatMap((centre) => centre.command(input))),
      ),
  });
};
