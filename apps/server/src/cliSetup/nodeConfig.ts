/**
 * The node's saved serve settings: `<state dir>/node.json`.
 *
 * `ryco setup` writes it, `ryco config` shows and edits it, and every headless
 * `ryco serve` — including the background service, which runs plain
 * `ryco serve --base-dir …` — reads it. Explicit flags and environment
 * variables still win, so one-off overrides need no edit. A Desktop-spawned
 * backend never reads it: Desktop owns its backend's settings.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";

import { NodeE2eeAdmissionPolicy } from "@ryco/contracts/native-e2ee";
import { Schema } from "effect";

const Port = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }));

export const NodeConfig = Schema.Struct({
  version: Schema.Literal(1),
  /** Working directory for provider sessions; the positional `cwd` of `ryco serve`. */
  workspace: Schema.optional(Schema.String),
  /** Interface to bind: `127.0.0.1` for local plus Tailscale Serve/Hub, `0.0.0.0` for the LAN. */
  host: Schema.optional(Schema.String),
  port: Schema.optional(Port),
  tailscaleServe: Schema.optional(Schema.Boolean),
  tailscaleServePort: Schema.optional(Port),
  hub: Schema.optional(
    Schema.Struct({
      enabled: Schema.Boolean,
      origin: Schema.optional(Schema.String),
      nodeName: Schema.optional(Schema.String),
      /** Keep the Hub key in a 0600 file when no OS credential store is usable (headless Linux). */
      allowFileSecretStore: Schema.optional(Schema.Boolean),
      e2eePolicy: Schema.optional(NodeE2eeAdmissionPolicy),
    }),
  ),
  preventSleep: Schema.optional(Schema.Boolean),
  restrictToWorkspace: Schema.optional(Schema.Boolean),
});
export type NodeConfig = typeof NodeConfig.Type;

export const EMPTY_NODE_CONFIG: NodeConfig = { version: 1 };

export const nodeConfigPath = (stateDir: string) => path.join(stateDir, "node.json");

export class NodeConfigError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options);
    this.name = "NodeConfigError";
  }
}

export function parseNodeConfig(raw: string, source: string): NodeConfig {
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch (cause) {
    throw new NodeConfigError(`${source} is not valid JSON.`, { cause });
  }
  try {
    return Schema.decodeUnknownSync(NodeConfig)(json, { onExcessProperty: "error" });
  } catch (cause) {
    throw new NodeConfigError(
      `${source} has a setting Ryco does not understand: ${cause instanceof Error ? cause.message : String(cause)}`,
      { cause },
    );
  }
}

/** The saved config, or `null` when this node has never been set up. */
export async function readNodeConfig(filePath: string): Promise<NodeConfig | null> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch {
    return null;
  }
  return parseNodeConfig(raw, filePath);
}

export async function writeNodeConfig(filePath: string, config: NodeConfig): Promise<void> {
  const validated = Schema.decodeUnknownSync(NodeConfig)(config, { onExcessProperty: "error" });
  await mkdir(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

/**
 * The same settings as `ryco serve` flags, for display and for anyone who wants
 * to run the node by hand exactly as the service does.
 */
export function nodeConfigAsServeArgs(config: NodeConfig): string[] {
  const args: string[] = [];
  if (config.host !== undefined) args.push("--host", config.host);
  if (config.port !== undefined) args.push("--port", String(config.port));
  if (config.tailscaleServe) args.push("--tailscale-serve");
  if (config.tailscaleServePort !== undefined) {
    args.push("--tailscale-serve-port", String(config.tailscaleServePort));
  }
  if (config.hub?.enabled) {
    args.push("--hub");
    if (config.hub.origin !== undefined) args.push("--hub-origin", config.hub.origin);
    if (config.hub.nodeName !== undefined) args.push("--hub-node-name", config.hub.nodeName);
    if (config.hub.allowFileSecretStore) args.push("--hub-allow-file-secret-store");
    if (config.hub.e2eePolicy !== undefined) args.push("--hub-e2ee-policy", config.hub.e2eePolicy);
  }
  if (config.preventSleep) args.push("--prevent-sleep");
  if (config.restrictToWorkspace) args.push("--restrict-to-cwd");
  if (config.workspace !== undefined) args.push(config.workspace);
  return args;
}
