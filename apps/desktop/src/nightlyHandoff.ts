import * as ChildProcess from "node:child_process";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { DesktopNightlyState } from "@ryco/contracts";
import { type RycoDesktopFlavor, rycoDesktopFlavorIdentity } from "@ryco/shared/desktopFlavor";
import {
  flavorImportRequestPath,
  flavorImportResultPath,
  formatFlavorImportRequest,
  parseFlavorImportResult,
  RYCO_STABLE_HOME_ENV,
} from "@ryco/shared/flavorImport";

/**
 * Trying Ryco Nightly from Ryco, and coming back (port of Synara's beta hand-off, BETA.md).
 *
 * Ryco finds an installed Ryco Nightly, opens it, and can ask it for a copy of Ryco's data: it
 * writes the request into Nightly's home (never anything into its own) and Nightly's server
 * makes the copy on start (`@ryco/shared/flavorImport`). Ryco Nightly opens Ryco again; it never
 * copies anything back. Installing Ryco Nightly from inside the app is a later step; until then
 * the releases page has it.
 */

/** Set by Ryco when it opens Ryco Nightly: the app to open on "Switch back to Ryco". */
export const RYCO_STABLE_EXECUTABLE_ENV = "RYCO_STABLE_EXECUTABLE";
export const RYCO_RELEASES_URL = "https://github.com/saka-gg/ryco/releases";

/** Read at most this much of an app's Info.plist, or of a runtime file. */
const MAX_METADATA_BYTES = 64 * 1024;

export interface NightlyHandoffEnvironment {
  readonly platform: NodeJS.Platform;
  readonly flavor: RycoDesktopFlavor;
  readonly homeDirectory: string;
  /** This app's own data home. */
  readonly rycoHome: string;
  /** Ryco Nightly's data home, as Ryco Nightly resolves it. */
  readonly nightlyHome: string;
  /** This app's executable (`process.execPath`). */
  readonly executable: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The folders apps are looked for in; the two Applications folders when omitted. */
  readonly applicationsDirectories?: ReadonlyArray<string>;
  /** Starts the other app; injectable for tests. */
  readonly launch?: (executable: string, env: NodeJS.ProcessEnv) => void;
}

function launchDetached(executable: string, env: NodeJS.ProcessEnv): void {
  const child = ChildProcess.spawn(executable, [], { detached: true, stdio: "ignore", env });
  child.on("error", () => {});
  child.unref();
}

async function readSmallFile(path: string): Promise<string | null> {
  try {
    const info = await FS.lstat(path);
    if (!info.isFile() || info.size > MAX_METADATA_BYTES) return null;
    return await FS.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function plistString(plist: string, key: string): string | null {
  const escaped = key.replaceAll(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const match = new RegExp(`<key>${escaped}</key>\\s*<string>([^<]{1,200})</string>`, "u").exec(
    plist,
  );
  return match?.[1]?.trim() ?? null;
}

/**
 * The executable of a macOS app bundle, when the bundle is the given flavor's app: its Info.plist
 * names that flavor's bundle id. A bundle with another id (an unrelated or foreign app at the same
 * name) is never opened.
 */
export async function flavorAppExecutable(
  bundlePath: string,
  flavor: RycoDesktopFlavor,
): Promise<string | null> {
  const plist = await readSmallFile(Path.join(bundlePath, "Contents", "Info.plist"));
  if (plist === null) return null;
  if (plistString(plist, "CFBundleIdentifier") !== rycoDesktopFlavorIdentity(flavor).appId) {
    return null;
  }
  const name = plistString(plist, "CFBundleExecutable");
  if (name === null || name.includes("/") || name === "." || name === "..") return null;
  const executable = Path.join(bundlePath, "Contents", "MacOS", name);
  try {
    const info = await FS.lstat(executable);
    return info.isFile() ? executable : null;
  } catch {
    return null;
  }
}

/** The bundle a macOS executable sits in (`…/X.app/Contents/MacOS/X`), or null. */
function bundleOfExecutable(executable: string): string | null {
  const macOs = Path.dirname(executable);
  const contents = Path.dirname(macOs);
  if (Path.basename(macOs) !== "MacOS" || Path.basename(contents) !== "Contents") return null;
  const bundle = Path.dirname(contents);
  return bundle.endsWith(".app") ? bundle : null;
}

/** Where each flavor's app is looked for: the two Applications folders (macOS only for now). */
function appBundleCandidates(environment: NightlyHandoffEnvironment, flavor: RycoDesktopFlavor) {
  const name = `${rycoDesktopFlavorIdentity(flavor).productName}.app`;
  const folders = environment.applicationsDirectories ?? [
    "/Applications",
    Path.join(environment.homeDirectory, "Applications"),
  ];
  return folders.map((folder) => Path.join(folder, name));
}

async function findFlavorApp(
  environment: NightlyHandoffEnvironment,
  flavor: RycoDesktopFlavor,
  handedOver?: string,
): Promise<string | null> {
  if (environment.platform !== "darwin") return null;
  const bundles = [
    ...(handedOver ? [bundleOfExecutable(handedOver)].filter((path) => path !== null) : []),
    ...appBundleCandidates(environment, flavor),
  ];
  for (const bundle of bundles) {
    const executable = await flavorAppExecutable(bundle, flavor);
    if (executable !== null) return executable;
  }
  return null;
}

/** Ryco Nightly's node is running: its runtime file names a live process. */
export async function nightlyNodeRunning(nightlyHome: string): Promise<boolean> {
  const text = await readSmallFile(Path.join(nightlyHome, "userdata", "server-runtime.json"));
  if (text === null) return false;
  let pid: unknown;
  try {
    pid = (JSON.parse(text) as { readonly pid?: unknown }).pid;
  } catch {
    return false;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Alive but owned by another user still counts as running.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * The environment the other app starts with: none of this app's Ryco settings (its home, port,
 * bootstrap, Hub or CLI variables) and no Electron switch that would start it as plain Node.
 * Ryco Nightly keeps its own home override.
 */
export function handoffLaunchEnv(
  env: Readonly<Record<string, string | undefined>>,
  extra: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (key.startsWith("RYCO_") && key !== rycoDesktopFlavorIdentity("nightly").homeEnv) continue;
    if (key === "ELECTRON_RUN_AS_NODE" || key === "ELECTRON_NO_ASAR") continue;
    if (key === "VITE_DEV_SERVER_URL") continue;
    next[key] = value;
  }
  return { ...next, ...extra };
}

export async function readNightlyState(
  environment: NightlyHandoffEnvironment,
): Promise<DesktopNightlyState> {
  if (environment.flavor === "stable") {
    const [app, running] = await Promise.all([
      findFlavorApp(environment, "nightly"),
      nightlyNodeRunning(environment.nightlyHome),
    ]);
    return {
      flavor: "stable",
      otherAppInstalled: app !== null,
      nightlyRunning: running,
      lastImport: null,
      releasesUrl: RYCO_RELEASES_URL,
    };
  }
  const [app, resultText] = await Promise.all([
    findFlavorApp(environment, "stable", environment.env[RYCO_STABLE_EXECUTABLE_ENV]),
    readSmallFile(flavorImportResultPath(environment.rycoHome)),
  ]);
  return {
    flavor: "nightly",
    otherAppInstalled: app !== null,
    nightlyRunning: true,
    lastImport: resultText === null ? null : parseFlavorImportResult(resultText),
    releasesUrl: RYCO_RELEASES_URL,
  };
}

/**
 * Opens Ryco Nightly from Ryco. With `copyData`, first asks it for a copy of Ryco's data: refused
 * while Nightly's node runs (it copies before its node starts), and the request goes into
 * Nightly's home only.
 */
export async function openNightly(
  environment: NightlyHandoffEnvironment,
  options: { readonly copyData: boolean; readonly now?: Date },
): Promise<void> {
  if (environment.flavor !== "stable") throw new Error("Only Ryco opens Ryco Nightly.");
  const executable = await findFlavorApp(environment, "nightly");
  if (executable === null) throw new Error("Ryco Nightly is not installed in Applications.");
  if (options.copyData) {
    if (await nightlyNodeRunning(environment.nightlyHome)) {
      throw new Error("Quit Ryco Nightly first: it copies Ryco's data only when it starts.");
    }
    await FS.mkdir(environment.nightlyHome, { recursive: true, mode: 0o700 });
    const target = flavorImportRequestPath(environment.nightlyHome);
    const staging = `${target}.${process.pid}.tmp`;
    try {
      await FS.writeFile(
        staging,
        formatFlavorImportRequest({
          sourceHomeDir: environment.rycoHome,
          requestedAt: options.now ?? new Date(),
        }),
        { flag: "wx", mode: 0o600 },
      );
      await FS.rename(staging, target);
    } catch (error) {
      await FS.rm(staging, { force: true });
      throw error;
    }
  }
  (environment.launch ?? launchDetached)(
    executable,
    handoffLaunchEnv(environment.env, {
      [RYCO_STABLE_HOME_ENV]: Path.resolve(environment.rycoHome),
      [RYCO_STABLE_EXECUTABLE_ENV]: environment.executable,
    }),
  );
}

/** Opens Ryco from Ryco Nightly. Nothing is copied back. */
export async function switchBackToRyco(environment: NightlyHandoffEnvironment): Promise<void> {
  if (environment.flavor !== "nightly") throw new Error("Only Ryco Nightly switches back.");
  const executable = await findFlavorApp(
    environment,
    "stable",
    environment.env[RYCO_STABLE_EXECUTABLE_ENV],
  );
  if (executable === null) throw new Error("Ryco is not installed in Applications.");
  // Ryco reads its own home from RYCO_HOME, so only the hand-off and Electron switches go.
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment.env)) {
    if (value === undefined) continue;
    if (key === RYCO_STABLE_HOME_ENV || key === RYCO_STABLE_EXECUTABLE_ENV) continue;
    // Never Ryco Nightly's own home, however it got into this environment.
    if (key === "RYCO_HOME" && Path.resolve(value) === Path.resolve(environment.nightlyHome)) {
      continue;
    }
    if (key === "ELECTRON_RUN_AS_NODE" || key === "ELECTRON_NO_ASAR") continue;
    env[key] = value;
  }
  (environment.launch ?? launchDetached)(executable, env);
}
