import { spawnSync } from "node:child_process";

/** Select only an unambiguous, existing development identity; never create or export keys. */
export function selectLocalMacSigningIdentity(output: string): string | undefined {
  const identities = Array.from(
    output.matchAll(/\b([A-Fa-f0-9]{40})\s+"(Apple Development:[^"]+)"/g),
    (match) => ({ hash: match[1]!, name: match[2]! }),
  );
  // Xcode may renew a certificate while the previous one is still valid. Both
  // certificates for the same developer/team satisfy the same Apple DR.
  // Different developer identities remain ambiguous and are never guessed.
  if (new Set(identities.map((identity) => identity.name)).size !== 1) return undefined;
  return identities.map((identity) => identity.hash).sort()[0];
}

export function findLocalMacSigningIdentity(): string | undefined {
  if (process.platform !== "darwin" || process.env.CI) return undefined;
  const result = spawnSync("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"], {
    encoding: "utf8",
    timeout: 5_000,
  });
  return result.status === 0 ? selectLocalMacSigningIdentity(result.stdout) : undefined;
}
