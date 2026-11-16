/**
 * The `initialize` params every Ryco-spawned `codex app-server` sends.
 *
 * Kept in a leaf module (type-only schema import) so the lazy reset-credit and app-server chunks
 * can share it without importing the whole Codex provider.
 *
 * @module codexInitializeParams
 */
import type * as CodexSchema from "effect-codex-app-server/schema";
import packageJson from "../../package.json" with { type: "json" };
import { RYCO_CODEX_CLIENT_NAME } from "./codexClientName.ts";

export function buildCodexInitializeParams(): CodexSchema.V1InitializeParams {
  return {
    clientInfo: {
      name: RYCO_CODEX_CLIENT_NAME,
      title: "Ryco Desktop",
      version: packageJson.version,
    },
    capabilities: {
      experimentalApi: true,
    },
  };
}
