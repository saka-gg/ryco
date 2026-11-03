import { CliProxyHubReads, cliProxyHubsSupported } from "@ryco/client-runtime/usage";

import { readRpcClient } from "../connection/environmentApi";
import {
  getEnvironmentServerConfigsSnapshot,
  readEnvironmentServerConfig,
  subscribeEnvironmentServerConfigs,
} from "./environmentServerConfigs";

/**
 * This app's CLIProxyAPI hub reads, by the policy every client shares
 * (`@ryco/client-runtime/usage` `CliProxyHubReads`): a read answers again for 30 s, identical
 * reads join, and a node that predates hubs is not asked. The Limits tab reads through it; views
 * that only follow hubs (widgets) read its snapshot.
 */
export const mobileCliProxyHubReads = new CliProxyHubReads({
  readHubs: (environmentId, input) => {
    const client = readRpcClient(environmentId);
    return client
      ? client.server.readCliProxyHubs(input)
      : Promise.reject(new Error("This device is reconnecting. Try again when it is connected."));
  },
  supportsHubs: (environmentId) =>
    cliProxyHubsSupported(readEnvironmentServerConfig(environmentId)),
});

// A node whose config is dropped (released, removed, or its account ended) no longer speaks for
// its hubs: what it last reported goes with it.
let knownConfigs = getEnvironmentServerConfigsSnapshot();
subscribeEnvironmentServerConfigs(() => {
  const next = getEnvironmentServerConfigsSnapshot();
  for (const environmentId of knownConfigs.keys()) {
    if (!next.has(environmentId)) mobileCliProxyHubReads.forget(environmentId);
  }
  knownConfigs = next;
});
