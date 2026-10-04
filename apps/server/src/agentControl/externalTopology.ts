import type { AgentControlExternalTopology } from "@ryco/contracts";

const PROVABLE_LOOPBACK_HOSTS = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export const HUB_CONNECTED_EXTERNAL_TOPOLOGY: AgentControlExternalTopology = {
  available: false,
  reason: "External integrations are disabled while this Ryco is Hub-connected.",
};

export const evaluateExternalMcpTopology = (config: {
  readonly host: string | undefined;
  readonly tailscaleServeEnabled: boolean;
  readonly hubConnector?: { readonly enabled: boolean; readonly standby?: boolean } | undefined;
}): AgentControlExternalTopology => {
  if (config.host === undefined || !PROVABLE_LOOPBACK_HOSTS.has(config.host.trim())) {
    return {
      available: false,
      reason: "External integrations require an explicit loopback-only Ryco listener.",
    };
  }
  if (config.tailscaleServeEnabled) {
    return {
      available: false,
      reason: "External integrations are disabled while Tailscale Serve is enabled.",
    };
  }
  // A standby connector holds no Hub identity and opens no socket, so it is
  // not Hub-connected yet. It can only become so in this process through
  // `AgentControlExternalTopologyService.yieldToHub`, which closes external
  // integrations before the connector opens its relay connection.
  if (config.hubConnector?.enabled === true && config.hubConnector.standby !== true) {
    return HUB_CONNECTED_EXTERNAL_TOPOLOGY;
  }
  return { available: true, reason: null };
};
