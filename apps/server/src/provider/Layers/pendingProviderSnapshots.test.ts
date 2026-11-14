import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";
import {
  ClaudeSettings,
  CodexSettings,
  CopilotSettings,
  CursorSettings,
  GrokSettings,
  OpenCodeSettings,
} from "@ryco/contracts";

import { makePendingClaudeProvider } from "./ClaudeProvider.ts";
import { makePendingCodexProvider } from "./CodexProvider.ts";
import { makePendingCopilotProvider } from "./CopilotProvider.ts";
import { buildInitialCursorProviderSnapshot } from "./CursorProvider.ts";
import { buildInitialGrokProviderSnapshot } from "./GrokProvider.ts";
import { makePendingOpenCodeProvider } from "./OpenCodeProvider.ts";

// Pins each provider's snapshot before its first probe. The providers still differ: Copilot,
// Cursor and Grok guess `installed: true` and say "Checking ...", the others guess
// `installed: false` and say "... has not been checked in this session yet.".
const pendingCases = [
  {
    name: "Claude",
    build: (enabled: boolean) =>
      makePendingClaudeProvider(Schema.decodeSync(ClaudeSettings)({ enabled })),
    installed: false,
    message: "Claude provider status has not been checked in this session yet.",
    disabledMessage: "Claude is disabled in Ryco settings.",
  },
  {
    name: "Codex",
    build: (enabled: boolean) =>
      makePendingCodexProvider(Schema.decodeSync(CodexSettings)({ enabled })),
    installed: false,
    message: "Codex provider status has not been checked in this session yet.",
    disabledMessage: "Codex is disabled in Ryco settings.",
  },
  {
    name: "OpenCode",
    build: (enabled: boolean) =>
      makePendingOpenCodeProvider(Schema.decodeSync(OpenCodeSettings)({ enabled })),
    installed: false,
    message: "OpenCode provider status has not been checked in this session yet.",
    disabledMessage: "OpenCode is disabled in Ryco settings.",
  },
  {
    name: "GitHub Copilot",
    build: (enabled: boolean) =>
      makePendingCopilotProvider(Schema.decodeSync(CopilotSettings)({ enabled })),
    installed: true,
    message: "Checking GitHub Copilot availability...",
    disabledMessage: "GitHub Copilot is disabled in Ryco settings.",
  },
  {
    name: "Cursor",
    build: (enabled: boolean) =>
      buildInitialCursorProviderSnapshot(Schema.decodeSync(CursorSettings)({ enabled })),
    installed: true,
    message: "Checking Cursor Agent availability...",
    disabledMessage: "Cursor is disabled in Ryco settings.",
  },
  {
    name: "Grok",
    build: (enabled: boolean) =>
      buildInitialGrokProviderSnapshot(Schema.decodeSync(GrokSettings)({ enabled })),
    installed: true,
    message: "Checking Grok CLI availability...",
    disabledMessage: "Grok is disabled in Ryco settings.",
  },
] as const;

describe("pending provider snapshots", () => {
  it.each(pendingCases)("$name keeps its pending snapshot", (testCase) => {
    expect(testCase.build(true)).toMatchObject({
      displayName: testCase.name,
      enabled: true,
      installed: testCase.installed,
      version: null,
      status: "warning",
      auth: { status: "unknown" },
      message: testCase.message,
      skills: [],
      slashCommands: [],
    });
  });

  it.each(pendingCases)("$name keeps its disabled snapshot", (testCase) => {
    expect(testCase.build(false)).toMatchObject({
      displayName: testCase.name,
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      message: testCase.disabledMessage,
    });
  });

  it("names a configured OpenCode server URL when OpenCode is disabled", () => {
    const snapshot = makePendingOpenCodeProvider(
      Schema.decodeSync(OpenCodeSettings)({ enabled: false, serverUrl: "http://127.0.0.1:4096" }),
    );
    expect(snapshot.message).toBe(
      "OpenCode is disabled in Ryco settings. A server URL is configured.",
    );
  });
});
