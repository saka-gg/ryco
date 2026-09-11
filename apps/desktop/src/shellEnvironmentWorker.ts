import { execFileSync } from "node:child_process";
import { homedir } from "node:os";
import { parentPort, workerData } from "node:worker_threads";
import {
  readEnvironmentFromLoginShell,
  readEnvironmentFromWindowsShell,
  readPathFromLaunchctl,
} from "@ryco/shared/shell";
import { pickShellEnvironment } from "./shellEnvironmentCache.ts";
import { syncShellEnvironment } from "./syncShellEnvironment.ts";

// Shell profiles and executable discovery can block on an unavailable filesystem.
// Keep them outside Electron's main thread, including on Windows.
const env: NodeJS.ProcessEnv = { ...workerData.env };
const warnings: string[] = [];
const execute = (
  file: string,
  args: readonly string[],
  options: { encoding: "utf8"; timeout: number },
) =>
  execFileSync(file, args, {
    ...options,
    env,
    cwd: homedir(),
    timeout: 1_500,
    killSignal: "SIGKILL",
    stdio: ["ignore", "pipe", "pipe"],
  });

syncShellEnvironment(env, {
  readEnvironment: (shell, names) => readEnvironmentFromLoginShell(shell, names, execute),
  readWindowsEnvironment: (names, options) =>
    readEnvironmentFromWindowsShell(names, options, execute),
  readLaunchctlPath: () => readPathFromLaunchctl(execute),
  logWarning: (message) => warnings.push(message),
});
parentPort?.postMessage({ environment: pickShellEnvironment(env), warnings });
