import { DEFAULT_HUB_CONNECTOR_CONFIG, type HubConnectorConfig } from "../config.ts";
import { hubIdentityHoldsKeyMaterial } from "./HubIdentityRuntime.ts";

/**
 * Resolve a Desktop standby connector once, at launch.
 *
 * Desktop asks for standby when a Hub is configured but the operator has
 * neither turned the connector on nor off: a fresh install, or settings written
 * before that choice was recorded. Standby runs the connector only for a node
 * that holds no Hub identity yet. That is exactly when an enabled connector
 * parks in `enrolling` without opening a socket, and when building key custody
 * reads nothing from the platform credential store. Device-code enrollment and
 * the native account claim then work in this process, so the first account
 * sign-in no longer relaunches Desktop and kills running turns.
 *
 * Any identity material means the connector was set up before and may have
 * been switched off on purpose, or belongs to another runner sharing this state
 * directory. Standby then resolves to disabled: it never connects an identity
 * nobody asked it to, and never opens the credential store to find out. An
 * unreadable state resolves the same way.
 *
 * A running standby connector is marked `standby`: it is not Hub-connected
 * yet, so external Agent Control integrations stay available until it hands
 * the process to the Hub before its first relay connection.
 */
export async function resolveStandbyHubConnectorConfig(input: {
  readonly config: HubConnectorConfig;
  readonly statePath: string;
  readonly holdsKeyMaterial?: (statePath: string) => Promise<boolean>;
}): Promise<HubConnectorConfig> {
  if (!input.config.enabled) return input.config;
  // A standby connector that cannot start cleanly stays out of the way; the
  // operator sees the problem once they turn the connector on themselves.
  if (input.config.configurationIssue !== undefined) return DEFAULT_HUB_CONNECTOR_CONFIG;
  const holdsKeyMaterial =
    input.holdsKeyMaterial ?? ((statePath: string) => hubIdentityHoldsKeyMaterial({ statePath }));
  let holds: boolean;
  try {
    holds = await holdsKeyMaterial(input.statePath);
  } catch {
    holds = true;
  }
  return holds ? DEFAULT_HUB_CONNECTOR_CONFIG : { ...input.config, standby: true };
}
