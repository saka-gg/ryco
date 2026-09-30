import { describe, expect, it } from "vite-plus/test";

import { resolveServerAdvertisedEndpoints } from "./AdvertisedEndpointRegistry.ts";

describe("resolveServerAdvertisedEndpoints", () => {
  it("advertises only loopback when the server binds to localhost", () => {
    expect(
      resolveServerAdvertisedEndpoints({
        host: "127.0.0.1",
        port: 3773,
        networkInterfaces: {},
      }),
    ).toEqual([
      {
        id: "server-loopback:3773",
        label: "This machine",
        provider: {
          id: "server-core",
          label: "Server",
          kind: "core",
          isAddon: false,
        },
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
        reachability: "loopback",
        compatibility: {
          hostedHttpsApp: "mixed-content-blocked",
          desktopApp: "compatible",
        },
        source: "server",
        status: "available",
        description: "Loopback endpoint for this server.",
      },
    ]);
  });

  it("advertises loopback and LAN endpoints when the server binds to all interfaces", () => {
    expect(
      resolveServerAdvertisedEndpoints({
        host: "0.0.0.0",
        port: 3773,
        networkInterfaces: {
          en0: [
            {
              address: "192.168.1.44",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "192.168.1.44/24",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }),
    ).toEqual([
      {
        id: "server-loopback:3773",
        label: "This machine",
        provider: {
          id: "server-core",
          label: "Server",
          kind: "core",
          isAddon: false,
        },
        httpBaseUrl: "http://127.0.0.1:3773/",
        wsBaseUrl: "ws://127.0.0.1:3773/",
        reachability: "loopback",
        compatibility: {
          hostedHttpsApp: "mixed-content-blocked",
          desktopApp: "compatible",
        },
        source: "server",
        status: "available",
        description: "Loopback endpoint for this server.",
      },
      {
        id: "server-network:http://192.168.1.44:3773",
        label: "Local network",
        provider: {
          id: "server-core",
          label: "Server",
          kind: "core",
          isAddon: false,
        },
        httpBaseUrl: "http://192.168.1.44:3773/",
        wsBaseUrl: "ws://192.168.1.44:3773/",
        reachability: "lan",
        compatibility: {
          hostedHttpsApp: "mixed-content-blocked",
          desktopApp: "compatible",
        },
        source: "server",
        status: "available",
        isDefault: true,
        description: "Reachable from devices on the same network.",
      },
    ]);
  });

  it("classifies configured Tailscale hosts as private-network endpoints", () => {
    expect(
      resolveServerAdvertisedEndpoints({
        host: "100.64.0.2",
        port: 3773,
        networkInterfaces: {},
      }),
    ).toMatchObject([
      {},
      {
        id: "server-network:http://100.64.0.2:3773",
        reachability: "private-network",
        compatibility: {
          hostedHttpsApp: "mixed-content-blocked",
        },
      },
    ]);
  });

  it("treats an unset host as bound to all interfaces", () => {
    expect(
      resolveServerAdvertisedEndpoints({
        host: undefined,
        port: 3773,
        networkInterfaces: {
          en0: [
            {
              address: "192.168.1.44",
              family: "IPv4",
              internal: false,
              netmask: "255.255.255.0",
              cidr: "192.168.1.44/24",
              mac: "00:00:00:00:00:00",
            },
          ],
        },
      }).map((endpoint) => endpoint.httpBaseUrl),
    ).toEqual(["http://127.0.0.1:3773/", "http://192.168.1.44:3773/"]);
  });
});
