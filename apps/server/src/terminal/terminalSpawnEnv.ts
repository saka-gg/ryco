/**
 * The environment a process started in a terminal gets: the node's own, without Ryco's and the
 * dev server's variables (`RYCO_*`, `VITE_*`) and the ports that would point it at Ryco, plus the
 * variables its caller sets on purpose, which are kept as they are.
 *
 * Shared by thread terminals and provider sign-in terminals. A thread terminal also gets its
 * thread's `RYCO_THREAD_ID` (`localServers/threadAttributionEnv.ts`), set last so neither an
 * inherited one (a Ryco started from another Ryco's thread) nor the caller's variables replace it.
 *
 * @module terminalSpawnEnv
 */
import { RYCO_THREAD_ID_ENV } from "../localServers/threadAttributionEnv.ts";

const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

export function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
  threadId?: string,
): NodeJS.ProcessEnv {
  const spawnEnv: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (
      value === undefined ||
      /^(?:RYCO|VITE)_/iu.test(key) ||
      TERMINAL_ENV_BLOCKLIST.has(key.toUpperCase())
    ) {
      continue;
    }
    spawnEnv[key] = value;
  }
  if (runtimeEnv) Object.assign(spawnEnv, runtimeEnv);
  if (threadId !== undefined) spawnEnv[RYCO_THREAD_ID_ENV] = threadId;
  return spawnEnv;
}
