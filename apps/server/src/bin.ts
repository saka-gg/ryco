/**
 * bin - Process entry point for `ryco` and the desktop backend.
 *
 * Deliberately free of heavy static imports. Node compiles an ES module's whole
 * static import graph before running its body, so this module enables the V8
 * compile cache first and only then loads the server graph. The helper modes
 * spawned per provider session or MCP client (stdio proxy, external MCP
 * bridge, device host) load just their own modules.
 *
 * A node update's preflight (run by the release being replaced) announces itself
 * before it loads anything, and a `ryco service` start of `serve` first loads the
 * boot guard, which rolls back an update that keeps failing to start: both have
 * to work when the server graph itself is what is broken.
 */
import { AGENT_CONTROL_STDIO_PROXY_ARG } from "./agentControl/stdioProxyProtocol.ts";
import { enableCompileCacheBestEffort } from "./compileCache.ts";
import {
  announceNodeUpdatePreflight,
  NODE_UPDATE_PREFLIGHT_ARG,
} from "./nodeUpdate/updateProtocol.ts";
import { nodeServiceManagerOfProcess } from "./service/nodeServiceManager.ts";

const reportEntryFailure = (message: string) => () => {
  process.stderr.write(message);
  process.exitCode = 1;
};

const externalMcpArgs = (): {
  readonly action: "pair" | "serve";
  readonly integrationId: string;
  readonly stateDir: string;
} | null => {
  if (process.argv[2] !== "mcp" || (process.argv[3] !== "pair" && process.argv[3] !== "serve")) {
    return null;
  }
  const integrationIndex = process.argv.indexOf("--integration", 4);
  const stateDirIndex = process.argv.indexOf("--state-dir", 4);
  const integrationId = integrationIndex < 0 ? undefined : process.argv[integrationIndex + 1];
  const stateDir = stateDirIndex < 0 ? undefined : process.argv[stateDirIndex + 1];
  if (!integrationId || !stateDir) return null;
  return { action: process.argv[3], integrationId, stateDir };
};

// libuv's pool, sized before anything starts it (it starts lazily, on its first job). The desktop
// sets the same size for its backend (DESKTOP_BACKEND_UV_THREADPOOL_SIZE, with the reasons); this
// covers `ryco serve` and the service, where permessage-deflate on live frames also runs on it.
if (!process.env.UV_THREADPOOL_SIZE?.trim()) process.env.UV_THREADPOOL_SIZE = "16";
enableCompileCacheBestEffort();

const external = externalMcpArgs();

/** Only the service's own start: not a terminal's `ryco serve`, nor one an agent of it runs. */
const isServiceServeStart = () =>
  process.argv[2] === "serve" &&
  nodeServiceManagerOfProcess({
    serviceLabel: process.env.RYCO_SERVICE_LABEL,
    platform: process.platform,
    pid: process.pid,
    parentPid: process.ppid,
    systemdExecPid: process.env.SYSTEMD_EXEC_PID,
  }) !== null;

/** `exit` when the update this service was restarted into is being rolled back. */
const guardBoot = (): Promise<"boot" | "exit"> =>
  isServiceServeStart()
    ? import("./nodeUpdate/bootGuard.ts").then(
        ({ guardNodeUpdateBoot }) => guardNodeUpdateBoot(import.meta.url),
        (cause: unknown) => {
          process.stderr.write(`Ryco skipped its update check: ${String(cause)}\n`);
          return "boot" as const;
        },
      )
    : Promise.resolve("boot");

if (process.argv[2] === "device-host-stdio") {
  void import("./device/deviceHostWorker.ts")
    .then(({ runDeviceHostWorker }) => runDeviceHostWorker())
    .catch(
      reportEntryFailure(
        "Ryco device host unavailable. Check macOS requirements and whether another coding node owns this host.\n",
      ),
    );
} else if (process.argv[2] === AGENT_CONTROL_STDIO_PROXY_ARG) {
  void import("./agentControl/stdioProxy.ts")
    .then(({ runAgentControlStdioProxyFromProcess }) => runAgentControlStdioProxyFromProcess())
    .catch(reportEntryFailure("Ryco Agent Control proxy failed to start.\n"));
} else if (external !== null) {
  void import("./agentControl/ExternalMcp/bridge.ts")
    .then(async ({ promptAndPairExternalMcpBridge, runExternalMcpBridge }) => {
      if (external.action === "pair") {
        await promptAndPairExternalMcpBridge({
          integrationId: external.integrationId,
          stateDirs: [external.stateDir],
          fetch: globalThis.fetch,
          input: process.stdin,
          output: process.stdout,
        });
        process.stdout.write("Ryco integration paired.\n");
        return;
      }
      await runExternalMcpBridge({
        integrationId: external.integrationId,
        stateDirs: [external.stateDir],
        input: process.stdin,
        output: process.stdout,
        errorOutput: process.stderr,
        fetch: globalThis.fetch,
      });
    })
    .catch(reportEntryFailure("External Ryco MCP bridge stopped.\n"));
} else if (process.argv[2] === NODE_UPDATE_PREFLIGHT_ARG) {
  announceNodeUpdatePreflight();
  void import("./cliMain.ts")
    .then(({ runNodeUpdatePreflight }) => runNodeUpdatePreflight())
    .catch((cause: unknown) => {
      process.stderr.write(`Ryco could not run its update preflight: ${String(cause)}\n`);
      process.exitCode = 1;
    });
} else {
  void guardBoot()
    .then(async (decision) => {
      // The previous release is back (or its reinstall is retried on the next start); the
      // service manager starts it.
      if (decision === "exit") {
        process.exitCode = 1;
        return;
      }
      const { runCli } = await import("./cliMain.ts");
      runCli();
    })
    .catch((cause: unknown) => {
      process.stderr.write(`Ryco failed to start: ${String(cause)}\n`);
      process.exitCode = 1;
    });
}
