// @effect-diagnostics nodeBuiltinImport:off
import * as OS from "node:os";
import * as Path from "node:path";
import type { ProviderInstanceConfigMap, ServerSettings } from "@ryco/contracts";

export class UsageProtectedPathError extends Error {
  constructor() {
    super(
      "A configured provider history/export path is invalid. Cleanup must stop until its path settings are corrected.",
    );
    this.name = "UsageProtectedPathError";
  }
}

/** Shared OpenCode path authority for scanning and cleanup protection. */
export function resolveOpenCodeUsagePaths(
  environment: readonly { readonly name: string; readonly value: string }[] | undefined,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  home = OS.homedir(),
): {
  readonly dataRoot: string;
  readonly databasePath: string;
  readonly root: string;
  readonly allowLegacy: boolean;
} {
  const names = ["HOME", "USERPROFILE", "XDG_DATA_HOME", "OPENCODE_DB"];
  const env = new Map(names.map((name) => [name, baseEnvironment[name]]));
  for (const variable of environment ?? [])
    if (names.includes(variable.name)) env.set(variable.name, variable.value);
  const absolute = (value: string): string => {
    if (!value || value.includes("\0") || !Path.isAbsolute(value))
      throw new UsageProtectedPathError();
    return Path.normalize(value);
  };
  const userHome = absolute(env.get(process.platform === "win32" ? "USERPROFILE" : "HOME") ?? home);
  const dataRoot = Path.join(
    absolute(env.get("XDG_DATA_HOME") ?? Path.join(userHome, ".local", "share")),
    "opencode",
  );
  const configured = env.get("OPENCODE_DB");
  if (configured === "" || configured?.includes("\0")) throw new UsageProtectedPathError();
  const databasePath =
    configured === ":memory:"
      ? configured
      : configured === undefined
        ? Path.join(dataRoot, "opencode.db")
        : Path.resolve(dataRoot, configured);
  return {
    dataRoot,
    databasePath,
    root:
      configured === undefined || configured === ":memory:" ? dataRoot : Path.dirname(databasePath),
    allowLegacy: configured === undefined,
  };
}

export type UsageProtectionSettings = Pick<ServerSettings, "providers" | "providerInstances">;

/** Authoritative cleanup protection. Pure path resolution, including disabled
 * instances and legacy/default provider roots. Production must pass CURRENT full
 * settings for scan, preview and final revalidation; the map overload is compatibility only.
 * Returns lexical absolute paths; the cleanup owner must resolve aliases and
 * protect both ancestors and descendants. No contents/credentials are read. */
export function resolveUsageProtectedPaths(
  instances: ProviderInstanceConfigMap,
  baseEnvironment?: NodeJS.ProcessEnv,
  home?: string,
): readonly string[];
export function resolveUsageProtectedPaths(
  settings: UsageProtectionSettings,
  baseEnvironment?: NodeJS.ProcessEnv,
  home?: string,
): readonly string[];
export function resolveUsageProtectedPaths(
  input: ProviderInstanceConfigMap | UsageProtectionSettings,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  home = OS.homedir(),
): readonly string[] {
  // Keep the historical instance-only call compatible. Production cleanup must
  // supply full CURRENT settings: UsageService also reads legacy/default roots.
  const settings =
    "providers" in input &&
    "providerInstances" in input &&
    typeof input.providers === "object" &&
    input.providers !== null &&
    !("driver" in input.providers)
      ? (input as UsageProtectionSettings)
      : undefined;
  if (
    settings !== undefined &&
    (typeof settings.providerInstances !== "object" || settings.providerInstances === null)
  )
    throw new UsageProtectedPathError();
  const instances = settings?.providerInstances ?? (input as ProviderInstanceConfigMap);
  const paths = new Set<string>();
  const absolute = (value: string, expandTilde = false): string => {
    const expanded =
      expandTilde && (value === "~" || value.startsWith("~/") || value.startsWith("~\\"))
        ? Path.join(home, value.slice(2))
        : value;
    if (!expanded || expanded.includes("\0") || !Path.isAbsolute(expanded))
      throw new UsageProtectedPathError();
    return Path.normalize(expanded);
  };
  const add = (value: string, expandTilde = false) => paths.add(absolute(value, expandTilde));
  const pathField = (config: Record<string, unknown>, key: string): string => {
    const value = config[key];
    if (value !== undefined && typeof value !== "string") throw new UsageProtectedPathError();
    return typeof value === "string" ? value.trim() : "";
  };
  const isWholeHome = (value: string): boolean =>
    value === absolute(home) ||
    value === Path.parse(value).root ||
    [baseEnvironment.HOME, baseEnvironment.USERPROFILE].some(
      (candidate) =>
        typeof candidate === "string" &&
        Path.isAbsolute(candidate) &&
        Path.normalize(candidate) === value,
    );
  const addClaudeHistory = (providerHome: string) => {
    // UsageService chooses between these two layouts after checking existence.
    // Protection is pure and must retain BOTH possibilities, including ~/projects.
    add(Path.join(providerHome, ".claude", "projects"));
    add(Path.join(providerHome, "projects"));
  };
  const addCodexHistory = (providerHome: string) => {
    add(Path.join(providerHome, "sessions"));
    add(Path.join(providerHome, "archived_sessions"));
  };
  const addProviderHome = (value: string, driver: "codex" | "claudeAgent") => {
    const providerHome = absolute(value, true);
    if (!isWholeHome(providerHome)) paths.add(providerHome);
    else if (driver === "codex") addCodexHistory(providerHome);
    else addClaudeHistory(providerHome);
  };
  if (settings !== undefined) {
    const claudeHome = pathField(settings.providers.claudeAgent, "homePath");
    const codexHome = pathField(settings.providers.codex, "homePath");
    // These sources are unconditional in UsageService, including legacy disabled
    // defaults. Its driver helpers use OS homedir(), not the instance environment.
    addClaudeHistory(absolute(claudeHome || home, true));
    addCodexHistory(absolute(codexHome || Path.join(home, ".codex"), true));
    const shadowHome = pathField(settings.providers.codex, "shadowHomePath");
    if (shadowHome) addProviderHome(shadowHome, "codex");
    const exportPath = pathField(settings.providers.cursor, "usageExportPath");
    if (exportPath) add(exportPath);
  }
  for (const instance of Object.values(instances)) {
    if (!["codex", "claudeAgent", "opencode", "cursor"].includes(instance.driver)) continue;
    const config =
      typeof instance.config === "object" && instance.config !== null
        ? (instance.config as Record<string, unknown>)
        : {};
    const field = (key: string) => pathField(config, key);
    if (instance.driver === "cursor") {
      const exportPath = field("usageExportPath");
      if (exportPath) add(exportPath);
      continue;
    }
    const names = [
      "HOME",
      "USERPROFILE",
      "XDG_DATA_HOME",
      "OPENCODE_DB",
      "CODEX_HOME",
      "CLAUDE_CONFIG_DIR",
    ];
    const env = new Map(names.map((name) => [name, baseEnvironment[name]]));
    for (const variable of instance.environment ?? [])
      if (names.includes(variable.name)) env.set(variable.name, variable.value);
    const userHome = absolute(
      env.get(process.platform === "win32" ? "USERPROFILE" : "HOME") ?? home,
    );
    if (instance.driver === "opencode") {
      const resolved = resolveOpenCodeUsagePaths(instance.environment, baseEnvironment, home);
      add(resolved.dataRoot);
      if (resolved.databasePath !== ":memory:")
        for (const suffix of ["", "-wal", "-shm"]) add(resolved.databasePath + suffix);
    } else if (instance.driver === "codex") {
      if (env.get("CODEX_HOME") === "") throw new UsageProtectedPathError();
      addProviderHome(
        field("homePath") || env.get("CODEX_HOME") || Path.join(userHome, ".codex"),
        "codex",
      );
      if (settings !== undefined) {
        // Missing instance field inherits the legacy setting; an explicit blank
        // selects the driver default. Include both runtime and statistics roots.
        const statisticsHome =
          config.homePath === undefined
            ? pathField(settings.providers.codex, "homePath")
            : field("homePath");
        addCodexHistory(absolute(statisticsHome || Path.join(home, ".codex"), true));
      }
      const shadow = field("shadowHomePath");
      if (shadow) addProviderHome(shadow, "codex");
    } else {
      const configuredHome = field("homePath");
      if (configuredHome) addProviderHome(configuredHome, "claudeAgent");
      else add(Path.join(userHome, ".claude"));
      if (settings !== undefined) {
        const statisticsHome =
          config.homePath === undefined
            ? pathField(settings.providers.claudeAgent, "homePath")
            : configuredHome;
        addClaudeHistory(absolute(statisticsHome || home, true));
      }
      const configured = env.get("CLAUDE_CONFIG_DIR");
      if (configured !== undefined) addProviderHome(configured, "claudeAgent");
    }
  }
  return [...paths].toSorted();
}
