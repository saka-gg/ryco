import { describe, expect, it } from "vite-plus/test";

import { HUB_LOOPBACK_HOST, hubKeyAddress, normalizeHubBaseUrl } from "./cliProxyHubUrl.ts";
import { isLoopbackHostname } from "./loopbackHost.ts";

describe("normalizeHubBaseUrl", () => {
  it("accepts http(s) bases and strips pasted management paths", () => {
    expect(normalizeHubBaseUrl("http://127.0.0.1:8317/")).toBe("http://127.0.0.1:8317");
    expect(normalizeHubBaseUrl(" https://hub.example.ts.net/v0/management ")).toBe(
      "https://hub.example.ts.net",
    );
    expect(normalizeHubBaseUrl("https://hub.example/proxy/v8/management/credentials")).toBe(
      "https://hub.example/proxy",
    );
    expect(normalizeHubBaseUrl("https://hub.example/management.html")).toBe("https://hub.example");
  });

  it("rejects other schemes, embedded credentials and garbage", () => {
    expect(normalizeHubBaseUrl("file:///etc/passwd")).toBeNull();
    expect(normalizeHubBaseUrl("https://user:pass@hub.example")).toBeNull();
    expect(normalizeHubBaseUrl("not a url")).toBeNull();
  });
});

describe("hubKeyAddress", () => {
  it("binds a key to scheme, host and port, with loopback hosts interchangeable", () => {
    expect(hubKeyAddress("http://127.0.0.1:8317/v0/management")).toBe("http://localhost:8317");
    expect(hubKeyAddress("http://localhost:8317/proxy")).toBe("http://localhost:8317");
    expect(hubKeyAddress("https://hub.example")).not.toBe(hubKeyAddress("http://hub.example"));
    expect(hubKeyAddress("https://hub.example")).not.toBe(hubKeyAddress("https://evil.example"));
    expect(hubKeyAddress("https://hub.example:8443")).not.toBe(
      hubKeyAddress("https://hub.example"),
    );
    expect(hubKeyAddress("https://admin:pass@hub.example/")).toBe("https://hub.example");
    expect(hubKeyAddress("ftp://hub.example")).toBeNull();
  });

  it("knows the loopback names", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]) {
      expect(isLoopbackHostname(host, HUB_LOOPBACK_HOST), host).toBe(true);
    }
    expect(isLoopbackHostname("127.0.0.2", HUB_LOOPBACK_HOST)).toBe(false);
    expect(isLoopbackHostname("hub.example", HUB_LOOPBACK_HOST)).toBe(false);
    expect(hubKeyAddress("http://0.0.0.0:8317")).toBe(hubKeyAddress("http://127.0.0.1:8317"));
  });
});
