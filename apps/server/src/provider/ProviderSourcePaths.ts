import * as OS from "node:os";
import * as Path from "node:path";

/** Pure path authority shared by provider runtime, imports and cleanup protection.
 * Only path variables are inspected; no credentials or store contents are read. */
export function parseProviderSourcePaths(
  driver: "codex" | "claudeAgent",
  config: { readonly homePath?: string; readonly shadowHomePath?: string },
  environment: NodeJS.ProcessEnv,
  home = OS.homedir(),
) {
  const resolve = (value: string) => {
    const expanded =
      value === "~"
        ? home
        : value.startsWith("~/") || value.startsWith("~\\")
          ? Path.join(home, value.slice(2))
          : value;
    return Path.resolve(expanded);
  };
  const userHome = resolve(environment.HOME?.trim() || home);
  const configuredHome = config.homePath?.trim();
  if (driver === "codex") {
    const root = resolve(
      configuredHome || environment.CODEX_HOME?.trim() || Path.join(userHome, ".codex"),
    );
    const shadow = config.shadowHomePath?.trim();
    return { home: root, root, shadow: shadow ? resolve(shadow) : undefined };
  }
  const providerHome = configuredHome ? resolve(configuredHome) : userHome;
  return {
    home: providerHome,
    root: resolve(environment.CLAUDE_CONFIG_DIR?.trim() || Path.join(providerHome, ".claude")),
    shadow: undefined,
  };
}
