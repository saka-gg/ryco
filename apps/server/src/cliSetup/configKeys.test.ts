import { describe, expect, it } from "vite-plus/test";

import { formatNodeConfig, setConfigKey, unsetConfigKey } from "./configKeys.ts";
import { EMPTY_NODE_CONFIG } from "./nodeConfig.ts";

describe("ryco config keys", () => {
  it("parses values the way the matching serve flag would", () => {
    let config = setConfigKey(EMPTY_NODE_CONFIG, "hub", "on");
    config = setConfigKey(config, "hub-origin", "https://hub.example/");
    config = setConfigKey(config, "port", "4000");
    config = setConfigKey(config, "prevent-sleep", "no");
    config = setConfigKey(config, "hub-e2ee-policy", "require-e2ee");
    expect(config).toEqual({
      version: 1,
      port: 4000,
      hub: { enabled: true, origin: "https://hub.example", e2eePolicy: "require-e2ee" },
      preventSleep: false,
    });
  });

  it("rejects values the server would refuse", () => {
    expect(() => setConfigKey(EMPTY_NODE_CONFIG, "port", "70000")).toThrow(/between 1 and 65535/u);
    expect(() => setConfigKey(EMPTY_NODE_CONFIG, "hub", "maybe")).toThrow(/true or false/u);
    expect(() => setConfigKey(EMPTY_NODE_CONFIG, "hub-origin", "http://hub.example")).toThrow(
      /https:\/\//u,
    );
    expect(() => setConfigKey(EMPTY_NODE_CONFIG, "hub-e2ee-policy", "strict")).toThrow(/one of/u);
    expect(() => setConfigKey(EMPTY_NODE_CONFIG, "colour", "blue")).toThrow(/Unknown setting/u);
  });

  it("returns one setting to its default and leaves the rest", () => {
    const config = setConfigKey(
      setConfigKey(EMPTY_NODE_CONFIG, "hub", "true"),
      "hub-node-name",
      "Mini",
    );
    expect(unsetConfigKey(config, "hub-node-name").hub).toEqual({ enabled: true });
    expect(unsetConfigKey(config, "hub").hub).toBeUndefined();
  });

  it("lists every setting, marking unsaved ones as defaults", () => {
    const lines = formatNodeConfig(setConfigKey(EMPTY_NODE_CONFIG, "port", "4000")).split("\n");
    expect(lines.find((line) => line.startsWith("port"))).toMatch(/4000$/u);
    expect(lines.find((line) => line.startsWith("host"))).toMatch(/\(default\)$/u);
  });
});
