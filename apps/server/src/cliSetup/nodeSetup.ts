/**
 * Turning saved node settings into a running background node. Shared by
 * `ryco setup` and `ryco service install`, so both leave the machine in the same
 * state: settings in `node.json`, and a service that runs plain
 * `ryco serve --base-dir …` and reads them.
 */
import { homedir } from "node:os";

import {
  installNodeService,
  isEphemeralCliInstall,
  NodeServiceError,
  type NodeServicePlatform,
  resolveCliEntryScript,
} from "../service/nodeService.ts";
import type { NodeConfig } from "./nodeConfig.ts";

/** Settings given as `ryco serve`-style flags; `undefined` leaves the saved value alone. */
export interface NodeSettingsPatch {
  readonly workspace?: string | undefined;
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly tailscaleServe?: boolean | undefined;
  readonly tailscaleServePort?: number | undefined;
  readonly hubEnabled?: boolean | undefined;
  readonly hubOrigin?: string | undefined;
  readonly hubNodeName?: string | undefined;
  readonly hubAllowFileSecretStore?: boolean | undefined;
  readonly hubE2eePolicy?: NonNullable<NodeConfig["hub"]>["e2eePolicy"] | undefined;
  readonly preventSleep?: boolean | undefined;
  readonly restrictToWorkspace?: boolean | undefined;
}

const defined = <T extends object>(value: T): T =>
  Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined)) as T;

export function applyNodeSettings(config: NodeConfig, patch: NodeSettingsPatch): NodeConfig {
  const hubTouched =
    patch.hubEnabled !== undefined ||
    patch.hubOrigin !== undefined ||
    patch.hubNodeName !== undefined ||
    patch.hubAllowFileSecretStore !== undefined ||
    patch.hubE2eePolicy !== undefined;
  const hub = hubTouched
    ? defined({
        ...config.hub,
        enabled: patch.hubEnabled ?? config.hub?.enabled ?? false,
        origin: patch.hubOrigin ?? config.hub?.origin,
        nodeName: patch.hubNodeName ?? config.hub?.nodeName,
        allowFileSecretStore: patch.hubAllowFileSecretStore ?? config.hub?.allowFileSecretStore,
        e2eePolicy: patch.hubE2eePolicy ?? config.hub?.e2eePolicy,
      })
    : config.hub;
  return defined({
    ...config,
    version: 1 as const,
    workspace: patch.workspace ?? config.workspace,
    host: patch.host ?? config.host,
    port: patch.port ?? config.port,
    tailscaleServe: patch.tailscaleServe ?? config.tailscaleServe,
    tailscaleServePort: patch.tailscaleServePort ?? config.tailscaleServePort,
    hub,
    preventSleep: patch.preventSleep ?? config.preventSleep,
    restrictToWorkspace: patch.restrictToWorkspace ?? config.restrictToWorkspace,
  });
}

/**
 * Install (or replace) the background service for a node whose settings are
 * already saved. The service runs `ryco serve --base-dir <baseDir>`; everything
 * else comes from `node.json`, so `ryco config` edits apply on restart.
 */
export async function installServiceForNode(input: {
  readonly platform: NodeServicePlatform;
  readonly label: string;
  readonly baseDir: string;
  readonly logPath: string;
  readonly workspace: string | undefined;
  /** The CLI entry script to run; defaults to the one running now. */
  readonly scriptPath?: string;
}): Promise<{ readonly definitionPath: string; readonly args: ReadonlyArray<string> }> {
  const scriptPath = input.scriptPath ?? (await resolveCliEntryScript());
  if (isEphemeralCliInstall(scriptPath)) {
    throw new NodeServiceError(
      "This ryco was started through npx/bunx, which a background service cannot rely on after a reboot. Install it with `npm install -g ryco-cli`, then run this again.",
    );
  }
  const args = ["serve", "--base-dir", input.baseDir];
  const definitionPath = await installNodeService(input.platform, {
    label: input.label,
    execPath: process.execPath,
    scriptPath,
    args,
    workingDirectory: input.workspace ?? homedir(),
    logPath: input.logPath,
    environment: {
      // Providers (claude, codex, …) and tools like tailscale are found through
      // the PATH of the shell that installed the service.
      PATH: process.env.PATH ?? "/usr/bin:/bin:/usr/sbin:/sbin",
      HOME: homedir(),
      RYCO_SERVICE_LABEL: input.label,
      ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
    },
  });
  return { definitionPath, args };
}
