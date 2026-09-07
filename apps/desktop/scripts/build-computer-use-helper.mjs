import { spawnSync } from "node:child_process";
import { mkdirSync, copyFileSync, cpSync, chmodSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const source = join(desktop, "native/computer-use-helper");
const bin = join(homedir(), ".cargo", "bin");
const cargo = join(bin, process.platform === "win32" ? "cargo.exe" : "cargo");
function run(command, args) {
  const built = spawnSync(command, args, { cwd: source, stdio: "inherit" });
  if (built.error || built.status !== 0)
    throw new Error(
      "Computer-use helper build failed. Install Rust 1.98.1 with rustup toolchain install 1.98.1 --profile minimal.",
    );
}
const suffix = process.platform === "win32" ? ".exe" : "";
const output = join(desktop, "resources", `ryco-computer-use-helper${suffix}`);
mkdirSync(dirname(output), { recursive: true });
if (process.platform === "darwin") {
  const targets = ["aarch64-apple-darwin", "x86_64-apple-darwin"];
  run(join(bin, "rustup"), ["target", "add", "--toolchain", "1.98.1", ...targets]);
  for (const target of targets)
    run(cargo, ["+1.98.1", "build", "--locked", "--release", "--target", target]);
  run("xcrun", [
    "lipo",
    "-create",
    ...targets.map((target) => join(source, "target", target, "release/poracode-computer-use")),
    "-output",
    output,
  ]);
} else {
  const requestedArch = process.env.RYCO_DESKTOP_ARCH ?? process.arch;
  if (requestedArch !== process.arch)
    throw new Error(
      `Build the native helper on a ${requestedArch} runner; this runner is ${process.arch}.`,
    );
  run(cargo, ["+1.98.1", "build", "--locked", "--release"]);
  copyFileSync(join(source, "target/release", `poracode-computer-use${suffix}`), output);
}
chmodSync(output, 0o755);
const checked = spawnSync(output, ["--hello"], { encoding: "utf8" });
if (checked.status !== 0 || JSON.parse(checked.stdout).protocolVersion !== 3)
  throw new Error("Computer-use helper handshake failed.");
cpSync(join(desktop, "browser-extension"), join(desktop, "resources/browser-extension"), {
  recursive: true,
});
const licenses = join(desktop, "resources/computer-use-licenses");
mkdirSync(licenses, { recursive: true });
for (const file of ["LICENSE", "UPSTREAM.md"])
  copyFileSync(join(source, file), join(licenses, file));
