import { describe, expect, it } from "vite-plus/test";

import { isLoopbackHostname } from "./loopbackHost.ts";

describe("isLoopbackHostname", () => {
  it("accepts localhost, 127/8 and ::1 in any case, bracketed or bare", () => {
    for (const host of ["localhost", "LOCALHOST", " localhost ", "127.0.0.1", "127.0.0.2"]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
    for (const host of ["::1", "[::1]", "127.255.255.255"]) {
      expect(isLoopbackHostname(host), host).toBe(true);
    }
  });

  it("rejects other hosts, an empty host and malformed 127 addresses", () => {
    for (const host of [
      "",
      "0.0.0.0",
      "::",
      "192.168.1.10",
      "example.com",
      "app.localhost",
      "localhost.",
      "127.example.com",
      "127.0.0.256",
      "127.1",
    ]) {
      expect(isLoopbackHostname(host), host).toBe(false);
    }
  });

  it("limits IPv4 to 127.0.0.1 when asked", () => {
    expect(isLoopbackHostname("127.0.0.1", { ipv4: "127.0.0.1" })).toBe(true);
    expect(isLoopbackHostname("127.0.0.2", { ipv4: "127.0.0.1" })).toBe(false);
    expect(isLoopbackHostname("[::1]", { ipv4: "127.0.0.1" })).toBe(true);
  });

  it("keeps the 127-prefix answer for callers that relied on it", () => {
    expect(isLoopbackHostname("127.0.0.2", { ipv4: "127-prefix" })).toBe(true);
    expect(isLoopbackHostname("127.example.com", { ipv4: "127-prefix" })).toBe(true);
    expect(isLoopbackHostname("128.0.0.1", { ipv4: "127-prefix" })).toBe(false);
  });

  it("counts the unspecified address only when asked", () => {
    expect(isLoopbackHostname("0.0.0.0", { unspecified: true })).toBe(true);
    expect(isLoopbackHostname("::", { unspecified: true })).toBe(false);
  });

  it("counts localhost subdomains only when asked", () => {
    expect(isLoopbackHostname("app.localhost", { localhostSubdomains: true })).toBe(true);
    expect(isLoopbackHostname("localhost.example.com", { localhostSubdomains: true })).toBe(false);
  });
});
