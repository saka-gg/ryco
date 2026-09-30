/**
 * Keep a headless Ryco node running: across logout-free reboots, crashes, and
 * the terminal it was started from closing. On macOS this is a per-user
 * LaunchAgent (a LaunchAgent rather than a LaunchDaemon so the login Keychain,
 * which holds the node's Hub key, stays reachable); on Linux a systemd user
 * unit. Everything here renders or manages that one definition; the server it
 * starts is the ordinary `ryco serve`.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

import { runProcess, type ProcessRunResult } from "../processRunner.ts";

export type NodeServicePlatform = "launchd" | "systemd";

export const DEFAULT_NODE_SERVICE_LABEL = "space.ryco.node";

/** Restart a crashed node, but no faster than this. */
const RESTART_THROTTLE_SECONDS = 10;

export interface NodeServiceSpec {
  readonly label: string;
  /** The runtime executing the CLI — node or bun — so no PATH lookup is needed at boot. */
  readonly execPath: string;
  /** The CLI entry script. */
  readonly scriptPath: string;
  /** Arguments after the script, starting with `serve`. */
  readonly args: ReadonlyArray<string>;
  readonly workingDirectory: string;
  readonly logPath: string;
  readonly environment: Readonly<Record<string, string>>;
}

export function nodeServicePlatform(
  platform: NodeJS.Platform = process.platform,
): NodeServicePlatform | null {
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

/**
 * One service per state directory: the default directory gets the plain label,
 * any other a stable suffix, so two nodes on one machine never replace each
 * other's definition.
 */
export function nodeServiceLabel(baseDir: string, defaultBaseDir: string): string {
  const resolved = path.resolve(baseDir);
  if (resolved === path.resolve(defaultBaseDir)) return DEFAULT_NODE_SERVICE_LABEL;
  const suffix = createHash("sha256").update(resolved).digest("hex").slice(0, 8);
  return `${DEFAULT_NODE_SERVICE_LABEL}.${suffix}`;
}

export function systemdUnitName(label: string): string {
  return `${label.replace(/^space\.ryco\./u, "ryco-").replaceAll(".", "-")}.service`;
}

export function nodeServiceDefinitionPath(
  platform: NodeServicePlatform,
  label: string,
  home: string = homedir(),
): string {
  return platform === "launchd"
    ? path.join(home, "Library", "LaunchAgents", `${label}.plist`)
    : path.join(home, ".config", "systemd", "user", systemdUnitName(label));
}

/**
 * An install that will not exist after a reboot: `npx`, `bunx`, or anything
 * under the temporary directory. A service pointing there fails on its first
 * restart, so installing one is refused.
 */
export function isEphemeralCliInstall(scriptPath: string, temporaryDirectory = tmpdir()): boolean {
  const normalized = scriptPath.split(path.sep).join("/");
  return (
    normalized.includes("/_npx/") ||
    normalized.includes("/.bun/install/cache/") ||
    /\/bunx-[^/]+\//u.test(normalized) ||
    path.resolve(scriptPath).startsWith(path.resolve(temporaryDirectory) + path.sep)
  );
}

const escapeXml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");

export function renderLaunchAgentPlist(spec: NodeServiceSpec): string {
  const string = (value: string) => `<string>${escapeXml(value)}</string>`;
  const programArguments = [spec.execPath, spec.scriptPath, ...spec.args]
    .map((argument) => `    ${string(argument)}`)
    .join("\n");
  const environment = Object.entries(spec.environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>\n    ${string(value)}`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  ${string(spec.label)}
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>WorkingDirectory</key>
  ${string(spec.workingDirectory)}
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>${RESTART_THROTTLE_SECONDS}</integer>
  <key>StandardOutPath</key>
  ${string(spec.logPath)}
  <key>StandardErrorPath</key>
  ${string(spec.logPath)}
</dict>
</plist>
`;
}

/** systemd's own quoting: double quotes, with backslash, quote, and `%` escaped. */
const quoteSystemd = (value: string): string =>
  `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("%", "%%")}"`;

export function renderSystemdUserUnit(spec: NodeServiceSpec): string {
  const execStart = [spec.execPath, spec.scriptPath, ...spec.args].map(quoteSystemd).join(" ");
  const environment = Object.entries(spec.environment)
    .toSorted(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `Environment=${quoteSystemd(`${key}=${value}`)}`)
    .join("\n");
  return `[Unit]
Description=Ryco node (${spec.label})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
WorkingDirectory=${quoteSystemd(spec.workingDirectory)}
${environment}
Restart=always
RestartSec=${RESTART_THROTTLE_SECONDS}
StandardOutput=append:${spec.logPath}
StandardError=append:${spec.logPath}

[Install]
WantedBy=default.target
`;
}

export function renderNodeServiceDefinition(
  platform: NodeServicePlatform,
  spec: NodeServiceSpec,
): string {
  return platform === "launchd" ? renderLaunchAgentPlist(spec) : renderSystemdUserUnit(spec);
}

/** The CLI entry script as it will be found after a reboot, symlinks resolved. */
export async function resolveCliEntryScript(argv1: string | undefined = process.argv[1]) {
  if (!argv1) throw new Error("Unable to determine the ryco CLI entry script.");
  return realpath(argv1).catch(() => path.resolve(argv1));
}

export class NodeServiceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NodeServiceError";
  }
}

async function run(
  command: string,
  args: ReadonlyArray<string>,
  options: { readonly allowFailure?: boolean } = {},
): Promise<ProcessRunResult> {
  const result = await runProcess(command, args, {
    timeoutMs: 30_000,
    allowNonZeroExit: true,
    outputMode: "truncate",
  });
  if (!options.allowFailure && result.code !== 0) {
    const detail = (result.stderr || result.stdout).trim();
    throw new NodeServiceError(
      `${command} ${args.join(" ")} failed${detail ? `: ${detail}` : "."}`,
    );
  }
  return result;
}

const launchdDomain = () => `gui/${process.getuid?.() ?? 0}`;

export interface NodeServiceStatus {
  readonly platform: NodeServicePlatform;
  readonly label: string;
  readonly definitionPath: string;
  readonly installed: boolean;
  readonly loaded: boolean;
  readonly running: boolean;
  readonly pid: number | null;
  /** Linux only: without lingering, a user unit stops at logout and waits for a login at boot. */
  readonly lingering: boolean | null;
}

export async function installNodeService(
  platform: NodeServicePlatform,
  spec: NodeServiceSpec,
): Promise<string> {
  const definitionPath = nodeServiceDefinitionPath(platform, spec.label);
  await mkdir(path.dirname(definitionPath), { recursive: true });
  await mkdir(path.dirname(spec.logPath), { recursive: true });
  await writeFile(definitionPath, renderNodeServiceDefinition(platform, spec), { mode: 0o644 });
  if (platform === "launchd") {
    const target = `${launchdDomain()}/${spec.label}`;
    // Replace a previous definition in place: bootstrap refuses a loaded label.
    await run("launchctl", ["bootout", target], { allowFailure: true });
    await run("launchctl", ["bootstrap", launchdDomain(), definitionPath]);
    await run("launchctl", ["enable", target], { allowFailure: true });
    await run("launchctl", ["kickstart", "-k", target], { allowFailure: true });
  } else {
    const unit = systemdUnitName(spec.label);
    await run("systemctl", ["--user", "daemon-reload"]);
    await run("systemctl", ["--user", "enable", unit]);
    await run("systemctl", ["--user", "restart", unit]);
  }
  return definitionPath;
}

export async function uninstallNodeService(
  platform: NodeServicePlatform,
  label: string,
): Promise<{ readonly removed: boolean; readonly definitionPath: string }> {
  const definitionPath = nodeServiceDefinitionPath(platform, label);
  if (platform === "launchd") {
    await run("launchctl", ["bootout", `${launchdDomain()}/${label}`], { allowFailure: true });
  } else {
    await run("systemctl", ["--user", "disable", "--now", systemdUnitName(label)], {
      allowFailure: true,
    });
  }
  const existed = await readFile(definitionPath).then(
    () => true,
    () => false,
  );
  await rm(definitionPath, { force: true });
  if (platform === "systemd") {
    await run("systemctl", ["--user", "daemon-reload"], { allowFailure: true });
  }
  return { removed: existed, definitionPath };
}

export async function startNodeService(platform: NodeServicePlatform, label: string) {
  if (platform === "launchd") {
    const target = `${launchdDomain()}/${label}`;
    const loaded = await run("launchctl", ["print", target], { allowFailure: true });
    if (loaded.code !== 0) {
      await run("launchctl", [
        "bootstrap",
        launchdDomain(),
        nodeServiceDefinitionPath(platform, label),
      ]);
    }
    await run("launchctl", ["kickstart", target]);
  } else {
    await run("systemctl", ["--user", "start", systemdUnitName(label)]);
  }
}

/** Stops the node until the next `start`, login, or boot. */
export async function stopNodeService(platform: NodeServicePlatform, label: string) {
  if (platform === "launchd") {
    await run("launchctl", ["bootout", `${launchdDomain()}/${label}`], { allowFailure: true });
  } else {
    await run("systemctl", ["--user", "stop", systemdUnitName(label)]);
  }
}

export async function restartNodeService(platform: NodeServicePlatform, label: string) {
  if (platform === "launchd") {
    await run("launchctl", ["kickstart", "-k", `${launchdDomain()}/${label}`]);
  } else {
    await run("systemctl", ["--user", "restart", systemdUnitName(label)]);
  }
}

export function parseLaunchctlPrint(output: string): {
  readonly running: boolean;
  readonly pid: number | null;
} {
  const state = /^\s*state = (\S+)/mu.exec(output)?.[1];
  const pid = /^\s*pid = (\d+)/mu.exec(output)?.[1];
  return { running: state === "running", pid: pid === undefined ? null : Number(pid) };
}

export function parseSystemctlShow(output: string): {
  readonly loaded: boolean;
  readonly running: boolean;
  readonly pid: number | null;
} {
  const values = new Map(
    output
      .split("\n")
      .map((line) => line.split("=", 2) as [string, string | undefined])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
  const pid = Number(values.get("MainPID") ?? "0");
  return {
    loaded: values.get("LoadState") === "loaded",
    running: values.get("ActiveState") === "active",
    pid: Number.isSafeInteger(pid) && pid > 0 ? pid : null,
  };
}

export async function readNodeServiceStatus(
  platform: NodeServicePlatform,
  label: string,
): Promise<NodeServiceStatus> {
  const definitionPath = nodeServiceDefinitionPath(platform, label);
  const installed = await readFile(definitionPath).then(
    () => true,
    () => false,
  );
  if (platform === "launchd") {
    const printed = await run("launchctl", ["print", `${launchdDomain()}/${label}`], {
      allowFailure: true,
    });
    const loaded = printed.code === 0;
    const { running, pid } = loaded
      ? parseLaunchctlPrint(printed.stdout)
      : { running: false, pid: null };
    return { platform, label, definitionPath, installed, loaded, running, pid, lingering: null };
  }
  const shown = await run(
    "systemctl",
    [
      "--user",
      "show",
      systemdUnitName(label),
      "-p",
      "LoadState",
      "-p",
      "ActiveState",
      "-p",
      "MainPID",
    ],
    { allowFailure: true },
  );
  const parsed = parseSystemctlShow(shown.stdout);
  const user = process.env.USER ?? process.env.LOGNAME ?? "";
  const linger = user
    ? await run("loginctl", ["show-user", user, "-p", "Linger"], { allowFailure: true })
    : undefined;
  return {
    platform,
    label,
    definitionPath,
    installed,
    loaded: parsed.loaded,
    running: parsed.running,
    pid: parsed.pid,
    lingering: linger?.code === 0 ? /Linger=yes/u.test(linger.stdout) : null,
  };
}
