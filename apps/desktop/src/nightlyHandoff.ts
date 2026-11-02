import * as ChildProcess from "node:child_process";
import * as Crypto from "node:crypto";
import * as FS from "node:fs/promises";
import * as Path from "node:path";

import type { DesktopNightlyState } from "@ryco/contracts";
import { type RycoDesktopFlavor, rycoDesktopFlavorIdentity } from "@ryco/shared/desktopFlavor";
import {
  flavorImportRequestPath,
  flavorImportResultPath,
  formatFlavorImportRequest,
  parseFlavorImportResult,
  RYCO_FLAVOR_IMPORT_TOKEN_ENV,
  RYCO_STABLE_HOME_ENV,
} from "@ryco/shared/flavorImport";

/**
 * Trying Ryco Nightly from Ryco, and coming back (port of Synara's beta hand-off, BETA.md).
 *
 * Ryco finds an installed Ryco Nightly, checks it is signed like itself, opens it through macOS,
 * and can ask it for a copy of Ryco's data: it writes the request into Nightly's home (never
 * anything into its own) and Nightly's server makes the copy on start, only for the launch the
 * request names (`@ryco/shared/flavorImport`). Ryco Nightly opens Ryco again; it never copies
 * anything back. Installing Ryco Nightly from inside the app is a later step; until then the
 * releases page has it.
 */

/** Set by Ryco when it opens Ryco Nightly: the app to open on "Switch back to Ryco". */
export const RYCO_STABLE_EXECUTABLE_ENV = "RYCO_STABLE_EXECUTABLE";
export const RYCO_RELEASES_URL = "https://github.com/saka-gg/ryco/releases";

/** Read at most this much of an app's Info.plist, or of a runtime file. */
const MAX_METADATA_BYTES = 64 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;

export interface CommandOutput {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}
export type ReadCommand = (command: string, args: ReadonlyArray<string>) => Promise<CommandOutput>;

/**
 * The team id the other app must be signed by: this app's own. `null` skips the check (this app
 * is unsigned, e.g. a development build); `"unavailable"` means this signed app could not read
 * its own team id, which refuses rather than skipping.
 */
export type ExpectedTeamId = string | null | "unavailable";

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
  /** The team id this app is signed by ({@link ownAppTeamId}). */
  readonly expectedTeamId: ExpectedTeamId;
  /** The folders apps are looked for in; the two Applications folders when omitted. */
  readonly applicationsDirectories?: ReadonlyArray<string>;
  /** Runs `codesign`; injectable for tests. */
  readonly readCommand?: ReadCommand;
  /** Opens an app bundle through macOS with these variables; injectable for tests. */
  readonly openApp?: (
    bundlePath: string,
    variables: Readonly<Record<string, string>>,
  ) => Promise<void>;
}

const readCommandDefault: ReadCommand = (command, args) =>
  new Promise((resolve) => {
    ChildProcess.execFile(
      command,
      [...args],
      { encoding: "utf8", timeout: COMMAND_TIMEOUT_MS, maxBuffer: 1024 * 1024 },
      (error, stdout, stderr) => {
        const code = (error as { readonly code?: unknown } | null)?.code;
        resolve({ status: error ? (typeof code === "number" ? code : 1) : 0, stdout, stderr });
      },
    );
  });

/**
 * Opens the bundle the way the Dock does (`open -a`), so it starts with the login session's
 * environment plus only the given variables, never this app's, and macOS treats it as its own
 * app rather than a child of this one. An app that already runs is only brought forward: it
 * never sees the variables.
 */
async function openAppDefault(
  bundlePath: string,
  variables: Readonly<Record<string, string>>,
): Promise<void> {
  const args = ["-a", bundlePath];
  for (const [key, value] of Object.entries(variables)) args.push("--env", `${key}=${value}`);
  const result = await readCommandDefault("/usr/bin/open", args);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `macOS could not open ${Path.basename(bundlePath)}.`);
  }
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
 * The executable of a macOS app bundle, when the bundle is the given flavor's app: a real folder
 * (not a link) whose Info.plist names that flavor's bundle id. A bundle with another id (an
 * unrelated or foreign app at the same name) is never opened.
 */
export async function flavorAppExecutable(
  bundlePath: string,
  flavor: RycoDesktopFlavor,
): Promise<string | null> {
  try {
    const info = await FS.lstat(bundlePath);
    if (!info.isDirectory()) return null;
  } catch {
    return null;
  }
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
export function bundleOfExecutable(executable: string): string | null {
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

/** The bundle of the given flavor's app, the one handed over first. */
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
    if ((await flavorAppExecutable(bundle, flavor)) !== null) return bundle;
  }
  return null;
}

const TEAM_ID_LINE = /^TeamIdentifier=(\S.*?)\s*$/mu;
const IDENTIFIER_LINE = /^Identifier=(\S+)$/mu;

/** The team id this app is signed by (Synara's `ownAppTeamId`); null for a development build. */
export async function ownAppTeamId(input: {
  readonly platform: NodeJS.Platform;
  readonly isPackaged: boolean;
  readonly executable: string;
  readonly readCommand?: ReadCommand;
}): Promise<ExpectedTeamId> {
  if (input.platform !== "darwin" || !input.isPackaged) return null;
  const bundle = bundleOfExecutable(input.executable);
  if (bundle === null) return "unavailable";
  const result = await (input.readCommand ?? readCommandDefault)("/usr/bin/codesign", [
    "-dv",
    "--verbose=4",
    bundle,
  ]);
  // codesign describes a signature on stderr.
  if (result.status !== 0) {
    return /not signed|unsigned/iu.test(`${result.stderr}\n${result.stdout}`)
      ? null
      : "unavailable";
  }
  const teamId = TEAM_ID_LINE.exec(result.stderr)?.[1];
  if (teamId === undefined) return "unavailable";
  return teamId === "not set" ? null : teamId;
}

/**
 * The other app must be signed by this app's team and as that flavor's bundle id (Synara's
 * `verifyBetaCodeSignature`). A development build of this app, unsigned itself, has nothing to
 * compare against and checks only the Info.plist.
 */
export async function verifyFlavorAppSignature(
  bundlePath: string,
  flavor: RycoDesktopFlavor,
  expectedTeamId: ExpectedTeamId,
  readCommand: ReadCommand = readCommandDefault,
): Promise<void> {
  const name = rycoDesktopFlavorIdentity(flavor).productName;
  if (expectedTeamId === null) return;
  if (expectedTeamId === "unavailable") {
    throw new Error(`Ryco could not read its own signature, so it does not open ${name}.`);
  }
  const unsigned = new Error(
    `${name} at ${bundlePath} is not signed by Ryco's team. It was not opened.`,
  );
  const verify = await readCommand("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    bundlePath,
  ]);
  if (verify.status !== 0) throw unsigned;
  const info = await readCommand("/usr/bin/codesign", ["-dv", "--verbose=4", bundlePath]);
  if (
    TEAM_ID_LINE.exec(info.stderr)?.[1] !== expectedTeamId ||
    IDENTIFIER_LINE.exec(info.stderr)?.[1] !== rycoDesktopFlavorIdentity(flavor).appId
  ) {
    throw unsigned;
  }
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

/** A path with every link in its existing part resolved; the missing rest is kept as written. */
async function canonicalPath(path: string): Promise<string> {
  const missing: string[] = [];
  let current = Path.resolve(path);
  for (;;) {
    try {
      return Path.join(await FS.realpath(current), ...missing.toReversed());
    } catch {
      const parent = Path.dirname(current);
      if (parent === current) return Path.resolve(path);
      missing.push(Path.basename(current));
      current = parent;
    }
  }
}

function isWithin(parent: string, child: string): boolean {
  const relative = Path.relative(parent, child);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${Path.sep}`) && !Path.isAbsolute(relative))
  );
}

/** The two data homes are the same folder, or one holds the other, links resolved. */
export async function dataHomesOverlap(first: string, second: string): Promise<boolean> {
  const [a, b] = await Promise.all([canonicalPath(first), canonicalPath(second)]);
  return isWithin(a, b) || isWithin(b, a);
}

/**
 * The only variables Ryco Nightly starts with besides the login session's: where Ryco's data and
 * app are, Nightly's own home when this app was given one, and the copy request's token.
 */
export function nightlyLaunchVariables(
  environment: NightlyHandoffEnvironment,
  token: string | null,
): Record<string, string> {
  const nightlyHomeEnv = rycoDesktopFlavorIdentity("nightly").homeEnv;
  const nightlyHome = environment.env[nightlyHomeEnv]?.trim();
  return {
    [RYCO_STABLE_HOME_ENV]: Path.resolve(environment.rycoHome),
    [RYCO_STABLE_EXECUTABLE_ENV]: environment.executable,
    ...(nightlyHome ? { [nightlyHomeEnv]: nightlyHome } : {}),
    ...(token === null ? {} : { [RYCO_FLAVOR_IMPORT_TOKEN_ENV]: token }),
  };
}

/**
 * The only variable Ryco starts with from Ryco Nightly: the data home Ryco handed over when it
 * opened Nightly, when that is not Ryco's usual one and not Nightly's own.
 */
export async function rycoLaunchVariables(
  environment: NightlyHandoffEnvironment,
): Promise<Record<string, string>> {
  const stable = rycoDesktopFlavorIdentity("stable");
  const handedOver = environment.env[RYCO_STABLE_HOME_ENV]?.trim();
  if (!handedOver || !Path.isAbsolute(handedOver)) return {};
  const home = Path.resolve(handedOver);
  if (home === Path.resolve(environment.homeDirectory, stable.homeDirectoryName)) return {};
  if (await dataHomesOverlap(home, environment.nightlyHome)) return {};
  return { [stable.homeEnv]: home };
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

/** Writes the copy request into Ryco Nightly's home, all at once. */
async function writeCopyRequest(
  environment: NightlyHandoffEnvironment,
  token: string,
  now: Date,
): Promise<string> {
  await FS.mkdir(environment.nightlyHome, { recursive: true, mode: 0o700 });
  const target = flavorImportRequestPath(environment.nightlyHome);
  const staging = `${target}.${Crypto.randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await FS.open(staging, "wx", 0o600);
    created = true;
    try {
      await handle.writeFile(
        formatFlavorImportRequest({ sourceHomeDir: environment.rycoHome, requestedAt: now, token }),
      );
    } finally {
      await handle.close();
    }
    await FS.rename(staging, target);
    created = false;
  } finally {
    // Only a staging file this call made; never one that was there before.
    if (created) await FS.rm(staging, { force: true });
  }
  return target;
}

/**
 * Opens Ryco Nightly from Ryco. With `copyData`, first asks it for a copy of Ryco's data: refused
 * while Nightly's node runs (it copies before its node starts) or when the two data homes
 * overlap; the request goes into Nightly's home only and is taken only by the launch it names.
 */
export async function openNightly(
  environment: NightlyHandoffEnvironment,
  options: { readonly copyData: boolean; readonly now?: Date },
): Promise<void> {
  if (environment.flavor !== "stable") throw new Error("Only Ryco opens Ryco Nightly.");
  const bundle = await findFlavorApp(environment, "nightly");
  if (bundle === null) throw new Error("Ryco Nightly is not installed in Applications.");
  await verifyFlavorAppSignature(
    bundle,
    "nightly",
    environment.expectedTeamId,
    environment.readCommand,
  );
  let token: string | null = null;
  let requestPath: string | null = null;
  if (options.copyData) {
    if (await dataHomesOverlap(environment.rycoHome, environment.nightlyHome)) {
      throw new Error(
        "Ryco Nightly's data folder is Ryco's own, or inside it. Nothing was copied.",
      );
    }
    if (await nightlyNodeRunning(environment.nightlyHome)) {
      throw new Error("Quit Ryco Nightly first: it copies Ryco's data only when it starts.");
    }
    token = Crypto.randomBytes(24).toString("base64url");
    requestPath = await writeCopyRequest(environment, token, options.now ?? new Date());
  }
  try {
    await (environment.openApp ?? openAppDefault)(
      bundle,
      nightlyLaunchVariables(environment, token),
    );
  } catch (error) {
    // No launch carries this request's token, so it could never be taken: leave nothing behind.
    if (requestPath !== null) await FS.rm(requestPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/** Opens Ryco from Ryco Nightly. Nothing is copied back. */
export async function switchBackToRyco(environment: NightlyHandoffEnvironment): Promise<void> {
  if (environment.flavor !== "nightly") throw new Error("Only Ryco Nightly switches back.");
  const bundle = await findFlavorApp(
    environment,
    "stable",
    environment.env[RYCO_STABLE_EXECUTABLE_ENV],
  );
  if (bundle === null) throw new Error("Ryco is not installed in Applications.");
  await verifyFlavorAppSignature(
    bundle,
    "stable",
    environment.expectedTeamId,
    environment.readCommand,
  );
  await (environment.openApp ?? openAppDefault)(bundle, await rycoLaunchVariables(environment));
}
