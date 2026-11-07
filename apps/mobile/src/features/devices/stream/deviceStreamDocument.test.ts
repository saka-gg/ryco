// The app's `tsconfig` is the react-native one, which resolves no Node builtins;
// this test runs under Node, so it pulls the types in for itself.
/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vite-plus/test";

import {
  buildDeviceStreamDocument,
  DEVICE_STREAM_DOCUMENT_PATH,
  deviceStreamContentSecurityPolicy,
} from "../../../../scripts/build-device-stream-renderer.mts";
import { inlineScriptHash } from "../../../../scripts/inlineRendererBundle.mts";
import { decodeBase64, decodeDeviceStreamPageMessage, encodeBase64 } from "./deviceStreamProtocol";

const checkedIn = readFileSync(DEVICE_STREAM_DOCUMENT_PATH, "utf8");

describe("device stream document", () => {
  it("is exactly what the generator builds from the current sources", async () => {
    // Regenerate with `bun run --cwd apps/mobile build:device-stream-renderer`.
    expect(await buildDeviceStreamDocument()).toBe(checkedIn);
  }, 60_000);

  it("admits only its own inline script and no network or storage", () => {
    const script = checkedIn.match(/<script>([\s\S]*)<\/script>/u)?.[1] ?? "";
    const csp = checkedIn.match(/Content-Security-Policy" content="([^"]+)"/u)?.[1];
    expect(csp).toBe(deviceStreamContentSecurityPolicy(inlineScriptHash(script)));
    expect(csp).toContain("connect-src 'none'");
    expect(checkedIn.match(/<script/gu)).toHaveLength(1);
    for (const sink of ["WebSocket", "fetch(", "XMLHttpRequest", "localStorage", "innerHTML"]) {
      expect(script).not.toContain(sink);
    }
  });
});

describe("device stream bridge", () => {
  it("round-trips base64", () => {
    for (const length of [0, 1, 2, 3, 4, 1_000, 65_537]) {
      const bytes = Uint8Array.from({ length }, (_, index) => (index * 31) & 255);
      const encoded = encodeBase64(bytes);
      expect(encoded).toBe(Buffer.from(bytes).toString("base64"));
      expect(decodeBase64(encoded)).toEqual(bytes);
    }
    expect(decodeBase64("abc")).toBeNull();
    expect(decodeBase64("ab$=")).toBeNull();
  });

  it("accepts only well-formed page messages and clamps touches to the frame", () => {
    expect(decodeDeviceStreamPageMessage('{"type":"touch","phase":"move","x":1.4,"y":-2}')).toEqual(
      { type: "touch", phase: "move", x: 1, y: 0 },
    );
    expect(decodeDeviceStreamPageMessage('{"type":"touch","phase":"tap","x":0,"y":0}')).toBeNull();
    expect(decodeDeviceStreamPageMessage('{"type":"ready","webCodecs":true}')).toEqual({
      type: "ready",
      webCodecs: true,
    });
    expect(decodeDeviceStreamPageMessage("not json")).toBeNull();
    expect(decodeDeviceStreamPageMessage('{"type":"unknown"}')).toBeNull();
  });
});
