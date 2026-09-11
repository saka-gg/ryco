import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { app } from "electron";
import { externalBridgeLaunchArgs } from "./externalBridgeLaunch.ts";

// Installed MCP configurations invoke the runtime executable directly. For a
// packaged app that is Electron, so dispatch before loading any GUI services.
const bridgeArgs = app.isPackaged
  ? externalBridgeLaunchArgs(process.argv, resolve(__dirname, "../../server/dist/bin.mjs"))
  : null;

if (bridgeArgs !== null) {
  const bridge = spawn(process.execPath, bridgeArgs, {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    stdio: "inherit",
  });
  bridge.once("error", () => {
    process.stderr.write("Could not start the Ryco MCP bridge.\n");
    app.exit(1);
  });
  bridge.once("exit", (code) => app.exit(code ?? 1));
  app.on("before-quit", () => bridge.kill("SIGTERM"));
  process.once("SIGTERM", () => bridge.kill("SIGTERM"));
  process.once("SIGINT", () => bridge.kill("SIGINT"));
} else {
  // Keep normal initialization synchronous: protocol registration must precede ready.
  require(resolve(__dirname, "desktopMain.cjs"));
}
