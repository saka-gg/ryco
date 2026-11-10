import { createTerminalHistoryMirrorCache } from "@ryco/client-runtime/state/terminal";

import { MAX_RENDERER_HISTORY_BYTES } from "./terminalBridgeProtocol";

/**
 * The scrollback this device's terminal screens showed, by `<scoped thread key>\0<terminal id>`,
 * in memory only. Reopening a terminal then downloads only what came after it.
 */
export const terminalHistoryMirrors = createTerminalHistoryMirrorCache({
  maxEntries: 6,
  maxHistoryUnits: MAX_RENDERER_HISTORY_BYTES,
  maxTotalUnits: 3 * MAX_RENDERER_HISTORY_BYTES,
});
