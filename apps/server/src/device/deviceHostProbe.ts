/**
 * Test connection for an SSH device host: can this node reach the Mac with
 * its SSH settings, and does the Mac run the same Ryco version?
 *
 * It runs `ryco --version` there with the device host's own SSH options
 * (batch authentication, strict host keys, no forwarding) and nothing else:
 * no worker starts, so the Mac's ownership lock is untouched, and nothing is
 * installed. Loaded on first use.
 *
 * @module device/deviceHostProbe
 */
import { spawn } from "node:child_process";
import { SSH_COMMAND } from "@ryco/ssh/command";
import type { DeviceHostProbeInput, DeviceHostProbeResult } from "@ryco/contracts";

import packageJson from "../../package.json" with { type: "json" };
import { deviceHostSshArgs } from "./SshDeviceBackend.ts";

const PROBE_TIMEOUT_MS = 20_000;
const OUTPUT_LIMIT = 16 * 1024;

export interface ProbeRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
}

export type RunProbe = (command: string, args: readonly string[]) => Promise<ProbeRun>;

const runProbe: RunProbe = (command, args) =>
  new Promise((resolve) => {
    const child = spawn(command, [...args], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, PROBE_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdout.length < OUTPUT_LIMIT) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderr.length < OUTPUT_LIMIT) stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr || error.message, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr, timedOut });
    });
  });

/** The last meaningful stderr line, without control characters, for the message. */
function lastLine(text: string): string | null {
  const line = text
    .split(/\r?\n/u)
    .map((entry) =>
      [...entry]
        .filter((char) => char.charCodeAt(0) >= 0x20 && char.charCodeAt(0) !== 0x7f)
        .join("")
        .trim(),
    )
    .findLast((entry) => entry.length > 0);
  return line ? line.slice(0, 400) : null;
}

/** The version `ryco --version` prints (`ryco v0.1.37`), if any. */
export function parseRycoVersion(stdout: string): string | null {
  return /\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\b/u.exec(stdout)?.[1] ?? null;
}

export async function probeDeviceHost(
  input: DeviceHostProbeInput,
  options: { readonly run?: RunProbe; readonly now?: () => number } = {},
): Promise<DeviceHostProbeResult> {
  const now = options.now ?? Date.now;
  const started = now();
  const localVersion = packageJson.version;
  const result = await (options.run ?? runProbe)(
    SSH_COMMAND,
    deviceHostSshArgs(input, "--version"),
  );
  const elapsedMs = Math.max(0, Math.round(now() - started));
  const base = { localVersion, elapsedMs };
  if (result.timedOut) {
    return {
      ...base,
      stage: "ssh",
      message: `No answer from ${input.target} within ${PROBE_TIMEOUT_MS / 1000} seconds. Check the host name, network and port.`,
    };
  }
  // ssh exits 255 for its own failures: resolve, connect, host key or authentication.
  if (result.code === null || result.code === 255) {
    const reason = lastLine(result.stderr);
    return {
      ...base,
      stage: "ssh",
      message: `SSH could not connect to ${input.target}${reason ? `: ${reason.replace(/[.!]?$/u, ".")}` : "."} Ryco uses batch authentication and strict host keys: trust the host key and set up key access with your SSH client first.`,
    };
  }
  if (result.code === 126 || result.code === 127) {
    return {
      ...base,
      stage: "executable",
      message: `SSH works, but ${input.executable} is missing or not executable on the Mac. Install Ryco ${localVersion} there and give its absolute path.`,
    };
  }
  const remoteVersion = parseRycoVersion(result.stdout);
  if (result.code !== 0 || remoteVersion === null) {
    const reason = lastLine(result.stderr) ?? lastLine(result.stdout);
    return {
      ...base,
      stage: "executable",
      message: `SSH works, but ${input.executable} did not report a Ryco version${reason ? `: ${reason}` : "."} Its Node runtime must be found in a non-interactive SSH session.`,
    };
  }
  if (remoteVersion !== localVersion) {
    return {
      ...base,
      remoteVersion,
      stage: "version",
      message: `The Mac runs Ryco ${remoteVersion}; this node runs ${localVersion}. Install the same version on both.`,
    };
  }
  return {
    ...base,
    remoteVersion,
    stage: "ok",
    message: `Connected to ${input.target}; it runs Ryco ${remoteVersion}, like this node.`,
  };
}
