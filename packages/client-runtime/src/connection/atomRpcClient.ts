import { WsRpcGroup } from "@ryco/contracts";
import { Effect } from "effect";
import { AtomRegistry, AtomRpc } from "effect/reactivity";

import { getKnownEnvironmentWsBaseUrl, type KnownEnvironment } from "../knownEnvironment.ts";
import { createWsRpcProtocolLayer } from "../rpc/index.ts";
import type { SocketService } from "../platform/index.ts";

export interface PrimaryEnvironmentReadiness {
  readonly ensureReady: () => Promise<unknown>;
  readonly readKnownEnvironment: () => KnownEnvironment | null;
}

export function createAtomRpcClient(
  readiness: PrimaryEnvironmentReadiness,
  registry: ReturnType<typeof AtomRegistry.make>,
  socket: SocketService,
) {
  const resolvePrimaryWsBaseUrl = async (): Promise<string> => {
    await readiness.ensureReady();
    const wsBaseUrl = getKnownEnvironmentWsBaseUrl(readiness.readKnownEnvironment());
    if (!wsBaseUrl) throw new Error("Primary environment WebSocket transport URL is unavailable.");
    return wsBaseUrl;
  };
  class Client extends AtomRpc.Service<Client>()("AtomRpcClient", {
    group: WsRpcGroup,
    protocol: createWsRpcProtocolLayer(resolvePrimaryWsBaseUrl, socket),
    spanPrefix: "AtomRpcClient",
  }) {}
  type ClientShape = Parameters<Parameters<typeof Client.use>[0]>[0];
  return {
    Client,
    runRpc: <A, E>(use: (client: ClientShape) => Effect.Effect<A, E>): Promise<A> => {
      const atom = Client.runtime.atom(() => Client.use(use));
      return Effect.runPromise(AtomRegistry.getResult(registry, atom));
    },
  };
}
