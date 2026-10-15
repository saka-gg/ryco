import { afterAll, describe, expect, it } from "vite-plus/test";

import { installCountedE2eeNodeNativePrimitives } from "./relayE2eeCorpusNative.ts";

// docs/relay-e2ee-protocol.md §14.7: the §16 corpus must pass with the native
// implementations installed as well as absent. `relayE2eeCorpus.test.ts` is
// the absent leg; this file runs the same suites with the `node:crypto`
// provider installed before they load, and checks that they reached it.

const native = installCountedE2eeNodeNativePrimitives();
afterAll(() => native.uninstall());

describe("§14.7 corpus with the native implementations installed", () => {
  it("runs on a runtime where every native primitive passed its self-test", () => {
    expect(native.support()).toEqual({
      x25519: true,
      ed25519: true,
      p256: true,
      chacha20Poly1305: true,
    });
  });
});

await import("./relayE2eeCorpus.test.ts");

describe("§14.7 native leg coverage", () => {
  it("answered the corpus through every native primitive", () => {
    expect(native.used()).toEqual(["chacha20Poly1305", "ed25519", "p256", "x25519"]);
  });
});
