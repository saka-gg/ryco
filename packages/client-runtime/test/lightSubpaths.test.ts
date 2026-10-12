import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseSync } from "vite-plus";
import { describe, expect, it } from "vite-plus/test";

/**
 * Subpaths that boot paths import instead of the `relay` barrel, plus the
 * `authorization` barrel itself, whose E2EE half lives behind
 * `./authorization/e2ee`. They must stay free of the relay E2EE primitives, or
 * importing one puts the curves, hashes, and CBOR codec back on every client's
 * boot path (Metro does not tree-shake a barrel).
 */
const LIGHT_SUBPATHS = [
  "./authorization",
  "./authorization/capabilities",
  "./authorization/deliveryNotice",
  "./authorization/hostedStores",
  "./authorization/nodeMutationLease",
  "./relay/base64url",
  "./relay/dispatchReplay",
  "./relay/dpop",
  "./relay/ecdsa",
  "./relay/reconnectPolicy",
  "./relay/webauthn",
] as const;

const HEAVY = [/^@noble\//u, /^cborg$/u, /^@ryco\/shared\/relay(?:E2ee(?!Ids$|Constants$)|Codec)/u];

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
  readonly exports: Record<string, { readonly import: string }>;
};

/** Value imports reachable inside this package, plus the external ones it names. */
function reachableImports(entry: string): ReadonlyArray<string> {
  const seen = new Set<string>();
  const external = new Set<string>();
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    const { module } = parseSync(file, readFileSync(file, "utf8"));
    const specifiers = [
      ...module.staticImports
        .filter(
          (declaration) =>
            declaration.entries.length === 0 || !declaration.entries.every((entry) => entry.isType),
        )
        .map((declaration) => declaration.moduleRequest.value),
      ...module.staticExports.flatMap((declaration) =>
        declaration.entries
          .filter((entry) => entry.moduleRequest && !entry.isType)
          .map((entry) => entry.moduleRequest!.value),
      ),
    ];
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".")) {
        external.add(specifier);
        continue;
      }
      const resolved = path.resolve(path.dirname(file), specifier);
      if (existsSync(resolved)) queue.push(resolved);
    }
  }
  return [...external];
}

function heavyImportsOf(subpath: string): ReadonlyArray<string> {
  const target = manifest.exports[subpath]?.import;
  expect(target, `${subpath} is exported`).toBeDefined();
  return reachableImports(path.join(packageRoot, target!)).filter((specifier) =>
    HEAVY.some((pattern) => pattern.test(specifier)),
  );
}

describe("light client-runtime subpaths", () => {
  it.each(LIGHT_SUBPATHS)("%s does not import the relay E2EE primitives", (subpath) => {
    expect(heavyImportsOf(subpath)).toEqual([]);
  });

  it("keeps the relay barrel free of the E2EE stack", () => {
    // The barrel carries the relay engine and its CBOR codec, but the E2EE
    // initiator, channel, and their curves/ciphers live behind ./relay/e2ee:
    // Metro does not tree-shake, so a re-export would load them for every
    // native client that imports a relay helper.
    const target = manifest.exports["./relay"]?.import;
    expect(target).toBeDefined();
    const e2ee = reachableImports(path.join(packageRoot, target!)).filter((specifier) =>
      [/^@noble\//u, /^@ryco\/shared\/relayE2ee(?!Ids$|Constants$)/u].some((pattern) =>
        pattern.test(specifier),
      ),
    );
    expect(e2ee).toEqual([]);
  });

  it("detects the primitives behind the E2EE entries the light subpaths replace", () => {
    // Without this, a walker that silently stopped following imports would
    // pass every light subpath above.
    for (const subpath of ["./relay/e2ee", "./authorization/e2ee"]) {
      expect(heavyImportsOf(subpath), subpath).not.toEqual([]);
    }
  });
});
