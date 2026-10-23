import type { ServerConfig } from "@ryco/contracts";
import { describe, expect, it } from "vite-plus/test";

import { selectTerminalWriteRequireIdleSupported } from "./requireIdle.ts";

const configWith = (capabilities: Record<string, unknown>) =>
  ({ environment: { capabilities } }) as unknown as ServerConfig;

describe("selectTerminalWriteRequireIdleSupported", () => {
  it("relies on requireIdle only where the node advertises it", () => {
    expect(selectTerminalWriteRequireIdleSupported(null)).toBe(false);
    expect(selectTerminalWriteRequireIdleSupported(configWith({}))).toBe(false);
    expect(
      selectTerminalWriteRequireIdleSupported(configWith({ terminalWriteRequireIdle: false })),
    ).toBe(false);
    expect(
      selectTerminalWriteRequireIdleSupported(configWith({ terminalWriteRequireIdle: true })),
    ).toBe(true);
  });
});
