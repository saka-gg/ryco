// @effect-diagnostics nodeBuiltinImport:off
import * as OS from "node:os";
import { resolveOpenCodeUsagePaths } from "./usageProtectedPaths.ts";

import type { CursorExportSource } from "./cursorExportUsageReader.ts";
import type { ProviderInstanceConfigMap, UsageProviderKind } from "@ryco/contracts";

export interface NativeUsageSource {
  readonly provider: UsageProviderKind;
  readonly identityRoot: string;
  readonly scanRoots: readonly string[];
  readonly databasePath?: string;
  readonly allowLegacy?: boolean;
  readonly unsupportedCode?: string;
  readonly cursorExport?: CursorExportSource;
}

/** Use exactly the environment passed to the instance, never another account's fallback. */
export function resolveNativeUsageSources(
  instances: ProviderInstanceConfigMap,
  baseEnvironment: NodeJS.ProcessEnv = process.env,
  home = OS.homedir(),
  includeDisabled = false,
): readonly NativeUsageSource[] {
  const sources: NativeUsageSource[] = [];
  for (const [id, instance] of Object.entries(instances)) {
    if (
      (!includeDisabled && instance.enabled === false) ||
      (instance.driver !== "opencode" && instance.driver !== "cursor")
    )
      continue;
    const config =
      typeof instance.config === "object" && instance.config !== null
        ? (instance.config as Record<string, unknown>)
        : {};
    if (instance.driver === "cursor") {
      const field = (name: string, fallback = "") =>
        typeof config[name] === "string" ? (config[name] as string) : fallback;
      const exportPath = field("usageExportPath");
      sources.push(
        exportPath
          ? {
              provider: "cursor",
              identityRoot: exportPath,
              scanRoots: [],
              cursorExport: {
                path: exportPath,
                accountKey: field("usageExportAccountKey"),
                userEmail: field("usageExportUserEmail"),
              },
            }
          : {
              provider: "cursor",
              identityRoot: `unsupported:cursor:${id}`,
              scanRoots: [],
              unsupportedCode: "cursor-export-not-configured",
            },
      );
      continue;
    }
    const env: Record<string, string | undefined> = {
      HOME: baseEnvironment.HOME,
      USERPROFILE: baseEnvironment.USERPROFILE,
      XDG_DATA_HOME: baseEnvironment.XDG_DATA_HOME,
      OPENCODE_DB: baseEnvironment.OPENCODE_DB,
    };
    // Only path variables are consumed; authentication is never read by statistics.
    for (const variable of instance.environment ?? []) {
      if (["HOME", "USERPROFILE", "XDG_DATA_HOME", "OPENCODE_DB"].includes(variable.name))
        env[variable.name] = variable.value;
    }
    const unsupported = (code: string) =>
      sources.push({
        provider: "opencode",
        identityRoot: `unsupported:opencode:${id}`,
        scanRoots: [],
        unsupportedCode: code,
      });
    if (typeof config.serverUrl === "string" && config.serverUrl.trim()) {
      unsupported("opencode-remote-history-unavailable");
      continue;
    }
    if (env.OPENCODE_DB === ":memory:" || env.OPENCODE_DB === "") {
      unsupported("opencode-database-unavailable");
      continue;
    }
    let resolved: ReturnType<typeof resolveOpenCodeUsagePaths>;
    try {
      resolved = resolveOpenCodeUsagePaths(instance.environment, baseEnvironment, home);
    } catch {
      unsupported("history-root-invalid");
      continue;
    }
    const { databasePath, root, allowLegacy } = resolved;
    sources.push({
      provider: "opencode",
      identityRoot: databasePath,
      scanRoots: [root],
      databasePath,
      allowLegacy,
    });
  }
  return sources;
}
