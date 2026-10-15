/**
 * Update a machine's Ryco node to the checkout it runs from.
 *
 *   bun run node:update                 # pull, build, restart the background service
 *   bun run node:update -- --no-pull    # build what is checked out right now
 *   bun run node:update -- --install-service   # also install the service if there is none
 *
 * For a node that is not published to npm yet: it pulls the current branch,
 * installs dependencies, builds the CLI with its bundled web app, and points the
 * background service at this checkout's build. Reinstalling the service keeps
 * every saved setting (workspace, port, Hub and E2EE policy) and the node's
 * identity, which live in the Ryco home rather than in the build.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const cliEntry = path.join(root, "apps/server/dist/bin.mjs");
const args = new Set(process.argv.slice(2));
const pull = !args.has("--no-pull");
const installServiceWhenMissing = args.has("--install-service");
// The service pins the binary that installs it, and it must be Node.
const nodeBinary = path.basename(process.execPath).startsWith("bun") ? "node" : process.execPath;

for (const arg of args) {
  if (arg !== "--no-pull" && arg !== "--install-service") {
    fail(`Unknown option ${arg}. Use --no-pull and/or --install-service.`);
  }
}

function step(message: string): void {
  console.log(`\n▸ ${message}`);
}

function fail(message: string): never {
  console.error(`\n✗ ${message}`);
  process.exit(1);
}

function run(command: string, commandArgs: ReadonlyArray<string>): void {
  const result = spawnSync(command, commandArgs, { cwd: root, stdio: "inherit" });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0)
    fail(`${command} ${commandArgs.join(" ")} exited with ${result.status}.`);
}

function capture(command: string, commandArgs: ReadonlyArray<string>): string | null {
  try {
    return execFileSync(command, commandArgs, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

/** The freshly built CLI, without Node's experimental-SQLite warning. */
function cli(commandArgs: ReadonlyArray<string>): void {
  run(nodeBinary, ["--no-warnings", cliEntry, ...commandArgs]);
}

function cliJson<T>(commandArgs: ReadonlyArray<string>): T | null {
  const output = capture(nodeBinary, ["--no-warnings", cliEntry, ...commandArgs]);
  const line = output?.split("\n").findLast((entry) => entry.trim().startsWith("{"));
  if (line === undefined) return null;
  try {
    return JSON.parse(line) as T;
  } catch {
    return null;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// ── Source ───────────────────────────────────────────────────────────────────
const branch = capture("git", ["rev-parse", "--abbrev-ref", "HEAD"]) ?? "unknown";
if (pull) {
  step(`Pulling ${branch}`);
  run("git", ["pull", "--ff-only"]);
}
console.log(`  at ${capture("git", ["log", "-1", "--format=%h %s"]) ?? "unknown commit"}`);

// ── Toolchains ───────────────────────────────────────────────────────────────
if (capture("bun", ["--version"]) === null) {
  fail("Bun is not on PATH. Install it from https://bun.sh, then run this again.");
}
const rustToolchain = readFileSync(
  path.join(root, "native/resource-monitor/rust-toolchain.toml"),
  "utf8",
).match(/channel\s*=\s*"([^"]+)"/u)?.[1];
if (!rustToolchain) fail("native/resource-monitor/rust-toolchain.toml names no Rust toolchain.");
if (capture("rustup", ["--version"]) === null) {
  fail(
    [
      "rustup is not on PATH; the CLI build compiles the native resource monitor. Install it with:",
      "  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain none",
      '  source "$HOME/.cargo/env"',
    ].join("\n"),
  );
}
if (capture("rustup", ["run", rustToolchain, "cargo", "--version"]) === null) {
  step(`Installing Rust ${rustToolchain}`);
  run("rustup", ["toolchain", "install", rustToolchain, "--profile", "minimal"]);
}

// ── Build ────────────────────────────────────────────────────────────────────
step("Installing dependencies");
run("bun", ["install", "--frozen-lockfile"]);

step("Building the CLI and its web app");
run("bun", ["run", "build", "--filter=ryco-cli", "--filter=@ryco/web"]);
for (const required of ["apps/server/dist/bin.mjs", "apps/server/dist/client/index.html"]) {
  if (!existsSync(path.join(root, required))) fail(`The build did not produce ${required}.`);
}

// ── Service ──────────────────────────────────────────────────────────────────
interface ServiceStatus {
  readonly installed: boolean;
  readonly running: boolean;
  readonly logPath?: string;
}

const before = cliJson<ServiceStatus>(["service", "status", "--json"]);
if (before === null) fail("Could not read the background service status.");

if (!before.installed && !installServiceWhenMissing) {
  console.log(
    [
      "",
      "✓ Built. No background service is installed on this machine, so nothing was restarted.",
      "  Run the node in a terminal:   node --max-semi-space-size=16 apps/server/dist/bin.mjs serve",
      "  Or install it as a service:   bun run node:update -- --no-pull --install-service",
    ].join("\n"),
  );
  process.exit(0);
}

step(
  before.installed
    ? "Pointing the background service at this build and restarting it"
    : "Installing the background service",
);
cli(["service", "install"]);

let after: ServiceStatus | null = null;
for (let attempt = 0; attempt < 30; attempt += 1) {
  after = cliJson<ServiceStatus>(["service", "status", "--json"]);
  if (after?.running) break;
  await sleep(1_000);
}
if (!after?.running) {
  fail(
    `The service did not start. Read its log with: node apps/server/dist/bin.mjs service logs${
      after?.logPath ? ` (${after.logPath})` : ""
    }`,
  );
}

step("Hub status");
// The server answers once it has finished starting; give it a moment.
for (let attempt = 0; ; attempt += 1) {
  const result = spawnSync(nodeBinary, ["--no-warnings", cliEntry, "hub", "status"], {
    cwd: root,
    encoding: "utf8",
  });
  if (result.status === 0 || attempt >= 20) {
    process.stdout.write(result.stdout || result.stderr);
    break;
  }
  await sleep(1_000);
}

console.log("\n✓ Updated. The node now runs this checkout's build.");
