import * as path from "node:path";
import type { Plugin } from "vite";

/**
 * Compile-time client-mode seams.
 *
 * `VITE_RYCO_CLIENT_MODE` is a build-time constant, but hosted-hub code is
 * reached through ordinary static imports from shared modules (the sidebar, the
 * runtime service, route views), and several hosted modules build stores at
 * module scope, so a runtime `isHostedHubMode()` branch cannot remove any of it.
 * A seam module is a hosted module that shared code imports directly; standard
 * builds resolve it to its `*.standard.ts(x)` sibling, an inert implementation
 * with the same runtime exports that reports the signed-out, never-hosted state
 * a standard build always has. That keeps the hosted runtime, the Hub API
 * client, and the relay E2EE stack (noble curves, cborg, the handshake) out of
 * every standard and desktop bundle without forking a single call site.
 *
 * Rules for a seam:
 * - it lists only modules shared code imports; hosted-only surfaces reach the
 *   rest of the hosted graph through these;
 * - its sibling mirrors every runtime export (`clientModeSeams.test.ts` pins the
 *   list and the observable standard-mode values to the real module);
 * - hosted-only entry points throw `HostedOnlyEntryPointError`, so a missing
 *   `isHostedHubMode()` guard fails in the dev server instead of being masked.
 *
 * Vitest never applies the seams: suites switch client mode at runtime and
 * exercise the real modules.
 */
export const CLIENT_MODE_SEAM_MODULES = [
  "hostedHub/state.ts",
  "hostedHub/bootGate.ts",
  "hostedHub/transport.ts",
  "hostedHub/hostedConnectionCoordinator.ts",
  "components/hostedHub/HostedConnectionControls.tsx",
  "components/NoActiveThreadHostedStatus.tsx",
  "pwa/lifecycle.ts",
] as const;

export type ClientMode = "hosted-hub" | "standard";

export function standardSeamSibling(modulePath: string): string {
  return modulePath.replace(/\.(tsx?)$/, ".standard.$1");
}

function normalizeId(id: string): string {
  return id.split("?", 1)[0]!.replaceAll("\\", "/");
}

export function shouldApplyClientModeSeams(input: {
  readonly clientMode: ClientMode;
  readonly mode: string;
  readonly vitest: boolean;
}): boolean {
  return input.clientMode === "standard" && input.mode !== "test" && !input.vitest;
}

export function createClientModeSeamPlugin(input: {
  readonly clientMode: ClientMode;
  /** Absolute path of `apps/web/src`. */
  readonly srcRoot: string;
}): Plugin {
  const siblings = new Map(
    CLIENT_MODE_SEAM_MODULES.map((modulePath) => [
      normalizeId(path.join(input.srcRoot, modulePath)),
      normalizeId(path.join(input.srcRoot, standardSeamSibling(modulePath))),
    ]),
  );
  const basenames = [
    ...new Set(CLIENT_MODE_SEAM_MODULES.map((modulePath) => path.parse(modulePath).name)),
  ];
  // Only specifiers that could name a seam module pay for a nested resolve.
  const specifier = new RegExp(`(?:^|[\\\\/])(?:${basenames.join("|")})(?:\\.tsx?)?$`);

  return {
    name: "ryco:client-mode-seams",
    enforce: "pre",
    apply: (_config, env) =>
      shouldApplyClientModeSeams({
        clientMode: input.clientMode,
        mode: env.mode,
        vitest: process.env.VITEST !== undefined,
      }),
    resolveId: {
      filter: { id: specifier },
      async handler(source, importer, options) {
        if (!importer) return null;
        const resolved = await this.resolve(source, importer, { ...options, skipSelf: true });
        if (!resolved || resolved.external) return null;
        const sibling = siblings.get(normalizeId(resolved.id));
        // A sibling may still name its own hosted module in a type position.
        if (!sibling || sibling === normalizeId(importer)) return null;
        return sibling;
      },
    },
  };
}
