import { Context, Effect } from "effect";
import type {
  AutomationCentreCommand,
  AutomationCentreInput,
  AutomationCentreSnapshot,
  AgentControlRpcError,
} from "@ryco/contracts";

export interface AutomationCentreShape {
  readonly snapshot: (
    input: AutomationCentreInput,
  ) => Effect.Effect<AutomationCentreSnapshot, AgentControlRpcError>;
  readonly command: (
    input: AutomationCentreCommand,
  ) => Effect.Effect<AutomationCentreSnapshot, AgentControlRpcError>;
}
export class AutomationCentre extends Context.Service<AutomationCentre, AutomationCentreShape>()(
  "ryco/agentControl/AutomationCentre",
) {}
