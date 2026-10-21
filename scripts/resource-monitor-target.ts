/**
 * Resolve only supported release targets; values are never interpolated into a shell.
 * `x64 darwin` stays for the npm CLI's Intel Mac monitor; the desktop app builds arm64 only.
 */
export function resourceMonitorBuildTarget(platform: string, architecture: string): string {
  const targets: Readonly<Record<string, Readonly<Record<string, string>>>> = {
    darwin: { arm64: "aarch64-apple-darwin", x64: "x86_64-apple-darwin" },
    linux: { arm64: "aarch64-unknown-linux-gnu", x64: "x86_64-unknown-linux-gnu" },
    win32: { arm64: "aarch64-pc-windows-msvc", x64: "x86_64-pc-windows-msvc" },
  };
  const platformTargets = Object.hasOwn(targets, platform) ? targets[platform] : undefined;
  const target =
    platformTargets && Object.hasOwn(platformTargets, architecture)
      ? platformTargets[architecture]
      : undefined;
  if (!target) throw new Error(`Unsupported resource monitor target: ${platform}/${architecture}`);
  return target;
}
