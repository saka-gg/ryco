/**
 * The environment a process started in a terminal gets: the node's own, without Ryco's and the
 * dev server's variables (`RYCO_*`, `VITE_*`) and the ports that would point it at Ryco, plus the
 * variables its caller sets on purpose, which are kept as they are.
 *
 * Shared by thread terminals and provider sign-in terminals.
 *
 * @module terminalSpawnEnv
 */
const TERMINAL_ENV_BLOCKLIST = new Set(["PORT", "ELECTRON_RENDERER_PORT", "ELECTRON_RUN_AS_NODE"]);

export function createTerminalSpawnEnv(
  baseEnv: NodeJS.ProcessEnv,
  runtimeEnv?: Record<string, string> | null,
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
  return runtimeEnv ? Object.assign(spawnEnv, runtimeEnv) : spawnEnv;
}
