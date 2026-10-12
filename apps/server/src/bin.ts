/**
 * bin - Process entry point for `ryco` and the desktop backend.
 *
 * Deliberately free of heavy static imports. Node compiles an ES module's whole
 * static import graph before running its body, so this module enables the V8
 * compile cache first and only then loads the server graph. The helper modes
 * spawned per provider session or MCP client (stdio proxy, external MCP
 * bridge, device host) load just their own modules.
 */
import { AGENT_CONTROL_STDIO_PROXY_ARG } from "./agentControl/stdioProxyProtocol.ts";
import { enableCompileCacheBestEffort } from "./compileCache.ts";

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

enableCompileCacheBestEffort();

const external = externalMcpArgs();

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
} else {
  void import("./cliMain.ts")
    .then(({ runCli }) => runCli())
    .catch((cause: unknown) => {
      process.stderr.write(`Ryco failed to start: ${String(cause)}\n`);
      process.exitCode = 1;
    });
}
