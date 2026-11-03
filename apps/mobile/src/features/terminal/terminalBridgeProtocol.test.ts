import { describe, expect, it } from "vite-plus/test";

import {
  boundTerminalHistory,
  chunkTerminalBridgeData,
  decodeNativeTerminalMessage,
  decodeRendererTerminalMessage,
  encodeNativeTerminalMessage,
  MAX_RENDERER_HISTORY_BYTES,
  MAX_TERMINAL_SELECTION_BYTES,
  TERMINAL_HISTORY_OMISSION_MARKER,
  utf8ByteLength,
} from "./terminalBridgeProtocol";

describe("terminal renderer protocol", () => {
  it("chunks renderer output by UTF-8 bytes without splitting Unicode", () => {
    expect(chunkTerminalBridgeData("ab😀cd", 5)).toEqual(["ab", "😀c", "d"]);
    expect(chunkTerminalBridgeData("😀", 1)).toEqual(["😀"]);
  });

  it("decodes every renderer tag exactly and rejects unexpected fields", () => {
    expect(decodeRendererTerminalMessage('{"type":"ready","rendererVersion":"2"}')).toEqual({
      type: "ready",
      rendererVersion: "2",
    });
    expect(
      decodeRendererTerminalMessage('{"type":"resize","terminalId":"default","cols":80,"rows":24}'),
    ).toEqual({ type: "resize", terminalId: "default", cols: 80, rows: 24 });
    expect(
      decodeRendererTerminalMessage(
        '{"type":"modes","terminalId":"default","bracketedPaste":true}',
      ),
    ).toEqual({ type: "modes", terminalId: "default", bracketedPaste: true });
    expect(
      decodeRendererTerminalMessage('{"type":"hydrated","terminalId":"default","hydration":3}'),
    ).toEqual({ type: "hydrated", terminalId: "default", hydration: 3 });
    expect(
      decodeRendererTerminalMessage(
        '{"type":"input","terminalId":"default","data":"ls\\r","extra":true}',
      ),
    ).toBeNull();
    expect(decodeRendererTerminalMessage('{"type":"unknown"}')).toBeNull();
    expect(decodeRendererTerminalMessage({ type: "ready", rendererVersion: "2" })).toBeNull();
  });

  it("rejects malformed, invalid and oversized renderer data", () => {
    expect(decodeRendererTerminalMessage("not-json")).toBeNull();
    expect(
      decodeRendererTerminalMessage(
        JSON.stringify({ type: "resize", terminalId: "default", cols: 0, rows: 24 }),
      ),
    ).toBeNull();
    expect(
      decodeRendererTerminalMessage(
        JSON.stringify({ type: "input", terminalId: "default", data: "x".repeat(65_537) }),
      ),
    ).toBeNull();
    expect(
      decodeRendererTerminalMessage(
        JSON.stringify({
          type: "selection",
          terminalId: "default",
          text: "x".repeat(MAX_TERMINAL_SELECTION_BYTES + 1),
        }),
      ),
    ).toBeNull();
    expect(
      decodeRendererTerminalMessage(JSON.stringify({ type: "fatal", code: "Has Spaces" })),
    ).toBeNull();
    expect(
      decodeRendererTerminalMessage(
        JSON.stringify({ type: "modes", terminalId: " padded ", bracketedPaste: true }),
      ),
    ).toBeNull();
  });

  it("accepts control bytes escaped in JSON up to the payload bound", () => {
    const data = "\u001b".repeat(60_000);
    expect(
      decodeRendererTerminalMessage(JSON.stringify({ type: "input", terminalId: "t", data })),
    ).toEqual({ type: "input", terminalId: "t", data });
  });

  it("encodes only bounded native messages and the renderer decodes them back", () => {
    const encoded = encodeNativeTerminalMessage({
      type: "write",
      terminalId: "default",
      sequence: 1,
      data: "hello",
    });
    expect(encoded).toBe('{"type":"write","terminalId":"default","sequence":1,"data":"hello"}');
    expect(decodeNativeTerminalMessage(encoded)).toEqual({
      type: "write",
      terminalId: "default",
      sequence: 1,
      data: "hello",
    });
    expect(
      encodeNativeTerminalMessage({
        type: "write",
        terminalId: "default",
        sequence: 1,
        data: "😀".repeat(20_000),
      }),
    ).toBeNull();
    expect(
      encodeNativeTerminalMessage({
        type: "appearance",
        fontSize: 12,
        colors: { background: "url(https://example.test)" },
      }),
    ).toBeNull();
    expect(decodeNativeTerminalMessage('{"type":"blur"}')).toEqual({ type: "blur" });
    expect(decodeNativeTerminalMessage('{"type":"blur","terminalId":"x"}')).toBeNull();
    expect(
      decodeNativeTerminalMessage(
        JSON.stringify({ type: "hydrate", terminalId: "t", hydration: 1, history: "x", extra: 1 }),
      ),
    ).toBeNull();
  });

  it("bounds history by UTF-8 bytes, complete lines and Unicode code points", () => {
    const bounded = boundTerminalHistory(`discard this line\n${"😀".repeat(20)}\nlast\n`, 72);
    expect(bounded.startsWith(TERMINAL_HISTORY_OMISSION_MARKER)).toBe(true);
    expect(bounded).not.toContain("discard this line");
    expect(bounded).not.toContain("\ud83d\n");
    expect(utf8ByteLength(bounded)).toBeLessThanOrEqual(72);
    expect(boundTerminalHistory("short")).toBe("short");
    expect(MAX_RENDERER_HISTORY_BYTES).toBe(2 * 1024 * 1024);
  });
});
