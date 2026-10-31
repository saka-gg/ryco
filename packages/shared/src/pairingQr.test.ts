import { describe, expect, it } from "vite-plus/test";

import { isHostUnreachableFromAnotherDevice, pairingQrUrl } from "./pairingQr.ts";

describe("pairingQrUrl", () => {
  it("never draws a QR code for an address only this computer can reach", () => {
    for (const host of [
      "localhost",
      "localhost.",
      "app.localhost",
      "127.0.0.1",
      "127.8.9.10",
      "[::1]",
      "[::ffff:127.0.0.1]",
      "0.0.0.0",
      "[::]",
    ]) {
      expect(pairingQrUrl(`http://${host}:3773/pair#token=PAIRCODE`), host).toBeNull();
    }
    expect(pairingQrUrl("not a url")).toBeNull();
  });

  it("keeps links another device can open", () => {
    expect(pairingQrUrl("http://192.168.1.5:3773/pair#token=PAIRCODE")).toBe(
      "http://192.168.1.5:3773/pair#token=PAIRCODE",
    );
    expect(isHostUnreachableFromAnotherDevice("node.tail1234.ts.net")).toBe(false);
    expect(isHostUnreachableFromAnotherDevice("100.84.12.7")).toBe(false);
  });
});
