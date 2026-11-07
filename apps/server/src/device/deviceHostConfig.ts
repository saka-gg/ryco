import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { DEVICE_SSH_HOST_LIMIT, DeviceSshHost } from "@ryco/contracts";
import { Schema } from "effect";
import { DeviceBackendError } from "./DeviceBackend.ts";

/**
 * Node-owner managed configuration: the node's settings (owner-only) or the
 * RYCO_DEVICE_HOSTS_FILE. Never accepted from an agent tool.
 */
export const SshDeviceHostConfig = DeviceSshHost;
export type SshDeviceHostConfig = DeviceSshHost;
export function sshDeviceHostId(config: SshDeviceHostConfig): string {
  return createHash("sha256")
    .update(
      JSON.stringify([
        config.target,
        config.port ?? null,
        config.identityFile ?? null,
        config.executable,
      ]),
    )
    .digest("hex")
    .slice(0, 24);
}
export async function readDeviceHostConfig(
  filePath: string | undefined,
): Promise<readonly SshDeviceHostConfig[]> {
  if (!filePath) return [];
  try {
    const text = await readFile(filePath, "utf8");
    if (text.length > 64 * 1024) throw new Error("oversized");
    const hosts = Schema.decodeUnknownSync(
      Schema.Array(SshDeviceHostConfig).check(Schema.isMaxLength(DEVICE_SSH_HOST_LIMIT)),
    )(JSON.parse(text));
    if (new Set(hosts.map(sshDeviceHostId)).size !== hosts.length) throw new Error("duplicate");
    return hosts;
  } catch {
    throw new DeviceBackendError(
      "Invalid RYCO_DEVICE_HOSTS_FILE: expected up to 16 unique SSH device hosts with name, target and absolute executable path.",
    );
  }
}
