/**
 * Ryco and Ryco Nightly: two desktop apps from one codebase.
 *
 * Nightly installs next to Ryco as its own app, with its own bundle id, data
 * home, Electron profile, single-instance lock, update feed and node identity,
 * so trying a nightly never touches the workspace the stable app keeps (port of
 * Synara's beta flavor, BETA.md). Crossing between them happens by opening the
 * other app, never by an update: each follows only its own channel and never
 * downgrades.
 *
 * Schema-free and dependency-free: the desktop entry, the build script, the
 * server and the web app all read it.
 */

/** A nightly version: `X.Y.Z-nightly.YYYYMMDD.N` (docs/release.md). */
export const NIGHTLY_VERSION_PATTERN = /-nightly\.\d{8}\.\d+$/u;

export function isNightlyVersion(version: string): boolean {
  return NIGHTLY_VERSION_PATTERN.test(version);
}

/** The update/npm channel a version belongs to. */
export function releaseChannelForVersion(version: string): "latest" | "nightly" {
  return isNightlyVersion(version) ? "nightly" : "latest";
}

export type RycoDesktopFlavor = "stable" | "nightly";

/**
 * The packaged app's `package.json` field that names its flavor. The build
 * writes it; a missing field (every build before the split, and the legacy
 * in-place nightly) means `stable`.
 */
export const RYCO_DESKTOP_FLAVOR_METADATA_KEY = "rycoDesktopFlavor";

export function parseRycoDesktopFlavor(value: unknown): RycoDesktopFlavor {
  return value === "nightly" ? "nightly" : "stable";
}

export interface RycoDesktopFlavorIdentity {
  readonly flavor: RycoDesktopFlavor;
  /** electron-builder `appId` (macOS bundle id; NSIS derives its GUID from it). */
  readonly appId: string;
  readonly productName: string;
  /** Electron `userData` directory name (also keys the single-instance lock). */
  readonly userDataDirectoryName: string;
  /** Default data home under the user's home directory. */
  readonly homeDirectoryName: string;
  /** The only environment variable that moves this flavor's data home. */
  readonly homeEnv: "RYCO_HOME" | "RYCO_NIGHTLY_HOME";
  /** OS URL scheme of the hosted sign-in callback. Nightly never claims `ryco`. */
  readonly authorizationScheme: "ryco" | "ryco-preview";
  /** Windows AppUserModelID. */
  readonly appUserModelId: string;
  /** Linux executable, `.desktop` entry and WM class. */
  readonly linuxName: string;
  /** electron-updater channel; the app accepts no version outside it. */
  readonly updateChannel: "latest" | "nightly";
}

export const RYCO_DESKTOP_FLAVOR_IDENTITIES: Readonly<
  Record<RycoDesktopFlavor, RycoDesktopFlavorIdentity>
> = {
  stable: {
    flavor: "stable",
    appId: "com.laurinfrank.ryco",
    productName: "Ryco",
    userDataDirectoryName: "ryco",
    homeDirectoryName: ".ryco",
    homeEnv: "RYCO_HOME",
    authorizationScheme: "ryco",
    appUserModelId: "com.sak0a.ryco",
    linuxName: "ryco",
    updateChannel: "latest",
  },
  nightly: {
    flavor: "nightly",
    appId: "com.laurinfrank.ryco.nightly",
    productName: "Ryco Nightly",
    userDataDirectoryName: "ryco-nightly",
    homeDirectoryName: ".ryco-nightly",
    homeEnv: "RYCO_NIGHTLY_HOME",
    authorizationScheme: "ryco-preview",
    appUserModelId: "com.sak0a.ryco.nightly",
    linuxName: "ryco-nightly",
    updateChannel: "nightly",
  },
};

export function rycoDesktopFlavorIdentity(flavor: RycoDesktopFlavor): RycoDesktopFlavorIdentity {
  return RYCO_DESKTOP_FLAVOR_IDENTITIES[flavor];
}

/**
 * The channel a running desktop app follows. A stable-identity app running a
 * nightly version is a legacy in-place nightly (or the bridge build that
 * retires it): it follows stable releases, which install as an ordinary update
 * because a nightly's base is the next stable patch.
 */
export function desktopUpdateChannelForFlavor(flavor: RycoDesktopFlavor): "latest" | "nightly" {
  return rycoDesktopFlavorIdentity(flavor).updateChannel;
}

/** A stable-identity app on a nightly version: the in-place nightly that Ryco Nightly replaces. */
export function isLegacyInPlaceNightly(input: {
  readonly flavor: RycoDesktopFlavor;
  readonly appVersion: string;
}): boolean {
  return input.flavor === "stable" && isNightlyVersion(input.appVersion);
}
