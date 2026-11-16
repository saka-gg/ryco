import { describe, expect, it } from "vite-plus/test";

import {
  buildPairingUrl,
  extractPairingToken,
  extractPairingUrlFromQrPayload,
  PairingQrPayloadEmptyError,
} from "./pairing";

describe("pairing", () => {
  it("folds host + code into a pairing URL whose token reads back", () => {
    const url = buildPairingUrl("node.local:44342", "tok-123");
    expect(new URL(url).origin).toBe("https://node.local:44342");
    expect(extractPairingToken(url)).toBe("tok-123");
  });

  it("extracts the pairing token from hash and query", () => {
    expect(extractPairingToken("ryco://pair#token=abc")).toBe("abc");
    expect(extractPairingToken("https://app.ryco.space/pair?token=def")).toBe("def");
    expect(extractPairingToken("ryco://pair")).toBeNull();
    expect(extractPairingToken("not a url")).toBeNull();
  });

  it("unwraps a ryco* QR scheme into the embedded pairing URL", () => {
    for (const scheme of ["ryco", "ryco-dev", "ryco-preview"]) {
      const inner = "https://node.local/#token=zzz";
      const payload = `${scheme}://pair?pairingUrl=${encodeURIComponent(inner)}`;
      expect(extractPairingUrlFromQrPayload(payload)).toBe(inner);
    }
  });

  it("passes a raw pairing URL through unchanged", () => {
    const raw = "ryco://pair?host=node.local#token=tok";
    // A ryco URL with no pairingUrl param is returned as-is for normal validation.
    expect(extractPairingUrlFromQrPayload(raw)).toBe(raw);
    expect(extractPairingUrlFromQrPayload("https://node.local/#token=tok")).toBe(
      "https://node.local/#token=tok",
    );
  });

  it("rejects an empty QR payload", () => {
    expect(() => extractPairingUrlFromQrPayload("   ")).toThrow(PairingQrPayloadEmptyError);
  });
});
