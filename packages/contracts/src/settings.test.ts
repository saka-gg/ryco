import { ENVIRONMENT_MACHINE_KINDS, ExecutionEnvironmentPlatform } from "./environment.ts";
import { describe, expect, it } from "vite-plus/test";
import { Schema } from "effect";

import { ProviderInstanceId } from "./providerInstance.ts";
import {
  AiFocusRefreshIntervalMs,
  ClientSettingsPatch,
  ClientSettingsSchema,
  DEFAULT_CLIENT_SETTINGS,
  DEFAULT_SERVER_SETTINGS,
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  SidebarAutoSettleAfterDays,
  ServerSettings,
  ServerSettingsPatch,
} from "./settings.ts";

const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);
const decodeServerSettingsPatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const decodeClientSettings = Schema.decodeUnknownSync(ClientSettingsSchema);
const decodeClientSettingsPatch = Schema.decodeUnknownSync(ClientSettingsPatch);

describe("Inbox auto-settle settings", () => {
  it("keeps historical clients opted out", () => {
    expect(decodeClientSettings({}).sidebarAutoSettleAfterDays).toBeNull();
    expect(DEFAULT_CLIENT_SETTINGS.sidebarAutoSettleAfterDays).toBeNull();
  });

  it("accepts Off and the supported day presets, but rejects arbitrary values", () => {
    const decodeAutoSettle = Schema.decodeUnknownSync(SidebarAutoSettleAfterDays);
    for (const days of [null, ...SIDEBAR_AUTO_SETTLE_DAY_OPTIONS]) {
      expect(decodeAutoSettle(days)).toBe(days);
      expect(decodeClientSettingsPatch({ sidebarAutoSettleAfterDays: days })).toMatchObject({
        sidebarAutoSettleAfterDays: days,
      });
    }
    expect(() => decodeAutoSettle(2)).toThrow();
  });
});

describe("AI Focus settings", () => {
  it("decodes historical client settings as disabled with a ten-minute interval", () => {
    const decoded = decodeClientSettings({});
    expect(decoded.aiFocusEnabled).toBe(false);
    expect(decoded.aiFocusRefreshIntervalMs).toBe(600_000);
    expect(DEFAULT_CLIENT_SETTINGS.aiFocusEnabled).toBe(false);
    expect(DEFAULT_CLIENT_SETTINGS.aiFocusRefreshIntervalMs).toBe(600_000);
  });

  it("accepts manual-only and the approved literal intervals, but rejects arbitrary values", () => {
    const decodeInterval = Schema.decodeUnknownSync(AiFocusRefreshIntervalMs);
    for (const interval of [
      0, 300_000, 600_000, 1_800_000, 3_600_000, 21_600_000, 86_400_000,
    ] as const) {
      expect(decodeInterval(interval)).toBe(interval);
      expect(decodeClientSettingsPatch({ aiFocusRefreshIntervalMs: interval })).toMatchObject({
        aiFocusRefreshIntervalMs: interval,
      });
    }
    expect(() => decodeInterval(60_000)).toThrow();
  });

  it("decodes historical server settings with no ranking model override", () => {
    expect(decodeServerSettings({}).inboxPriorityModelSelection).toBeNull();
    expect(DEFAULT_SERVER_SETTINGS.inboxPriorityModelSelection).toBeNull();
  });

  it("patches an environment-local model override or resets it to inheritance", () => {
    expect(
      decodeServerSettingsPatch({
        inboxPriorityModelSelection: { instanceId: "claude", model: "claude-sonnet" },
      }).inboxPriorityModelSelection,
    ).toMatchObject({ instanceId: "claude", model: "claude-sonnet" });
    expect(
      decodeServerSettingsPatch({ inboxPriorityModelSelection: null }).inboxPriorityModelSelection,
    ).toBeNull();
  });
});

describe("thread unpin confirmation", () => {
  it("preserves low-friction unpinning for existing settings and supports an opt-in patch", () => {
    expect(decodeClientSettings({}).confirmThreadUnpin).toBe(false);
    expect(DEFAULT_CLIENT_SETTINGS.confirmThreadUnpin).toBe(false);
    expect(decodeClientSettingsPatch({ confirmThreadUnpin: true }).confirmThreadUnpin).toBe(true);
  });
});

describe("ClientSettings.sourceControlRefreshMode", () => {
  it("defaults legacy settings to automatic refresh", () => {
    expect(DEFAULT_CLIENT_SETTINGS.sourceControlRefreshMode).toBe("automatic");
    expect(decodeClientSettings({}).sourceControlRefreshMode).toBe("automatic");
  });

  it("decodes every supported mode and patches it independently", () => {
    for (const sourceControlRefreshMode of ["automatic", "reduced", "manual"] as const) {
      expect(decodeClientSettings({ sourceControlRefreshMode }).sourceControlRefreshMode).toBe(
        sourceControlRefreshMode,
      );
      expect(decodeClientSettingsPatch({ sourceControlRefreshMode }).sourceControlRefreshMode).toBe(
        sourceControlRefreshMode,
      );
    }
  });
});

describe("ServerSettings.enableLegacyTokenStreaming", () => {
  it("defaults to buffered output and deliberately ignores the retired key", () => {
    expect(DEFAULT_SERVER_SETTINGS.enableLegacyTokenStreaming).toBe(false);
    expect(
      decodeServerSettings({ enableAssistantStreaming: true }).enableLegacyTokenStreaming,
    ).toBe(false);
  });

  it("round-trips the fresh legacy setting key", () => {
    expect(
      decodeServerSettings({ enableLegacyTokenStreaming: true }).enableLegacyTokenStreaming,
    ).toBe(true);
    expect(
      decodeServerSettingsPatch({ enableLegacyTokenStreaming: true }).enableLegacyTokenStreaming,
    ).toBe(true);
  });
});

describe("ServerSettings.enableProviderUpdateChecks", () => {
  it("defaults provider update checks on", () => {
    expect(DEFAULT_SERVER_SETTINGS.enableProviderUpdateChecks).toBe(true);
    expect(decodeServerSettings({}).enableProviderUpdateChecks).toBe(true);
  });

  it("can be disabled and round-trips through the settings patch", () => {
    expect(
      decodeServerSettings({ enableProviderUpdateChecks: false }).enableProviderUpdateChecks,
    ).toBe(false);
    expect(
      decodeServerSettingsPatch({ enableProviderUpdateChecks: false }).enableProviderUpdateChecks,
    ).toBe(false);
  });
});

describe("ServerSettings.providerInstances (slice-2 invariant)", () => {
  it("defaults to an empty record so legacy configs without the key still decode", () => {
    expect(DEFAULT_SERVER_SETTINGS.providerInstances).toEqual({});
  });

  it("decodes a fully empty config (legacy on-disk shape) without complaint", () => {
    const decoded = decodeServerSettings({});
    expect(decoded.providerInstances).toEqual({});
    // Legacy `providers` struct is still hydrated with its per-driver defaults
    // so existing call sites keep working through the migration.
    expect(decoded.providers.codex.enabled).toBe(true);
    expect(decoded.providers.grok).toEqual({
      enabled: true,
      binaryPath: "grok",
      customModels: [],
    });
  });

  it("decodes a multi-instance map mixing first-party and fork drivers", () => {
    const decoded = decodeServerSettings({
      providerInstances: {
        codex_personal: {
          driver: "codex",
          displayName: "Codex (personal)",
          config: { homePath: "~/.codex_personal" },
        },
        codex_work: {
          driver: "codex",
          config: { homePath: "~/.codex_work" },
        },
        ollama_local: {
          driver: "ollama",
          displayName: "Ollama (local)",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const personalId = ProviderInstanceId.make("codex_personal");
    const workId = ProviderInstanceId.make("codex_work");
    const ollamaId = ProviderInstanceId.make("ollama_local");

    expect(decoded.providerInstances[personalId]?.driver).toBe("codex");
    expect(decoded.providerInstances[workId]?.config).toEqual({ homePath: "~/.codex_work" });
    // Critical: a config naming a driver this build does not know about
    // (`ollama` is not in `ProviderDriverKind`) must round-trip without loss.
    // The runtime handles "driver not installed" — the schema must not.
    expect(decoded.providerInstances[ollamaId]?.driver).toBe("ollama");
    expect(decoded.providerInstances[ollamaId]?.config).toEqual({
      endpoint: "http://localhost:11434",
    });
  });

  it("rejects instance keys that violate the slug pattern", () => {
    expect(() =>
      decodeServerSettings({
        providerInstances: { "1bad": { driver: "codex" } },
      }),
    ).toThrow();
  });
});

describe("ServerSettingsPatch.providerInstances", () => {
  it("treats providerInstances as an optional whole-map replacement", () => {
    const patch = decodeServerSettingsPatch({});
    expect(patch.providerInstances).toBeUndefined();

    const replacement = decodeServerSettingsPatch({
      providerInstances: {
        codex_personal: { driver: "codex", config: { homePath: "~/.codex" } },
      },
    });
    expect(replacement.providerInstances).toBeDefined();
    expect(replacement.providerInstances?.[ProviderInstanceId.make("codex_personal")]?.driver).toBe(
      "codex",
    );
  });

  it("preserves a fork-defined driver entry through patch decoding", () => {
    const patch = decodeServerSettingsPatch({
      providerInstances: {
        ollama_local: {
          driver: "ollama",
          config: { endpoint: "http://localhost:11434" },
        },
      },
    });
    const ollamaId = ProviderInstanceId.make("ollama_local");
    expect(patch.providerInstances?.[ollamaId]?.driver).toBe("ollama");
  });
});

describe("ServerSettings.agentControl", () => {
  it("defaults Agent Control to disabled, including for legacy configs without the key", () => {
    expect(DEFAULT_SERVER_SETTINGS.agentControl.enabled).toBe(false);
    expect(decodeServerSettings({}).agentControl.enabled).toBe(false);
    expect(decodeServerSettings({ agentControl: {} }).agentControl.enabled).toBe(false);
  });

  it("round-trips an explicit opt-in and patches it independently", () => {
    expect(decodeServerSettings({ agentControl: { enabled: true } }).agentControl.enabled).toBe(
      true,
    );
    const patch = decodeServerSettingsPatch({ agentControl: { enabled: true } });
    expect(patch.agentControl?.enabled).toBe(true);
    expect(decodeServerSettingsPatch({}).agentControl).toBeUndefined();
  });
});

describe("ServerSettingsPatch.providers.grok", () => {
  it("decodes Grok binary and model overrides", () => {
    const patch = decodeServerSettingsPatch({
      providers: {
        grok: {
          binaryPath: "/opt/grok",
          customModels: ["grok-build"],
        },
      },
    });

    expect(patch.providers?.grok).toEqual({
      binaryPath: "/opt/grok",
      customModels: ["grok-build"],
    });
  });
});

describe("node-owned device icons", () => {
  it("defaults historical settings to Automatic", () => {
    expect(decodeServerSettings({}).environmentIcon).toBeNull();
  });
  it("accepts every icon and an explicit reset, while an omitted patch does not reset", () => {
    for (const environmentIcon of [null, ...ENVIRONMENT_MACHINE_KINDS]) {
      expect(decodeServerSettingsPatch({ environmentIcon })).toEqual({ environmentIcon });
      expect(decodeServerSettings({ environmentIcon }).environmentIcon).toBe(environmentIcon);
    }
    expect(decodeServerSettingsPatch({})).not.toHaveProperty("environmentIcon");
  });
  it("rejects arbitrary icon writes but can read a future node's configuration", () => {
    expect(() => decodeServerSettingsPatch({ environmentIcon: "future-device" })).toThrow();
    expect(decodeServerSettings({ environmentIcon: "future-device" }).environmentIcon).toBeNull();
    expect(
      Schema.decodeUnknownSync(ExecutionEnvironmentPlatform)({
        os: "linux",
        arch: "x64",
        machine: "future-device",
      }).machine,
    ).toBeNull();
  });
});

describe("worktree branch prefix settings", () => {
  it("defaults historical settings to the legacy namespace", () => {
    expect(decodeServerSettings({}).worktreeBranchPrefix).toBe("ryco");
    expect(DEFAULT_SERVER_SETTINGS.worktreeBranchPrefix).toBe("ryco");
    expect(decodeServerSettingsPatch({})).not.toHaveProperty("worktreeBranchPrefix");
  });

  it.each(["", "team", "Team/agents", "team.v2", "agent_work", "team-1"])(
    "accepts %j",
    (prefix) => {
      expect(decodeServerSettings({ worktreeBranchPrefix: prefix }).worktreeBranchPrefix).toBe(
        prefix,
      );
      expect(decodeServerSettingsPatch({ worktreeBranchPrefix: prefix }).worktreeBranchPrefix).toBe(
        prefix,
      );
    },
  );

  it("trims surrounding whitespace", () => {
    expect(
      decodeServerSettingsPatch({ worktreeBranchPrefix: " team/agents " }).worktreeBranchPrefix,
    ).toBe("team/agents");
  });

  it.each([
    "/team",
    "team/",
    "team//agents",
    "-team",
    ".team",
    "team/.hidden",
    "team..agents",
    "team.lock",
    "team.lock/agents",
    "team.",
    "team agents",
    "team:agents",
    "team?",
    "team*",
    "team[",
    "team\\agents",
    "team~",
    "team^",
    "team@{1}",
    "a".repeat(129),
  ])("rejects invalid Git namespace %j", (prefix) => {
    expect(() => decodeServerSettings({ worktreeBranchPrefix: prefix })).toThrow();
    expect(() => decodeServerSettingsPatch({ worktreeBranchPrefix: prefix })).toThrow();
  });
});
