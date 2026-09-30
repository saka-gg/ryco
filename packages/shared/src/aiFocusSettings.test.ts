import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerConfig,
  type ServerProvider,
} from "@ryco/contracts";
import { DEFAULT_CLIENT_SETTINGS, DEFAULT_SERVER_SETTINGS } from "@ryco/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import {
  AI_FOCUS_DISCLOSURE_FIELDS,
  makeAiFocusClientSettingsPatch,
  makeAiFocusModelOverridePatch,
  resolveAiFocusEnvironmentRows,
  selectAiFocusManualRefreshTargets,
} from "./aiFocusSettings.ts";

const envA = EnvironmentId.make("environment-a");
const envB = EnvironmentId.make("environment-b");
const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude-work");

function provider(
  instanceId: ProviderInstanceId,
  overrides?: Partial<ServerProvider>,
): ServerProvider {
  return {
    instanceId,
    driver: ProviderDriverKind.make(instanceId === codex ? "codex" : "claudeAgent"),
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-08-25T10:00:00.000Z",
    models: [
      {
        slug: instanceId === codex ? "gpt-5.4" : "claude-sonnet",
        name: instanceId === codex ? "GPT-5.4" : "Claude Sonnet",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    ...overrides,
  } as unknown as ServerProvider;
}

function config(input?: {
  supported?: boolean;
  override?: ServerConfig["settings"]["inboxPriorityModelSelection"];
  providers?: ReadonlyArray<ServerProvider>;
}): ServerConfig {
  return {
    environment: {
      environmentId: envA,
      label: "Node A",
      platform: "darwin",
      capabilities: {
        remoteAccess: false,
        desktopSsh: false,
        threadPriorityRanking: input?.supported ?? true,
      },
    },
    settings: {
      ...DEFAULT_SERVER_SETTINGS,
      textGenerationModelSelection: { instanceId: codex, model: "gpt-5.4" },
      inboxPriorityModelSelection: input?.override ?? null,
    },
    providers: [...(input?.providers ?? [provider(codex), provider(claude)])],
    keybindings: { rules: [], issues: [] },
    availableEditors: [],
    keybindingsConfigPath: null,
    observability: null,
  } as unknown as ServerConfig;
}

describe("AI Focus settings", () => {
  it("defaults to disabled with a ten-minute refresh", () => {
    expect(DEFAULT_CLIENT_SETTINGS.aiFocusEnabled).toBe(false);
    expect(DEFAULT_CLIENT_SETTINGS.aiFocusRefreshIntervalMs).toBe(10 * 60_000);
  });

  it("writes enablement and interval as client-only keys", () => {
    expect(makeAiFocusClientSettingsPatch({ enabled: true })).toEqual({ aiFocusEnabled: true });
    expect(makeAiFocusClientSettingsPatch({ refreshIntervalMs: 0 })).toEqual({
      aiFocusRefreshIntervalMs: 0,
    });
  });

  it("inherits text generation independently for each environment", () => {
    const second = config({
      override: { instanceId: claude, model: "claude-sonnet" },
    });
    const rows = resolveAiFocusEnvironmentRows([
      { environmentId: envA, label: "Node A", connected: true, serverConfig: config() },
      { environmentId: envB, label: "Node B", connected: true, serverConfig: second },
    ]);

    expect(rows[0]).toMatchObject({
      environmentId: envA,
      inherited: true,
      effectiveModelSelection: { instanceId: codex, model: "gpt-5.4" },
    });
    expect(rows[1]).toMatchObject({
      environmentId: envB,
      inherited: false,
      effectiveModelSelection: { instanceId: claude, model: "claude-sonnet" },
    });
  });

  it("accepts an available override and rejects an unavailable instance", () => {
    const serverConfig = config();
    expect(
      makeAiFocusModelOverridePatch({
        serverConfig,
        selection: { instanceId: claude, model: "claude-sonnet" },
      }),
    ).toEqual({
      inboxPriorityModelSelection: { instanceId: claude, model: "claude-sonnet" },
    });

    expect(() =>
      makeAiFocusModelOverridePatch({
        serverConfig: config({
          providers: [provider(codex), provider(claude, { enabled: false })],
        }),
        selection: { instanceId: claude, model: "claude-sonnet" },
      }),
    ).toThrow("not available");
  });

  it("keeps mixed-version support and refresh eligibility environment-local", () => {
    const rows = resolveAiFocusEnvironmentRows([
      { environmentId: envA, label: "New node", connected: true, serverConfig: config() },
      {
        environmentId: envB,
        label: "Old node",
        connected: true,
        serverConfig: config({ supported: false }),
      },
      {
        environmentId: EnvironmentId.make("environment-c"),
        label: "Offline node",
        connected: false,
        serverConfig: config(),
      },
    ]);
    expect(rows.map((row) => row.supported)).toEqual([true, false, true]);
    expect(selectAiFocusManualRefreshTargets(rows)).toEqual([envA]);
  });

  it("discloses exactly the metadata sent for ranking", () => {
    expect(AI_FOCUS_DISCLOSURE_FIELDS).toEqual([
      "Thread titles",
      "Project or repository names",
      "Branch names",
      "Bucketed creation and activity age",
      "Running, approval, input, queue, failure, and delivery state",
      "Pull request or linked issue title and state",
      "Up to 600 characters from the latest user request",
    ]);
  });
});
