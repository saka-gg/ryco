/**
 * `ryco config set|unset <key>`: the node settings by their `ryco serve` flag
 * names, so a key reads the same as the flag it replaces.
 */
import { NodeE2eeAdmissionPolicy } from "@ryco/contracts/native-e2ee";
import { canonicalizeHubOrigin, normalizeHubNodeName } from "@ryco/shared/nodeIdentity";
import { Schema } from "effect";

import type { NodeConfig } from "./nodeConfig.ts";
import { applyNodeSettings, type NodeSettingsPatch } from "./nodeSetup.ts";

type Hub = NonNullable<NodeConfig["hub"]>;

interface ConfigKey {
  readonly description: string;
  readonly read: (config: NodeConfig) => string | undefined;
  readonly set: (value: string) => NodeSettingsPatch;
  readonly unset: (config: NodeConfig) => NodeConfig;
}

const parseBoolean = (key: string, value: string): boolean => {
  const normalized = value.trim().toLowerCase();
  if (["true", "on", "yes", "1"].includes(normalized)) return true;
  if (["false", "off", "no", "0"].includes(normalized)) return false;
  throw new Error(`${key} takes true or false.`);
};

const parsePort = (key: string, value: string): number => {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${key} takes a port between 1 and 65535.`);
  }
  return port;
};

const withoutHubField = (config: NodeConfig, field: keyof Hub): NodeConfig => {
  if (config.hub === undefined) return config;
  const { [field]: _removed, ...hub } = config.hub;
  return { ...config, hub: { ...hub, enabled: config.hub.enabled } };
};

const without = (config: NodeConfig, field: keyof NodeConfig): NodeConfig => {
  const { [field]: _removed, ...rest } = config;
  return { ...rest, version: 1 };
};

const formatBoolean = (value: boolean | undefined) =>
  value === undefined ? undefined : value ? "true" : "false";

export const NODE_CONFIG_KEYS: Readonly<Record<string, ConfigKey>> = {
  workspace: {
    description: "Folder provider sessions start in",
    read: (config) => config.workspace,
    set: (value) => ({ workspace: value }),
    unset: (config) => without(config, "workspace"),
  },
  host: {
    description: "Interface to listen on: 127.0.0.1 (this machine) or 0.0.0.0 (local network)",
    read: (config) => config.host,
    set: (value) => ({ host: value.trim() }),
    unset: (config) => without(config, "host"),
  },
  port: {
    description: "Port to listen on",
    read: (config) => config.port?.toString(),
    set: (value) => ({ port: parsePort("port", value) }),
    unset: (config) => without(config, "port"),
  },
  "tailscale-serve": {
    description: "Serve over HTTPS on the tailnet with Tailscale Serve",
    read: (config) => formatBoolean(config.tailscaleServe),
    set: (value) => ({ tailscaleServe: parseBoolean("tailscale-serve", value) }),
    unset: (config) => without(config, "tailscaleServe"),
  },
  "tailscale-serve-port": {
    description: "HTTPS port for Tailscale Serve",
    read: (config) => config.tailscaleServePort?.toString(),
    set: (value) => ({ tailscaleServePort: parsePort("tailscale-serve-port", value) }),
    unset: (config) => without(config, "tailscaleServePort"),
  },
  hub: {
    description: "Reach this node through the Hub relay",
    read: (config) => formatBoolean(config.hub?.enabled),
    set: (value) => ({ hubEnabled: parseBoolean("hub", value) }),
    unset: (config) => without(config, "hub"),
  },
  "hub-origin": {
    description: "Hub to connect to (default https://app.ryco.space)",
    read: (config) => config.hub?.origin,
    set: (value) => {
      try {
        // Accept what people paste — a trailing slash or path — as its origin.
        return { hubOrigin: canonicalizeHubOrigin(new URL(value.trim()).origin) };
      } catch {
        throw new Error("hub-origin takes an https:// origin.");
      }
    },
    unset: (config) => withoutHubField(config, "origin"),
  },
  "hub-node-name": {
    description: "Name proposed when this node enrolls",
    read: (config) => config.hub?.nodeName,
    set: (value) => {
      try {
        return { hubNodeName: normalizeHubNodeName(value) };
      } catch {
        throw new Error("hub-node-name takes 1 to 100 characters.");
      }
    },
    unset: (config) => withoutHubField(config, "nodeName"),
  },
  "hub-allow-file-secret-store": {
    description: "Keep the Hub key in a 0600 file when no OS credential store is usable",
    read: (config) => formatBoolean(config.hub?.allowFileSecretStore),
    set: (value) => ({
      hubAllowFileSecretStore: parseBoolean("hub-allow-file-secret-store", value),
    }),
    unset: (config) => withoutHubField(config, "allowFileSecretStore"),
  },
  "hub-e2ee-policy": {
    description: `Relay encryption admission policy (${NodeE2eeAdmissionPolicy.literals.join(", ")})`,
    read: (config) => config.hub?.e2eePolicy,
    set: (value) => {
      const policy = value.trim();
      if (!Schema.is(NodeE2eeAdmissionPolicy)(policy)) {
        throw new Error(
          `hub-e2ee-policy takes one of ${NodeE2eeAdmissionPolicy.literals.join(", ")}.`,
        );
      }
      return { hubE2eePolicy: policy };
    },
    unset: (config) => withoutHubField(config, "e2eePolicy"),
  },
  "prevent-sleep": {
    description: "Keep the machine from idle-sleeping while the node runs",
    read: (config) => formatBoolean(config.preventSleep),
    set: (value) => ({ preventSleep: parseBoolean("prevent-sleep", value) }),
    unset: (config) => without(config, "preventSleep"),
  },
  "restrict-to-workspace": {
    description: "Limit Ryco-managed paths to the workspace folder",
    read: (config) => formatBoolean(config.restrictToWorkspace),
    set: (value) => ({ restrictToWorkspace: parseBoolean("restrict-to-workspace", value) }),
    unset: (config) => without(config, "restrictToWorkspace"),
  },
};

export function lookupConfigKey(key: string): ConfigKey {
  const entry = NODE_CONFIG_KEYS[key];
  if (entry === undefined) {
    throw new Error(
      `Unknown setting "${key}". Settings: ${Object.keys(NODE_CONFIG_KEYS).join(", ")}.`,
    );
  }
  return entry;
}

export const setConfigKey = (config: NodeConfig, key: string, value: string): NodeConfig =>
  applyNodeSettings(config, lookupConfigKey(key).set(value));

export const unsetConfigKey = (config: NodeConfig, key: string): NodeConfig =>
  lookupConfigKey(key).unset(config);

/** `key = value` lines for every setting, `(default)` where nothing is saved. */
export function formatNodeConfig(config: NodeConfig): string {
  const width = Math.max(...Object.keys(NODE_CONFIG_KEYS).map((key) => key.length));
  return Object.entries(NODE_CONFIG_KEYS)
    .map(([key, entry]) => `${key.padEnd(width)}  ${entry.read(config) ?? "(default)"}`)
    .join("\n");
}
