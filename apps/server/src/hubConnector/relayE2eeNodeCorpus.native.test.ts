import { afterAll, describe, expect, it } from "vite-plus/test";

import { installCountedE2eeNodeNativePrimitives } from "@ryco/shared/relayE2eeCorpusNative";

// docs/relay-e2ee-protocol.md §14.7: the node half of the §16 corpus must pass
// with the native implementations installed — as `HubConnectorLive` installs
// them in production — as well as absent. `relayE2eeNodeCorpus.test.ts` is the
// absent leg; this file runs the same suites with the `node:crypto` provider
// installed before they load, and checks that they reached it.

const native = installCountedE2eeNodeNativePrimitives();
afterAll(() => native.uninstall());

describe("§14.7 node corpus with the native implementations installed", () => {
  it("runs on a runtime where every native primitive passed its self-test", () => {
    expect(native.support()).toEqual({
      x25519: true,
      ed25519: true,
      p256: true,
      chacha20Poly1305: true,
    });
  });
});

await import("./relayE2eeNodeCorpus.test.ts");

describe("§14.7 native leg coverage of the node corpus", () => {
  it("answered the node corpus through the native key and signature primitives", () => {
    // The node corpus's records are all shorter than the native AEAD's
    // `minBytes`, so noble seals them either way; `relayE2eeCorpus.native.test.ts`
    // in `packages/shared` covers the native AEAD.
    expect(native.used()).toEqual(expect.arrayContaining(["ed25519", "p256", "x25519"]));
  });
});
