import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, cpSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir, tmpdir } from "node:os";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export function buildComputerUseHelper(desktopDirectory = desktop) {
  const source = join(desktopDirectory, "native/computer-use-helper");
  // Cargo hard-links build scripts. Keep intermediate files off cloud-managed
  // checkouts, and separate worktrees while retaining incremental builds.
  const cacheKey = createHash("sha256").update(source).digest("hex").slice(0, 16);
  const targetDirectory = process.env.CARGO_TARGET_DIR
    ? resolve(source, process.env.CARGO_TARGET_DIR)
    : join(tmpdir(), "ryco-computer-use-helper", cacheKey);
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
  if (process.platform === "darwin") {
    const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
    run(join(bin, "rustup"), ["target", "add", "--toolchain", "1.98.1", ...targets]);
    for (const target of targets) run(cargo, [...buildArguments, "--target", target]);
    run("xcrun", [
      "lipo",
      "-create",
      ...targets.map((target) => join(targetDirectory, target, "release/ryco-computer-use")),
      "-output",
      output,
    ]);
  } else {
    const requestedArch = process.env.RYCO_DESKTOP_ARCH ?? process.arch;
    if (requestedArch !== process.arch)
      throw new Error(
        `Build the native helper on a ${requestedArch} runner; this runner is ${process.arch}.`,
      );
    run(cargo, buildArguments);
    copyFileSync(join(targetDirectory, "release", `ryco-computer-use${suffix}`), output);
  }
  chmodSync(output, 0o755);
  const checked = spawnSync(output, ["--hello"], { encoding: "utf8" });
  if (checked.status !== 0 || JSON.parse(checked.stdout).protocolVersion !== 3)
    throw new Error("Computer-use helper handshake failed.");
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
  buildComputerUseHelper();
}
