import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vite-plus/test";

async function readSource(relativePath: string): Promise<string> {
  return readFile(new URL(relativePath, import.meta.url), "utf8");
}

/** Module specifiers of value (non-`import type`) static imports and re-exports. */
function staticValueImports(source: string): string[] {
  const specifiers: string[] = [];
  for (const match of source.matchAll(/^import\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
    if (match[1] === undefined) specifiers.push(match[2]!);
  }
  for (const match of source.matchAll(/^import\s+"([^"]+)";/gm)) {
    specifiers.push(match[1]!);
  }
  for (const match of source.matchAll(/^export\s+(type\s+)?[^;]*?from\s+"([^"]+)";/gms)) {
    if (match[1] === undefined) specifiers.push(match[2]!);
  }
  return specifiers;
}

/**
 * Every module statically reachable from `entry` (same directory tree only),
 * with the module that first imported it, plus the external specifiers seen.
 */
async function staticGraph(entry: string) {
  const importedBy = new Map<string, string | null>([[entry, null]]);
  const externals = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const current = queue.shift()!;
    const base = new URL(current, import.meta.url);
    for (const specifier of staticValueImports(await readSource(current))) {
      if (!specifier.startsWith(".")) {
        externals.add(specifier);
        continue;
      }
      const resolved = `./${new URL(specifier, base).pathname.split("/src/").pop()}`;
      if (importedBy.has(resolved)) continue;
      importedBy.set(resolved, current);
      queue.push(resolved);
    }
  }
  return { importedBy, externals };
}

// Loaded before Electron is ready on every launch; each of these is only
// needed once a feature is used, so it must stay behind a dynamic import.
const LAZY_FROM_MAIN = [
  "./desktopHubStack.ts",
  "./desktopHostedIdentity.ts",
  "./nativeSecurityHelper.ts",
  "./nativeSecretStore.ts",
  "./hostedCredentials.ts",
  "./desktopE2eeTrust.ts",
  "./desktopE2eePrekey.ts",
  "./desktopNativeE2ee.ts",
  "./desktopNativeE2eeHandshake.ts",
  "./desktopWorkspaceCache.ts",
  "./desktopWorkspaceClient.ts",
  "./desktopWorkspaceIpc.ts",
  "./desktopWorkspaceRelay.ts",
  "./sshEnvironment.ts",
  "./tailscaleEndpointProvider.ts",
  "./bundledGuide.ts",
];
const LAZY_EXTERNALS_FROM_MAIN = ["electron-updater", "@ryco/ssh/tunnel", "@ryco/ssh/command"];

describe("desktop main bundle splitting", () => {
  it("keeps Hub, E2EE, workspace, SSH and updater code out of the eager main graph", async () => {
    const { importedBy, externals } = await staticGraph("./main.ts");
    for (const specifier of LAZY_FROM_MAIN) {
      expect(
        importedBy.has(specifier),
        `${specifier} is statically imported by ${importedBy.get(specifier)}`,
      ).toBe(false);
    }
    for (const specifier of LAZY_EXTERNALS_FROM_MAIN) {
      expect([...externals], specifier).not.toContain(specifier);
    }
  });

  it("loads the lazy stacks through dynamic imports", async () => {
    const main = await readSource("./main.ts");
    expect(main).toContain('import("./desktopHubStack.ts")');
    expect(main).toContain('import("./sshEnvironment.ts")');
    // A lazy CommonJS require: the ESM namespace of electron-updater has no
    // `autoUpdater` export, so `(await import("electron-updater")).autoUpdater`
    // would be undefined.
    expect(main).toContain('require("electron-updater")');
    expect(main).not.toMatch(/await import\("electron-updater"\)/);
  });

  it("keeps the launch entry free of the main bundle and of heavy dependencies", async () => {
    const { importedBy, externals } = await staticGraph("./desktopEntry.ts");
    expect(importedBy.has("./main.ts")).toBe(false);
    for (const specifier of externals) {
      expect(
        specifier.startsWith("node:") ||
          specifier === "electron" ||
          specifier === "@ryco/shared/shellEnvironment" ||
          specifier === "@ryco/shared/runtimeEnv",
        specifier,
      ).toBe(true);
    }
  });
});
