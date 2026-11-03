import { selectTerminalWriteRequireIdleSupported } from "@ryco/client-runtime/state/terminal";
import type { EnvironmentId } from "@ryco/contracts";

import { readNodeServerConfig } from "./environments/nodeServerConfig";

/**
 * Whether the node behind `environmentId` honours `requireIdle` on `terminal.write`. The node's
 * own config comes first, whatever kind of connection reported it: a node that is not the
 * primary still counts, and the primary's projected config, which can still be the previous
 * node's during a node switch, is only a fallback.
 */
export function readTerminalWriteRequireIdleSupported(environmentId: EnvironmentId): boolean {
  return selectTerminalWriteRequireIdleSupported(readNodeServerConfig(environmentId));
}
