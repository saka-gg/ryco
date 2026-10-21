// The generic cache lives with the repository scripts so the CLI's resource
// monitor build shares it; desktop scripts keep importing from here.
export {
  buildCachedNativeBinary,
  fingerprint,
  markNativeCacheEntryUsed,
  nativeBuildCacheDirectory,
  nativeBuildEnvironment,
  publishNativeCacheDirectory,
  sourceTreeFingerprint,
  stageNativeBinary,
  swiftModuleCacheDirectory,
  swiftToolchainIdentity,
} from "../../../scripts/lib/native-build-cache.ts";

/**
 * The macOS desktop app ships for Apple Silicon only, so Mac native builds are arm64 and
 * refuse Intel (x64) or universal requests. Linux and Windows build x64 or arm64.
 */
export function assertDesktopBuildArch(arch, platform = process.platform) {
  if (platform === "darwin") {
    if (arch === "arm64") return arch;
    throw new Error(
      `Unsupported macOS native build architecture: ${arch}. The Mac desktop app is built for Apple Silicon (arm64) only; Intel (x64) and universal Mac builds are not supported.`,
    );
  }
  if (arch === "arm64" || arch === "x64") return arch;
  throw new Error(
    `Unsupported ${platform} native build architecture: ${arch} (expected arm64 or x64).`,
  );
}

/**
 * RYCO_DESKTOP_ARCH wins. Otherwise Mac packaging builds arm64 and development builds
 * match the host so the helpers load into the local Electron.
 */
export function desktopBuildArch({
  development = false,
  platform = process.platform,
  hostArch = process.arch,
  env = process.env,
} = {}) {
  const arch =
    env.RYCO_DESKTOP_ARCH ?? (platform === "darwin" && !development ? "arm64" : hostArch);
  return assertDesktopBuildArch(arch, platform);
}
