import { AGENT_CONTROL_ACTION_CAPABILITIES } from "@ryco/contracts";
import { Effect, Layer } from "effect";

import { ServerSettingsService } from "../../serverSettings.ts";
import {
  NO_DELEGATION_LIMITS,
  type DelegationLimits,
} from "../../orchestration/delegationLimits.ts";
import { AgentControlCapabilityDeniedError, AgentControlDisabledError } from "../Errors.ts";
import {
  AgentControlPolicy,
  type AgentControlPolicyShape,
} from "../Services/AgentControlPolicy.ts";

const makeAgentControlPolicy = Effect.gen(function* () {
  const serverSettings = yield* ServerSettingsService;

  // Fail closed: a settings read failure reads as "disabled", never as
  // "assume enabled".
  const isEnabled: AgentControlPolicyShape["isEnabled"] = serverSettings.getSettings.pipe(
    Effect.map((settings) => settings.agentControl.enabled),
    Effect.catch(() => Effect.succeed(false)),
  );

  const delegationLimits: AgentControlPolicyShape["delegationLimits"] =
    serverSettings.getSettings.pipe(
      Effect.map((settings): DelegationLimits => settings.agentControl.delegation),
      Effect.catch(() => Effect.succeed(NO_DELEGATION_LIMITS)),
    );

  const requireEnabled: AgentControlPolicyShape["requireEnabled"] = (operation) =>
    isEnabled.pipe(
      Effect.flatMap((enabled) =>
        enabled ? Effect.void : Effect.fail(new AgentControlDisabledError({ operation })),
      ),
    );

  const requiredCapabilityForAction: AgentControlPolicyShape["requiredCapabilityForAction"] = (
    kind,
  ) => AGENT_CONTROL_ACTION_CAPABILITIES[kind];

  const authorize: AgentControlPolicyShape["authorize"] = (input) =>
    requireEnabled(input.operation).pipe(
      Effect.flatMap(() =>
        input.grantedCapabilities.includes(input.requiredCapability)
          ? Effect.void
          : Effect.fail(
              new AgentControlCapabilityDeniedError({
                operation: input.operation,
                capability: input.requiredCapability,
              }),
            ),
      ),
    );

  return {
    isEnabled,
    delegationLimits,
    requireEnabled,
    requiredCapabilityForAction,
    authorize,
  } satisfies AgentControlPolicyShape;
});

export const AgentControlPolicyLive = Layer.effect(AgentControlPolicy, makeAgentControlPolicy);
