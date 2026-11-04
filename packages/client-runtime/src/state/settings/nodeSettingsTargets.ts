/**
 * The nodes a client may write settings to, and the write itself: each node gets its own
 * patch through its own connection, re-checked just before it is sent, and the result names
 * every node left out and why. Used by shared device settings (`sharedDeviceSettings*`).
 *
 * Kept off the `state/settings` index, which the app shell imports.
 */
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";

/** What a client knows of a node's config: its capabilities and its settings. */
export type NodeSettingsConfig = Pick<ServerConfig, "environment" | "settings">;

/** Why a node cannot take a settings write now. */
export type NodeSettingsBlocker = "disconnected" | "unsupported" | "read-only";

/** A node a settings write may go to, writable now or with what stops it. */
export interface NodeSettingsTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** The node's own last known config; null while none is known. */
  readonly config: NodeSettingsConfig | null;
  readonly connected: boolean;
  /**
   * This client may change the node's settings now (its owner, or a hosted grant of the node's
   * current session). A snapshot taken when the target was read: read the target again right
   * before a write that is not immediate.
   */
  readonly canWrite: boolean;
  /** Writes through the node's own connection; the node checks access and CAS itself. */
  readonly write: (patch: ServerSettingsPatch) => Promise<unknown>;
}

/**
 * Why a write cannot go to a node now: not connected (or no config yet), a node that does not
 * know the setting (`supported`, from the node's own config), or a client that may not change
 * it. Null when it can.
 */
export function nodeSettingsBlocker(
  target: Pick<NodeSettingsTarget, "config" | "connected" | "canWrite">,
  supported?: (config: NodeSettingsConfig) => boolean,
): NodeSettingsBlocker | null {
  if (!target.connected || target.config == null) return "disconnected";
  if (supported !== undefined && !supported(target.config)) return "unsupported";
  return target.canWrite ? null : "read-only";
}

export interface NodeSettingsNotApplied {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reason: NodeSettingsBlocker | "failed";
  /** The node's own message, for a failed write. */
  readonly detail?: string;
}

export interface NodeSettingsApplyResult {
  readonly applied: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly notApplied: ReadonlyArray<NodeSettingsNotApplied>;
}

/** The message a failed write carries, for "could not apply". */
export function nodeSettingsWriteFailureDetail(error: unknown): string | undefined {
  if (error instanceof Error) return error.message;
  if (typeof error === "object" && error !== null && "message" in error) {
    const message = (error as { readonly message: unknown }).message;
    if (typeof message === "string") return message;
  }
  return undefined;
}

/**
 * Writes each target its own patch (`patchFor`; null leaves the target out silently), in
 * parallel, and reports the targets it could not: blocked ones ({@link nodeSettingsBlocker})
 * and failed writes, with the node's own message.
 */
export async function writeNodeSettingsPatches(
  targets: ReadonlyArray<NodeSettingsTarget>,
  patchFor: (target: NodeSettingsTarget, config: NodeSettingsConfig) => ServerSettingsPatch | null,
  options?: { readonly supported?: (config: NodeSettingsConfig) => boolean },
): Promise<NodeSettingsApplyResult> {
  const outcomes = await Promise.all(
    targets.map(async (target) => {
      const node = { environmentId: target.environmentId, label: target.label };
      const blocker = nodeSettingsBlocker(target, options?.supported);
      const config = target.config;
      if (blocker !== null || config === null) {
        return { ok: false as const, entry: { ...node, reason: blocker ?? "disconnected" } };
      }
      const patch = patchFor(target, config);
      if (patch === null) return null;
      try {
        await target.write(patch);
        return { ok: true as const, entry: node };
      } catch (error) {
        const detail = nodeSettingsWriteFailureDetail(error);
        return {
          ok: false as const,
          entry: {
            ...node,
            reason: "failed" as const,
            ...(detail === undefined ? {} : { detail }),
          },
        };
      }
    }),
  );
  return {
    applied: outcomes.flatMap((outcome) => (outcome?.ok === true ? [outcome.entry] : [])),
    notApplied: outcomes.flatMap((outcome) =>
      outcome !== null && !outcome.ok ? [outcome.entry] : [],
    ),
  };
}
