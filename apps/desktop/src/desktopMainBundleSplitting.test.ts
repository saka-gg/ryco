import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "tsdown";
import { describe, expect, it } from "vite-plus/test";

import tsdownConfig from "../tsdown.config.ts";

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
  // Its node-claim schemas share a contracts module with the Hub identity ones.
  "./desktopHubControl.ts",
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
  // Computer use: started during bootstrap, after Electron is ready.
  "./computerUse/desktopStack.ts",
  "./computerUse/runtime.ts",
  "./computerUse/ipc.ts",
  "./browser/ipc.ts",
  "./cuaDriverHost.ts",
  "./appSnapManager.ts",
];
const LAZY_EXTERNALS_FROM_MAIN = [
  "electron-updater",
  "@ryco/ssh/tunnel",
  "@ryco/ssh/command",
  "ws",
  // The barrel evaluates every effect module; eager code imports subpaths.
  "effect",
];

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
    expect(main).toContain('import("./computerUse/desktopStack.ts")');
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

/**
 * Top-level bindings of Hub identity, relay and account E2EE schemas. Desktop
 * main never uses them before a Hub feature loads, but the bundler places
 * modules shared with the lazy chunks in the entry chunk, so an eager import
 * of any module that shares a contracts file with them evaluates them all
 * before Electron is ready. The source graph above cannot see that.
 */
const HUB_ONLY_BINDING =
  /^(?:NativeIdentity|PublicSignup|PasswordLogin|PasswordReset|ExternalIdentity|BrowserExternalIdentity|HostedAccountSecurity|HubBrowserSession|ActiveSpaceSwitch|NativeNodeClaim|NativeE2ee|Relay[A-Z]|RELAY_|NATIVE_IDENTITY_|NATIVE_NODE_CLAIM_|PUBLIC_SIGNUP_|PASSWORD_LOGIN_|PASSWORD_RESET_|EXTERNAL_IDENTITY_|GITHUB_EXTERNAL_IDENTITY_|ACTIVE_SPACE_SWITCH_)/;
/** Source modules whose code must only run inside a lazy chunk. */
const LAZY_ONLY_REGION =
  /^\/\/#region (?:\.\.\/\.\.\/packages\/contracts\/src\/(?:hostedIdentity|relay|computerUse)\.ts|src\/computerUse\/|src\/cuaDriverHost\.ts)/m;

describe("built desktop main bundle", () => {
  it("evaluates no Hub identity, relay or Computer-use module before ready", async () => {
    const [mainConfig] = Array.isArray(tsdownConfig) ? tsdownConfig : [tsdownConfig];
    const outDir = await mkdtemp(join(tmpdir(), "ryco-desktop-main-bundle-"));
    try {
      await build({
        ...mainConfig,
        config: false,
        cwd: fileURLToPath(new URL("..", import.meta.url)),
        entry: { desktopMain: "src/main.ts" },
        outDir,
        sourcemap: false,
        dts: false,
        logLevel: "silent",
      });
      const bundle = await readFile(join(outDir, "desktopMain.cjs"), "utf8");
      const topLevelBindings = [
        ...bundle.matchAll(/^(?:const|let|var|function|class) ([A-Za-z_$][\w$]*)/gm),
        ...bundle.matchAll(/^exports\.([A-Za-z_$][\w$]*) =/gm),
      ].map((match) => match[1]!);
      expect(topLevelBindings.filter((name) => HUB_ONLY_BINDING.test(name))).toEqual([]);
      expect(bundle.match(LAZY_ONLY_REGION)?.[0] ?? null).toBeNull();
    } finally {
      await rm(outDir, { recursive: true, force: true });
    }
  }, 60_000);
});
