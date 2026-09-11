/**
 * Hosted-topology boundary assertions for the private Agent Control MCP
 * listener: none of the surfaces a browser, hub relay, or remote client
 * can read may carry the private endpoint or anything derived from it.
 *
 * The listener itself is built on a raw `node:http` server and never
 * touches the shared `HttpServer.HttpServer` tag — the tag that feeds
 * every surface asserted on below.
 */
import { ExecutionEnvironmentCapabilities, ExecutionEnvironmentDescriptor } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { resolveServerAdvertisedEndpoints } from "../../remote/AdvertisedEndpointRegistry.ts";
import { makePersistedServerRuntimeState } from "../../serverRuntimeState.ts";

describe("server-runtime.json shape", () => {
  it("persists only the public server address fields", () => {
    const state = makePersistedServerRuntimeState({ config: { host: undefined }, port: 3773 });
    expect(Object.keys(state).toSorted()).toEqual([
      "origin",
      "pid",
      "port",
      "startedAt",
      "version",
    ]);
    expect(state.port).toBe(3773);
    expect(state.origin).toBe("http://127.0.0.1:3773");
    const serialized = JSON.stringify(state);
    expect(serialized).not.toContain("mcp");
    expect(serialized).not.toContain("agentControl");
    expect(serialized).not.toContain("rycoac_");
  });
});

describe("pre-auth server environment descriptor", () => {
  it("has no field that could carry the private endpoint or credential", () => {
    // `/.well-known/ryco/environment` serves this schema unauthenticated,
    // and the Hub embeds it into enrollment metadata. Its closed field set
    // is the guarantee that the MCP endpoint cannot leak through it.
    expect(Object.keys(ExecutionEnvironmentDescriptor.fields).toSorted()).toEqual([
      "capabilities",
      "environmentId",
      "label",
      "platform",
      "serverVersion",
    ]);
    expect(Object.keys(ExecutionEnvironmentCapabilities.fields).toSorted()).toEqual([
      "environmentIcon",
      "fileAttachments",
      "projectIcons",
      "repositoryIdentity",
      "threadPriorityRanking",
      "threadSettlement",
      "threadSnooze",
    ]);
  });
});

describe("advertised endpoints", () => {
  it("derives exclusively from the main server port", () => {
    const mainPort = 3773;
    const endpoints = resolveServerAdvertisedEndpoints({
      host: "0.0.0.0",
      port: mainPort,
      networkInterfaces: {
        en0: [
          {
            address: "192.168.1.50",
            netmask: "255.255.255.0",
            family: "IPv4",
            mac: "00:00:00:00:00:00",
            internal: false,
            cidr: "192.168.1.50/24",
          },
        ],
      },
    });
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(new URL(endpoint.httpBaseUrl).port).toBe(String(mainPort));
    }
  });
});
