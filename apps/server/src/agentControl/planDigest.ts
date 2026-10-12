import {
  AGENT_CONTROL_PLAN_VERSION,
  AgentControlActionPlan,
  AgentControlPlanDigest,
} from "@ryco/contracts";
import { Schema } from "effect";

import { canonicalJson, sha256Hex } from "../canonicalJson.ts";

const encodePlan = Schema.encodeSync(AgentControlActionPlan);

/** Canonical wire-form JSON for a plan: encoded, key-sorted, deterministic. */
export function canonicalAgentControlPlanJson(plan: AgentControlActionPlan): string {
  return canonicalJson(encodePlan(plan));
}

/**
 * sha-256 over the versioned canonical plan payload. Accepting a proposal
 * authorizes exactly this digest; any plan change produces a new digest and
 * therefore requires a new request and a new approval.
 */
export function computeAgentControlPlanDigest(
  plan: AgentControlActionPlan,
): AgentControlPlanDigest {
  return AgentControlPlanDigest.make(
    sha256Hex(`${AGENT_CONTROL_PLAN_VERSION}:${canonicalAgentControlPlanJson(plan)}`),
  );
}
