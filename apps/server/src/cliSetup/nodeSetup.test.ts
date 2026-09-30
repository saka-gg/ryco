import { describe, expect, it } from "vite-plus/test";

import { EMPTY_NODE_CONFIG, nodeConfigAsServeArgs, parseNodeConfig } from "./nodeConfig.ts";
import { applyNodeSettings } from "./nodeSetup.ts";

describe("node settings", () => {
  it("keeps saved values a patch leaves out", () => {
    const saved = applyNodeSettings(EMPTY_NODE_CONFIG, {
      workspace: "/Users/me/code",
      tailscaleServe: true,
      hubEnabled: true,
      hubNodeName: "Mac mini",
      preventSleep: true,
    });
    const patched = applyNodeSettings(saved, { host: "0.0.0.0" });

    expect(patched).toEqual({
      version: 1,
      workspace: "/Users/me/code",
      host: "0.0.0.0",
      tailscaleServe: true,
      hub: { enabled: true, nodeName: "Mac mini" },
      preventSleep: true,
    });
  });

  it("turns the Hub off without forgetting its other settings", () => {
    const saved = applyNodeSettings(EMPTY_NODE_CONFIG, {
      hubEnabled: true,
      hubNodeName: "Mac mini",
    });
    expect(applyNodeSettings(saved, { hubEnabled: false }).hub).toEqual({
      enabled: false,
      nodeName: "Mac mini",
    });
  });

  it("shows saved settings as the equivalent serve flags", () => {
    expect(
      nodeConfigAsServeArgs({
        version: 1,
        workspace: "/Users/me/code",
        host: "127.0.0.1",
        tailscaleServe: true,
        hub: { enabled: true, nodeName: "Mac mini" },
        preventSleep: true,
      }),
    ).toEqual([
      "--host",
      "127.0.0.1",
      "--tailscale-serve",
      "--hub",
      "--hub-node-name",
      "Mac mini",
      "--prevent-sleep",
      "/Users/me/code",
    ]);
  });

  it("rejects hand edits it does not understand instead of ignoring them", () => {
    expect(() => parseNodeConfig('{"version":1,"hots":"0.0.0.0"}', "node.json")).toThrow(
      /does not understand/u,
    );
    expect(() => parseNodeConfig("{", "node.json")).toThrow(/not valid JSON/u);
    expect(parseNodeConfig('{"version":1,"port":4000}', "node.json")).toEqual({
      version: 1,
      port: 4000,
    });
  });
});
