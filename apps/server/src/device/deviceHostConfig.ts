import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Schema } from "effect";
import { DeviceBackendError } from "./DeviceBackend.ts";

/** Node-owner managed configuration. Never accepted from a browser or agent tool. */
export const SshDeviceHostConfig = Schema.Struct({
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(128)),
  target: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_][A-Za-z0-9_.@:-]{0,255}$/)),
  port: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65535 }))),
  identityFile: Schema.optional(Schema.String.check(Schema.isPattern(/^\/[^\0\r\n]{1,1023}$/))),
  /** Absolute executable path on the Mac; no shell command strings. */
  executable: Schema.String.check(Schema.isPattern(/^\/[^\0\r\n]{1,1023}$/)),
});
export type SshDeviceHostConfig = typeof SshDeviceHostConfig.Type;
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
      Schema.Array(SshDeviceHostConfig).check(Schema.isMaxLength(16)),
    )(JSON.parse(text));
    if (new Set(hosts.map(sshDeviceHostId)).size !== hosts.length) throw new Error("duplicate");
    return hosts;
  } catch {
    throw new DeviceBackendError(
      "Invalid RYCO_DEVICE_HOSTS_FILE: expected up to 16 unique SSH device hosts with name, target and absolute executable path.",
    );
  }
}
