import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { Command } from "effect/unstable/cli";

import { NetService } from "@ryco/shared/Net";
import { cli } from "./cli.ts";
import packageJson from "../package.json" with { type: "json" };
import { AGENT_CONTROL_STDIO_PROXY_ARG } from "./agentControl/ProviderInjection.ts";
import { runAgentControlStdioProxyFromProcess } from "./agentControl/stdioProxy.ts";
import {
  promptAndPairExternalMcpBridge,
  runExternalMcpBridge,
} from "./agentControl/ExternalMcp/bridge.ts";

const CliRuntimeLayer = Layer.mergeAll(NodeServices.layer, NetService.layer);

const program = Command.run(cli, { version: packageJson.version }).pipe(
  Effect.scoped,
  Effect.provide(CliRuntimeLayer),
);

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

const external = externalMcpArgs();

if (process.argv[2] === "device-host-stdio") {
  void import("./device/deviceHostWorker.ts")
    .then(({ runDeviceHostWorker }) => runDeviceHostWorker())
    .catch(() => {
      process.stderr.write(
        "Ryco device host unavailable. Check macOS requirements and whether another coding node owns this host.\n",
      );
      process.exitCode = 1;
    });
} else if (process.argv[2] === AGENT_CONTROL_STDIO_PROXY_ARG) {
  runAgentControlStdioProxyFromProcess();
} else if (external !== null) {
  const operation =
    external.action === "pair"
      ? promptAndPairExternalMcpBridge({
          integrationId: external.integrationId,
          stateDirs: [external.stateDir],
          fetch: globalThis.fetch,
          input: process.stdin,
          output: process.stdout,
        }).then(() => process.stdout.write("Ryco integration paired.\n"))
      : runExternalMcpBridge({
          integrationId: external.integrationId,
          stateDirs: [external.stateDir],
          input: process.stdin,
          output: process.stdout,
          errorOutput: process.stderr,
          fetch: globalThis.fetch,
        });
  void operation.catch(() => {
    process.stderr.write("External Ryco MCP bridge stopped.\n");
    process.exitCode = 1;
  });
} else {
  NodeRuntime.runMain(program as Effect.Effect<void, never, never>);
}
