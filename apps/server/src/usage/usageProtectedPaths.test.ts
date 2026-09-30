import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  ProviderDriverKind,
  type ProviderInstanceConfigMap,
} from "@ryco/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import * as NodePath from "@effect/platform-node/NodePath";
import { Effect } from "effect";
import { resolveClaudeHomePath } from "../provider/Drivers/ClaudeHome.ts";
import { resolveCodexHomeLayout } from "../provider/Drivers/CodexHomeLayout.ts";
import { type UsageProtectionSettings, resolveUsageProtectedPaths } from "./usageProtectedPaths.ts";
const instances = (
  exportPath = "/fixture/owned/archived/export.json",
): ProviderInstanceConfigMap => ({
  [ProviderInstanceId.make("cursor")]: {
    driver: ProviderDriverKind.make("cursor"),
    enabled: false,
    config: { usageExportPath: exportPath },
  },
  [ProviderInstanceId.make("opencode")]: {
    driver: ProviderDriverKind.make("opencode"),
    enabled: false,
    config: {},
    environment: [
      { name: "OPENCODE_DB", value: "/fixture/owned/staging/account.db", sensitive: false },
    ],
  },
  [ProviderInstanceId.make("codex")]: {
    driver: ProviderDriverKind.make("codex"),
    config: { homePath: "/fixture/codex", shadowHomePath: "/fixture/shadow" },
  },
  [ProviderInstanceId.make("claude")]: {
    driver: ProviderDriverKind.make("claudeAgent"),
    config: { homePath: "/fixture/claude" },
  },
});
describe("authoritative usage cleanup protection", () => {
  it("protects disabled tracked export and explicit DB paths inside otherwise eligible folders", () => {
    const paths = resolveUsageProtectedPaths(
      instances(),
      { HOME: "/fixture/home" },
      "/fixture/home",
    );
    expect(paths).toEqual(
      expect.arrayContaining([
        "/fixture/owned/archived/export.json",
        "/fixture/owned/staging/account.db",
        "/fixture/owned/staging/account.db-wal",
        "/fixture/owned/staging/account.db-shm",
        "/fixture/home/.local/share/opencode",
        "/fixture/codex",
        "/fixture/shadow",
        "/fixture/claude",
      ]),
    );
    const intersects = (candidate: string) =>
      paths.some(
        (path) =>
          path === candidate ||
          path.startsWith(candidate + "/") ||
          candidate.startsWith(path + "/"),
      );
    expect(intersects("/fixture/owned/archived")).toBe(true);
    expect(intersects("/fixture/owned/staging")).toBe(true);
    expect(intersects("/fixture/owned/unrelated")).toBe(false);
  });
  it("recomputes current settings after preview and never reads credentials", () => {
    const environment = {
      HOME: "/fixture/home",
      get CURSOR_API_KEY(): string {
        throw new Error("credential read");
      },
      get OPENAI_API_KEY(): string {
        throw new Error("credential read");
      },
    };
    expect(resolveUsageProtectedPaths(instances(), environment)).not.toContain(
      "/fixture/new/export.json",
    );
    expect(
      resolveUsageProtectedPaths(instances("/fixture/new/export.json"), environment),
    ).toContain("/fixture/new/export.json");
  });
  it("fails visibly instead of dropping malformed authoritative protection", () => {
    expect(() =>
      resolveUsageProtectedPaths(instances("relative/export.json"), { HOME: "/fixture/home" }),
    ).toThrow("Cleanup must stop");
    expect(() =>
      resolveUsageProtectedPaths(instances(), { HOME: "/fixture/home", XDG_DATA_HOME: "relative" }),
    ).toThrow("Cleanup must stop");
  });
});

// Provider helpers use the OS home independently from an instance HOME. All
// paths are synthetic; those helpers and this resolver perform no content reads.
vi.mock("node:os", async (original) => ({
  ...(await original<typeof import("node:os")>()),
  homedir: () => "/fixture/os-home",
}));
function settings(
  claudeHome = "/fixture/legacy-claude",
  codexHome = "/fixture/legacy-codex",
): UsageProtectionSettings {
  return {
    providerInstances: instances(),
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      claudeAgent: {
        ...DEFAULT_SERVER_SETTINGS.providers.claudeAgent,
        enabled: false,
        homePath: claudeHome,
      },
      codex: { ...DEFAULT_SERVER_SETTINGS.providers.codex, enabled: false, homePath: codexHome },
    },
  };
}
describe("settings-aware usage protection", () => {
  it("includes unconditional legacy roots outside instance homes and retains disabled instances", () => {
    const paths = resolveUsageProtectedPaths(settings(), { HOME: "/fixture/environment-home" });
    expect(paths).toEqual(
      expect.arrayContaining([
        "/fixture/legacy-claude/.claude/projects",
        "/fixture/legacy-claude/projects",
        "/fixture/legacy-codex/sessions",
        "/fixture/legacy-codex/archived_sessions",
        "/fixture/owned/archived/export.json",
        "/fixture/owned/staging/account.db",
      ]),
    );
    const intersects = (candidate: string) =>
      paths.some(
        (path) =>
          path === candidate ||
          path.startsWith(candidate + "/") ||
          candidate.startsWith(path + "/"),
      );
    expect(intersects("/fixture/legacy-claude")).toBe(true);
    expect(intersects("/fixture/legacy-codex/archived_sessions/synthetic.jsonl")).toBe(true);
    expect(intersects("/fixture/unrelated-checkout")).toBe(false);
  });
  it("matches default driver history locations without protecting the entire HOME", () => {
    const current = settings("", "");
    const claudeHome = Effect.runSync(
      resolveClaudeHomePath(current.providers.claudeAgent).pipe(Effect.provide(NodePath.layer)),
    );
    const codexHome = Effect.runSync(
      resolveCodexHomeLayout(current.providers.codex).pipe(Effect.provide(NodePath.layer)),
    ).sharedHomePath;
    const paths = resolveUsageProtectedPaths(current, {
      HOME: "/fixture/environment-home",
      CODEX_HOME: "/fixture/environment-codex",
    });
    expect(claudeHome).toBe("/fixture/os-home");
    expect(codexHome).toBe("/fixture/os-home/.codex");
    expect(paths).toEqual(
      expect.arrayContaining([
        `${claudeHome}/.claude/projects`,
        `${claudeHome}/projects`,
        `${codexHome}/sessions`,
        `${codexHome}/archived_sessions`,
      ]),
    );
    expect(paths).not.toContain(claudeHome);
    expect(paths).not.toContain("/fixture/environment-home");
  });
  it("retains explicit blank instance defaults separately from inherited legacy homes, including disabled instances", () => {
    const current = settings();
    const overridden = {
      ...current,
      providerInstances: {
        [ProviderInstanceId.make("claude-blank")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          enabled: false,
          config: { homePath: "" },
        },
        [ProviderInstanceId.make("codex-blank")]: {
          driver: ProviderDriverKind.make("codex"),
          enabled: false,
          config: { homePath: "" },
        },
        [ProviderInstanceId.make("claude-inherit")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: {},
        },
      },
    };
    expect(resolveUsageProtectedPaths(overridden, { HOME: "/fixture/environment-home" })).toEqual(
      expect.arrayContaining([
        "/fixture/os-home/.claude/projects",
        "/fixture/os-home/projects",
        "/fixture/os-home/.codex/sessions",
        "/fixture/os-home/.codex/archived_sessions",
        "/fixture/legacy-claude/projects",
        "/fixture/legacy-codex/sessions",
      ]),
    );
  });
  it("uses current legacy and instance settings after preview, never unrelated credential fields", () => {
    const before = settings(),
      after = {
        ...settings("/fixture/changed-claude", "/fixture/changed-codex"),
        providerInstances: instances("/fixture/changed-export.json"),
      };
    const environment = {
      HOME: "/fixture/environment-home",
      get OPENAI_API_KEY(): string {
        throw new Error("credential read");
      },
    };
    Object.defineProperty(after.providers.codex, "binaryPath", {
      get() {
        throw new Error("unrelated setting read");
      },
    });
    expect(resolveUsageProtectedPaths(before, environment)).not.toContain(
      "/fixture/changed-claude/projects",
    );
    const paths = resolveUsageProtectedPaths(after, environment);
    expect(paths).toEqual(
      expect.arrayContaining([
        "/fixture/changed-claude/projects",
        "/fixture/changed-codex/sessions",
        "/fixture/changed-export.json",
      ]),
    );
    expect(paths).not.toContain("/fixture/legacy-claude/projects");
    expect(paths).not.toContain("/fixture/owned/archived/export.json");
  });
  it("fails visibly for malformed legacy roots and limits explicit whole-home configurations to known histories", () => {
    expect(() =>
      resolveUsageProtectedPaths(settings("relative", "/fixture/valid"), {
        HOME: "/fixture/environment-home",
      }),
    ).toThrow("Cleanup must stop");
    const current = settings("/fixture/os-home", "/fixture/os-home");
    const overridden = {
      ...current,
      providerInstances: {
        [ProviderInstanceId.make("claude")]: {
          driver: ProviderDriverKind.make("claudeAgent"),
          config: { homePath: "/fixture/os-home" },
        },
      },
    };
    const paths = resolveUsageProtectedPaths(overridden, { HOME: "/fixture/os-home" });
    expect(paths).not.toContain("/fixture/os-home");
    expect(paths).toEqual(
      expect.arrayContaining([
        "/fixture/os-home/projects",
        "/fixture/os-home/.claude/projects",
        "/fixture/os-home/sessions",
        "/fixture/os-home/archived_sessions",
      ]),
    );
  });
});
