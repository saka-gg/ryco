/**
 * A digest of what a Codex process of a provider instance runs with: the instance, its binary, its
 * store and its whole environment. Two digests differ when a setting that decides which account
 * that process acts for changed in between. A reset credit is redeemed, and a sign-in reports
 * success, only while the digest still matches the one the action started with.
 *
 * @module codexRuntimeBinding
 */
import { createHash } from "node:crypto";

export interface CodexRuntimeBindingInput {
  readonly instanceId: string;
  readonly binaryPath: string;
  readonly homePath: string;
  readonly environment: NodeJS.ProcessEnv;
}

export const codexRuntimeBinding = (input: CodexRuntimeBindingInput): string =>
  createHash("sha256")
    .update(
      JSON.stringify([
        input.instanceId,
        input.binaryPath,
        input.homePath,
        Object.entries(input.environment).toSorted(([a], [b]) => a.localeCompare(b)),
      ]),
    )
    .digest("hex");
