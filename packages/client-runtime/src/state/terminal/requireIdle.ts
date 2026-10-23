import type { ServerConfig } from "@ryco/contracts";

/**
 * Whether the node's `terminal.write` honours `requireIdle`, read from its live server config
 * (hosted nodes get a synthetic descriptor without it). Older nodes drop the key and write
 * unguarded, so where this is false nothing may type into a terminal that could be busy.
 */
export function selectTerminalWriteRequireIdleSupported(config: ServerConfig | null): boolean {
  return config?.environment.capabilities.terminalWriteRequireIdle === true;
}
