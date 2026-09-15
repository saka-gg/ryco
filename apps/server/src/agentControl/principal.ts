import type { AgentControlPrincipal } from "@ryco/contracts";

import { AgentControlPrincipalScope } from "../persistence/Services/AgentControlProposals.ts";

/**
 * Idempotency scope key for a principal's request ids.
 *
 * Provider-session principals scope by thread: their credential is
 * thread-bound and retired with the runtime, so request ids must not
 * collide across threads or survive into other threads. External
 * integrations scope by integration identity.
 */
export function agentControlPrincipalScope(
  principal: AgentControlPrincipal,
): AgentControlPrincipalScope {
  switch (principal.kind) {
    case "automation-owner":
      return AgentControlPrincipalScope.make(`automation-owner:${principal.projectId}`);
    case "provider-session":
      return AgentControlPrincipalScope.make(`provider-session:${principal.threadId}`);
    case "external-integration":
      return AgentControlPrincipalScope.make(`external-integration:${principal.integrationId}`);
  }
}
