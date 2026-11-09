import { Context, Effect } from "effect";
import type {
  AutomationCentreCommand,
  AutomationCentreInput,
  AutomationCentreSnapshot,
  AutomationHookInput,
  AutomationHookView,
  AgentControlRpcError,
} from "@ryco/contracts";

export interface AutomationCentreShape {
  readonly snapshot: (
    input: AutomationCentreInput,
  ) => Effect.Effect<AutomationCentreSnapshot, AgentControlRpcError>;
  readonly command: (
    input: AutomationCentreCommand,
  ) => Effect.Effect<AutomationCentreSnapshot, AgentControlRpcError>;
  /** The owner reads a webhook schedule's hook (with its secret), or replaces the secret. */
  readonly hook: (
    input: AutomationHookInput,
  ) => Effect.Effect<AutomationHookView, AgentControlRpcError>;
}
export class AutomationCentre extends Context.Service<AutomationCentre, AutomationCentreShape>()(
  "ryco/agentControl/AutomationCentre",
) {}
