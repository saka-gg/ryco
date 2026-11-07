import { describe, expect, it } from "vitest";

import {
  DEVICE_LIVE_INPUT_MAX_MESSAGE_BYTES,
  chunkDeviceLiveText,
  decodeDeviceLiveInput,
  decodeDeviceLiveInputServerMessage,
} from "./deviceLiveInput.ts";

describe("device live input messages", () => {
  it("reads touches, keys and paste chunks from text or bytes", () => {
    const touch = JSON.stringify({ type: "device.touch", phase: "move", x: 12.5, y: 400 });
    expect(decodeDeviceLiveInput(touch)).toEqual({
      type: "device.touch",
      phase: "move",
      x: 12.5,
      y: 400,
    });
    expect(decodeDeviceLiveInput(new TextEncoder().encode(touch))).not.toBeNull();
    expect(
      decodeDeviceLiveInput(JSON.stringify({ type: "device.key", usage: 0xe1, phase: "down" })),
    ).toEqual({ type: "device.key", usage: 0xe1, phase: "down" });
    expect(
      decodeDeviceLiveInput(
        JSON.stringify({ type: "device.paste", text: "hé", group: 2, final: true }),
      ),
    ).toEqual({ type: "device.paste", text: "hé", group: 2, final: true });
  });

  it("rejects anything that is not well-formed input", () => {
    const bad = [
      "not json",
      "[]",
      JSON.stringify({ type: "device.frame.resync" }),
      JSON.stringify({ type: "device.touch", phase: "hover", x: 1, y: 1 }),
      JSON.stringify({ type: "device.touch", phase: "down", x: -1, y: 1 }),
      JSON.stringify({ type: "device.touch", phase: "down", x: Number.NaN, y: 1 }),
      JSON.stringify({ type: "device.key", usage: 0, phase: "down" }),
      JSON.stringify({ type: "device.key", usage: 1.5, phase: "down" }),
      JSON.stringify({ type: "device.paste", text: "x".repeat(257), group: 1, final: true }),
      JSON.stringify({ type: "device.paste", text: "x", final: true }),
      " ".repeat(DEVICE_LIVE_INPUT_MAX_MESSAGE_BYTES + 1),
    ];
    for (const message of bad) expect(decodeDeviceLiveInput(message)).toBeNull();
  });

  it("reads the server's readiness and error messages", () => {
    expect(
      decodeDeviceLiveInputServerMessage(
        JSON.stringify({ type: "device.input.ready", input: false }),
      ),
    ).toEqual({ type: "device.input.ready", input: false });
    expect(
      decodeDeviceLiveInputServerMessage(
        JSON.stringify({ type: "device.input.error", input: "touch", message: "gone" }),
      ),
    ).toEqual({ type: "device.input.error", input: "touch", message: "gone" });
    expect(
      decodeDeviceLiveInputServerMessage(JSON.stringify({ type: "device.input.ready" })),
    ).toBeNull();
  });

  it("chunks text without splitting a surrogate pair", () => {
    const text = `${"a".repeat(3)}😀b`;
    const chunks = chunkDeviceLiveText(text, 4);
    expect(chunks.join("")).toBe(text);
    expect(chunks).toEqual(["aaa", "😀b"]);
    expect(chunkDeviceLiveText("")).toEqual([]);
    expect(chunkDeviceLiveText("😀", 1).join("")).toBe("😀");
  });
});
