/**
 * One node setting written to every node a client knows, as a bulk edit: each node gets its
 * own write through its own connection, and the result names every node it left out and why.
 * Nothing keeps the nodes in sync afterwards; an offline node keeps its value. Whether the
 * nodes agree on a value now is read from each node's own last known config.
 *
 * Kept off the `state/settings` index, which the app shell imports: only settings surfaces use
 * this.
 */
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import type { ServerSettingsPatch } from "@ryco/contracts/settings";
import * as Equal from "effect/Equal";

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
  /** This client may change the node's settings now (its owner, or a hosted grant). */
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

/**
 * The write each node gets: one patch for every node, or one built from each node's own config.
 * A patch with compare-and-set values must be a function, so every node compares its own
 * current value; another node's expected value would refuse a write it should take, or pass a
 * guard it should fail.
 */
export type NodeSettingsPatch =
  | ServerSettingsPatch
  | ((config: NodeSettingsConfig) => ServerSettingsPatch);

/**
 * Writes a patch to every node it can reach, in parallel, and reports the nodes it could not:
 * blocked ones ({@link nodeSettingsBlocker}) and failed writes, with the node's own message.
 */
export async function applyNodeSettingsPatch(
  targets: ReadonlyArray<NodeSettingsTarget>,
  patch: NodeSettingsPatch,
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
      try {
        await target.write(typeof patch === "function" ? patch(config) : patch);
        return { ok: true as const, entry: node };
      } catch (error) {
        return {
          ok: false as const,
          entry: {
            ...node,
            reason: "failed" as const,
            ...(error instanceof Error ? { detail: error.message } : {}),
          },
        };
      }
    }),
  );
  return {
    applied: outcomes.flatMap((outcome) => (outcome.ok ? [outcome.entry] : [])),
    notApplied: outcomes.flatMap((outcome) => (outcome.ok ? [] : [outcome.entry])),
  };
}

const NOT_APPLIED_REASON: Record<NodeSettingsNotApplied["reason"], string> = {
  disconnected: "not connected",
  unsupported: "needs an update",
  "read-only": "only its owner can change it",
  failed: "could not save",
};

/** One line on what a write to every node did, naming every node it left out. */
export function describeNodeSettingsApplyResult(result: NodeSettingsApplyResult): string {
  const applied =
    result.applied.length === 0
      ? "No node was changed."
      : `Applied to ${result.applied.map((node) => node.label).join(", ")}.`;
  if (result.notApplied.length === 0) return applied;
  const left = result.notApplied
    .map((node) => `${node.label} (${node.detail ?? NOT_APPLIED_REASON[node.reason]})`)
    .join(", ");
  return `${applied} Not changed: ${left}.`;
}

/** Whether the nodes a client knows agree on a setting, and each node's value when not. */
export type NodeSettingsAgreement<T> =
  | { readonly kind: "none" }
  | { readonly kind: "same"; readonly value: T }
  | {
      readonly kind: "mixed";
      readonly values: ReadonlyArray<{ readonly label: string; readonly value: T }>;
    };

/**
 * Compares one setting across nodes (structurally, with `Equal.equals`, as the node's own
 * compare-and-set does). Only connected nodes with a config, and that know the setting
 * (`supported`), count: a node this client cannot see now never makes a value mixed.
 */
export function readNodeSettingsAgreement<T>(
  nodes: ReadonlyArray<Pick<NodeSettingsTarget, "label" | "config" | "connected">>,
  select: (settings: NodeSettingsConfig["settings"]) => T,
  options?: { readonly supported?: (config: NodeSettingsConfig) => boolean },
): NodeSettingsAgreement<T> {
  const values = nodes.flatMap((node) =>
    node.connected &&
    node.config != null &&
    (options?.supported === undefined || options.supported(node.config))
      ? [{ label: node.label, value: select(node.config.settings) }]
      : [],
  );
  const first = values[0];
  if (first === undefined) return { kind: "none" };
  return values.every((entry) => Equal.equals(entry.value, first.value))
    ? { kind: "same", value: first.value }
    : { kind: "mixed", values };
}
