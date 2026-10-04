import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, cpSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import {
  buildCachedNativeBinary,
  desktopBuildArch,
  fingerprint,
  nativeBuildCacheDirectory,
  nativeBuildEnvironment,
  sourceTreeFingerprint,
  swiftToolchainIdentity,
} from "./native-build-cache.mjs";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function buildComputerUseHelper(desktopDirectory = desktop, { development = false } = {}) {
  const source = join(desktopDirectory, "native/computer-use-helper");
  const arch = desktopBuildArch({
    development,
    defaultArch: process.platform === "darwin" ? "universal" : process.arch,
  });
  const inputs = sourceTreeFingerprint(
    source,
    process.env.CARGO_TARGET_DIR ? [resolve(source, process.env.CARGO_TARGET_DIR)] : [],
  );
  const cacheKey = fingerprint(
    "computer-use-v2",
    inputs,
    "1.98.1",
    process.platform,
    arch,
    process.platform === "darwin" ? swiftToolchainIdentity() : [],
    nativeBuildEnvironment(),
    readFileSync(fileURLToPath(import.meta.url)),
  );
  // Retain compiler intermediates outside cloud checkouts across worktrees.
  const targetDirectory = process.env.CARGO_TARGET_DIR
    ? resolve(source, process.env.CARGO_TARGET_DIR)
    : join(nativeBuildCacheDirectory(), "cargo", "computer-use-1.98.1", cacheKey);
  const bin = join(homedir(), ".cargo", "bin");
  const cargo = join(bin, process.platform === "win32" ? "cargo.exe" : "cargo");
  function run(command, args) {
    const built = spawnSync(command, args, { cwd: source, stdio: "inherit" });
    if (built.error || built.status !== 0)
      throw new Error(
        `Computer-use helper command failed: ${command} ${args.join(" ")} (${built.error?.message ?? `exit ${built.status ?? built.signal}`}).`,
        { cause: built.error },
      );
  }
  const buildArguments = [
    "+1.98.1",
    "build",
    "--locked",
    "--release",
    "--target-dir",
    targetDirectory,
  ];
  const suffix = process.platform === "win32" ? ".exe" : "";
  const output = join(desktopDirectory, "resources", `ryco-computer-use-helper${suffix}`);
  mkdirSync(dirname(output), { recursive: true });
  const handshake = (binary) => {
    const checked = spawnSync(binary, ["--hello"], { encoding: "utf8" });
    try {
      return checked.status === 0 && JSON.parse(checked.stdout).protocolVersion === 3;
    } catch {
      return false;
    }
  };
  if (process.platform !== "darwin" && arch !== process.arch)
    throw new Error(`Build the native helper on a ${arch} runner; this runner is ${process.arch}.`);
  buildCachedNativeBinary({
    name: "computer-use",
    key: cacheKey,
    output,
    validate: handshake,
    build(binary) {
      if (process.platform === "darwin") {
        const targets =
          arch === "universal"
            ? ["aarch64-apple-darwin", "x86_64-apple-darwin"]
            : [arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin"];
        run(join(bin, "rustup"), ["target", "add", "--toolchain", "1.98.1", ...targets]);
        for (const target of targets) run(cargo, [...buildArguments, "--target", target]);
        const binaries = targets.map((target) =>
          join(targetDirectory, target, "release/ryco-computer-use"),
        );
        if (binaries.length === 1) copyFileSync(binaries[0], binary);
        else run("xcrun", ["lipo", "-create", ...binaries, "-output", binary]);
      } else {
        run(cargo, buildArguments);
        copyFileSync(join(targetDirectory, "release", `ryco-computer-use${suffix}`), binary);
      }
    },
  });
  cpSync(
    join(desktopDirectory, "browser-extension"),
    join(desktopDirectory, "resources/browser-extension"),
    {
      recursive: true,
    },
  );
  const licenses = join(desktopDirectory, "resources/computer-use-licenses");
  mkdirSync(licenses, { recursive: true });
  for (const file of ["LICENSE", "UPSTREAM.md"])
    copyFileSync(join(source, file), join(licenses, file));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  buildComputerUseHelper(desktop, { development: process.argv.includes("--dev") });
}
