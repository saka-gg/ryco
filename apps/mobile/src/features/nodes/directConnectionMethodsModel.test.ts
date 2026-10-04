import { describe, expect, it } from "vite-plus/test";

import {
  canSubmitDirectConnection,
  DIRECT_CONNECTION_METHODS,
  directRepairPrefill,
} from "./directConnectionMethodsModel";

describe("direct connection methods", () => {
  it("presents pairing URL, LAN, and Tailscale as direct methods", () => {
    expect(DIRECT_CONNECTION_METHODS.map((method) => method.id)).toEqual([
      "url",
      "lan",
      "tailscale",
    ]);
    expect(DIRECT_CONNECTION_METHODS.find((method) => method.id === "tailscale")?.detail).toContain(
      "no Hub account",
    );
  });

  it("requires both host and pairing code for address-based pairing", () => {
    expect(
      canSubmitDirectConnection({ mode: "url", pairingUrl: "ryco://pair", host: "", code: "" }),
    ).toBe(true);
    expect(
      canSubmitDirectConnection({ mode: "lan", pairingUrl: "", host: "mac.local", code: "" }),
    ).toBe(false);
    expect(
      canSubmitDirectConnection({
        mode: "tailscale",
        pairingUrl: "",
        host: "studio.tail.ts.net",
        code: "secret",
      }),
    ).toBe(true);
  });
});

describe("directRepairPrefill", () => {
  it("starts pairing again from the saved address, keeping its scheme", () => {
    expect(directRepairPrefill("http://macbook.local:44342/")).toEqual({
      mode: "lan",
      host: "http://macbook.local:44342",
    });
    expect(directRepairPrefill("https://studio.tail1234.ts.net/")).toEqual({
      mode: "tailscale",
      host: "https://studio.tail1234.ts.net",
    });
  });

  it("keeps a saved address that is more than an origin as it is", () => {
    expect(directRepairPrefill("https://proxy.example.com/ryco/")).toEqual({
      mode: "lan",
      host: "https://proxy.example.com/ryco/",
    });
  });
});
