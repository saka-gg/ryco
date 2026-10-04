/**
 * What `ryco setup` detects about this machine before asking anything: coding
 * agents on PATH, Tailscale, a friendly name for the node, and whether the OS
 * can hold its Hub key.
 */
import { access, constants } from "node:fs/promises";
import path from "node:path";

import { readTailscaleStatus } from "@ryco/tailscale";
import { Effect } from "effect";

import { resolveServerEnvironmentLabel } from "../environment/Layers/ServerEnvironmentLabel.ts";
import {
  NODE_IDENTITY_SECRET_SERVICE,
  probeOsProtectedSecretStore,
} from "../hubIdentity/ProtectedSecretStore.ts";

/** Provider CLIs Ryco drives, by the binary name each provider looks for by default. */
export const PROVIDER_BINARIES: ReadonlyArray<{ readonly name: string; readonly binary: string }> =
  [
    { name: "Claude", binary: "claude" },
    { name: "Codex", binary: "codex" },
    { name: "Cursor", binary: "agent" },
    { name: "GitHub Copilot", binary: "copilot" },
    { name: "OpenCode", binary: "opencode" },
    { name: "Grok", binary: "grok" },
  ];

async function isExecutableOnPath(binary: string, searchPath: string): Promise<boolean> {
  for (const directory of searchPath.split(path.delimiter)) {
    if (!directory) continue;
    try {
      await access(path.join(directory, binary), constants.X_OK);
      return true;
    } catch {
      // Not here; keep looking.
    }
  }
  return false;
}

export async function detectProviders(
  searchPath: string = process.env.PATH ?? "",
): Promise<ReadonlyArray<string>> {
  const found = await Promise.all(
    PROVIDER_BINARIES.map(async (provider) =>
      (await isExecutableOnPath(provider.binary, searchPath)) ? provider.name : null,
    ),
  );
  return found.filter((name): name is string => name !== null);
}

export interface TailscaleState {
  /** `null` when Tailscale is not installed, not running, or not logged in. */
  readonly magicDnsName: string | null;
  readonly tailnetIpv4: string | null;
}

export const detectTailscale = readTailscaleStatus.pipe(
  Effect.map((status): TailscaleState => ({
    magicDnsName: status.magicDnsName,
    tailnetIpv4: status.tailnetIpv4Addresses[0] ?? null,
  })),
  Effect.orElseSucceed((): TailscaleState => ({ magicDnsName: null, tailnetIpv4: null })),
);

export const detectMachineName = resolveServerEnvironmentLabel({ cwdBaseName: "" });

/**
 * Whether this Linux machine has no usable credential store for the Hub key.
 *
 * Headless Linux often has the keyring library but no Secret Service to answer
 * it, which only shows up as a failed read. macOS and Windows always ship a
 * store, and probing the macOS Keychain can raise a prompt, so only Linux is
 * probed. A `true` here lets setup ask about the file fallback; it never turns
 * the fallback on by itself.
 */
export async function detectMissingOsKeyStore(
  input: {
    readonly platform?: NodeJS.Platform;
    readonly probe?: () => Promise<boolean>;
  } = {},
): Promise<boolean> {
  if ((input.platform ?? process.platform) !== "linux") return false;
  const probe =
    input.probe ?? (() => probeOsProtectedSecretStore({ service: NODE_IDENTITY_SECRET_SERVICE }));
  return !(await probe());
}
