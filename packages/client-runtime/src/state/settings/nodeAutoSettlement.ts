import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import {
  DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  type ServerSettingsPatch,
  type SidebarAutoSettleAfterDays,
} from "@ryco/contracts/settings";
import { resolveAutoSettleAfterDays } from "@ryco/shared/threadSettlement";

type NodeConfig = Pick<ServerConfig, "environment" | "settings">;

/**
 * Whether the node keeps the automatic settlement rule itself, so every
 * client lists its threads alike. An older node leaves it to each client.
 */
export function nodeOwnsAutoSettleRule(config: NodeConfig | null | undefined): boolean {
  return config?.environment?.capabilities?.nodeAutoSettlement === true;
}

/** The node's rule (the shared default until set), or undefined when it keeps none. */
export function readNodeAutoSettleRule(
  config: NodeConfig | null | undefined,
): SidebarAutoSettleAfterDays | undefined {
  return config && nodeOwnsAutoSettleRule(config)
    ? resolveAutoSettleAfterDays(config.settings?.threadAutoSettleAfterDays)
    : undefined;
}

/** Whether the node keeps the rule but has never had one set (it applies the shared default). */
export function nodeAwaitsAutoSettleRule(config: NodeConfig | null | undefined): boolean {
  return (
    nodeOwnsAutoSettleRule(config) && config?.settings?.threadAutoSettleAfterDays === undefined
  );
}

/** The settings patch that sets a node's rule. */
export function nodeAutoSettleRulePatch(value: SidebarAutoSettleAfterDays): ServerSettingsPatch {
  return { threadAutoSettleAfterDays: value };
}

export interface AutoSettleRuleHandOverInput {
  readonly config: NodeConfig | null | undefined;
  /** This client's own rule, from before nodes kept one. */
  readonly clientValue: SidebarAutoSettleAfterDays;
  readonly role: "viewer" | "operator" | "owner" | "client" | null | undefined;
  readonly mutationReady: boolean;
}

/**
 * Whether this client hands its own rule to a node, once: only a node that
 * keeps the rule but has never had one set, only from its owner on a
 * mutation-ready connection, and only when the client's rule is not the
 * shared default the node already applies. A node with a value keeps it.
 */
export function shouldHandOverAutoSettleRule(input: AutoSettleRuleHandOverInput): boolean {
  return (
    input.role === "owner" &&
    input.mutationReady &&
    nodeAwaitsAutoSettleRule(input.config) &&
    input.clientValue !== DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS
  );
}

/**
 * The patch that hands a client's rule to a node. It applies only while the
 * node still has no rule, so when two clients hand theirs over at once the
 * first one's stands and the second is refused.
 */
export function autoSettleRuleHandOverPatch(
  clientValue: SidebarAutoSettleAfterDays,
): ServerSettingsPatch {
  return { ...nodeAutoSettleRulePatch(clientValue), expectedThreadAutoSettleAfterDays: "absent" };
}

export interface AutoSettleRuleHandOverCandidate extends Omit<
  AutoSettleRuleHandOverInput,
  "clientValue"
> {
  readonly environmentId: EnvironmentId;
}

/**
 * Hands a client's rule to each node that needs it, once while the node stays
 * ready: after a hand-over starts, the node is not written again until a run
 * sees it not ready (no config, not mutation-ready, not owned). A write that
 * keeps failing, such as one from a session that may not change settings, is
 * therefore not repeated on every run; a reconnect or an account change passes
 * through not ready and arms it again. A refused write means another client
 * was first, which the node's next settings push shows.
 */
export function createAutoSettleRuleHandOver(
  write: (environmentId: EnvironmentId, patch: ServerSettingsPatch) => Promise<unknown>,
) {
  const handedOver = new Set<EnvironmentId>();
  return {
    run(
      candidates: ReadonlyArray<AutoSettleRuleHandOverCandidate>,
      clientValue: SidebarAutoSettleAfterDays,
    ): ReadonlyArray<EnvironmentId> {
      const started: EnvironmentId[] = [];
      for (const candidate of candidates) {
        const ready =
          candidate.role === "owner" && candidate.mutationReady && candidate.config != null;
        if (!ready) {
          handedOver.delete(candidate.environmentId);
          continue;
        }
        if (handedOver.has(candidate.environmentId)) continue;
        if (!shouldHandOverAutoSettleRule({ ...candidate, clientValue })) continue;
        handedOver.add(candidate.environmentId);
        started.push(candidate.environmentId);
        void write(candidate.environmentId, autoSettleRuleHandOverPatch(clientValue)).then(
          undefined,
          () => undefined,
        );
      }
      return started;
    },
  };
}

/** An environment as a client's list shows it, for the hand-over. */
export interface AutoSettleRuleHandOverListing {
  readonly environmentId: EnvironmentId;
  readonly mutationReady: boolean;
  /** This client's role on it, when the list knows it. */
  readonly role?: AutoSettleRuleHandOverInput["role"];
}

/**
 * What a client's hand-over runs depend on among its listed environments, as
 * a string that stays equal while it does (which are listed, ready, and with
 * which role), so a list rebuilt for thread updates does not run it again.
 * Null while the client keeps the shared default, which it never hands over.
 */
export function autoSettleRuleHandOverKey(
  environments: ReadonlyArray<AutoSettleRuleHandOverListing>,
  clientValue: SidebarAutoSettleAfterDays,
): string | null {
  if (clientValue === DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS) return null;
  return JSON.stringify(
    environments.map((environment) => [
      environment.environmentId,
      environment.mutationReady,
      environment.role ?? null,
    ]),
  );
}

/** The listing an {@link autoSettleRuleHandOverKey} stands for. */
export function readAutoSettleRuleHandOverKey(
  key: string,
): ReadonlyArray<AutoSettleRuleHandOverListing> {
  const listed = JSON.parse(key) as ReadonlyArray<
    readonly [EnvironmentId, boolean, AutoSettleRuleHandOverInput["role"]]
  >;
  return listed.map(([environmentId, mutationReady, role]) => ({
    environmentId,
    mutationReady,
    role,
  }));
}

export type AutoSettleRuleTargetBlocker = "unsupported" | "disconnected" | "read-only";

export interface AutoSettleRuleTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  /** Why the rule cannot be written to this node now, or null when it can. */
  readonly blocker: AutoSettleRuleTargetBlocker | null;
  readonly write: (patch: ServerSettingsPatch) => Promise<unknown>;
}

/**
 * Why a rule cannot be written to a node now: not connected (or no config yet),
 * an older node that keeps no rule, or a client that may not change it.
 */
export function autoSettleRuleTargetBlocker(input: {
  readonly connected: boolean;
  readonly config: NodeConfig | null | undefined;
  readonly canWrite: boolean;
}): AutoSettleRuleTargetBlocker | null {
  if (!input.connected || input.config == null) return "disconnected";
  if (!nodeOwnsAutoSettleRule(input.config)) return "unsupported";
  return input.canWrite ? null : "read-only";
}

export interface AutoSettleRuleNotApplied {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly reason: AutoSettleRuleTargetBlocker | "failed";
  readonly detail?: string;
}

export interface AutoSettleRuleApplyResult {
  readonly applied: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly label: string;
  }>;
  readonly notApplied: ReadonlyArray<AutoSettleRuleNotApplied>;
}

/**
 * Writes one rule to every node it can reach, in parallel, and reports the
 * nodes it could not: blocked ones (an older node, one not connected, one
 * this client may not change) and failed writes.
 */
export async function applyAutoSettleRuleToNodes(
  value: SidebarAutoSettleAfterDays,
  targets: ReadonlyArray<AutoSettleRuleTarget>,
): Promise<AutoSettleRuleApplyResult> {
  const patch = nodeAutoSettleRulePatch(value);
  const outcomes = await Promise.all(
    targets.map(async (target) => {
      if (target.blocker !== null) {
        return {
          ok: false as const,
          entry: {
            environmentId: target.environmentId,
            label: target.label,
            reason: target.blocker,
          },
        };
      }
      try {
        await target.write(patch);
        return {
          ok: true as const,
          entry: { environmentId: target.environmentId, label: target.label },
        };
      } catch (error) {
        return {
          ok: false as const,
          entry: {
            environmentId: target.environmentId,
            label: target.label,
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

const NOT_APPLIED_REASON: Record<AutoSettleRuleNotApplied["reason"], string> = {
  disconnected: "not connected",
  unsupported: "needs an update",
  "read-only": "only its owner can change it",
  failed: "could not save",
};

/** One line on what applying a rule to every node did, naming every node it left out. */
export function describeAutoSettleRuleApplyResult(result: AutoSettleRuleApplyResult): string {
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

/** The node a settings screen sets the rule on. */
export interface AutoSettleRuleNodeView {
  readonly label: string;
  /** The node keeps the rule; an older node leaves it to each device. */
  readonly ownsRule: boolean;
  /** The node's rule, when it keeps one. */
  readonly value: SidebarAutoSettleAfterDays;
  /** This client may change the node's settings now. */
  readonly editable: boolean;
}

/**
 * Where a change of the rule goes: to the node that keeps it, else to this
 * device's own rule, which applies to nodes that keep none. Null when the
 * node keeps the rule but this client may not change it.
 */
export type AutoSettleRuleEdit =
  | { readonly kind: "node"; readonly patch: ServerSettingsPatch }
  | { readonly kind: "device"; readonly value: SidebarAutoSettleAfterDays };

export function resolveAutoSettleRuleEdit(
  node: AutoSettleRuleNodeView | null,
  value: SidebarAutoSettleAfterDays,
): AutoSettleRuleEdit | null {
  if (node === null || !node.ownsRule) return { kind: "device", value };
  return node.editable ? { kind: "node", patch: nodeAutoSettleRulePatch(value) } : null;
}

/**
 * Sets the rule where {@link resolveAutoSettleRuleEdit} says it goes: on the
 * node through `writeNode`, else as this device's own through `writeDevice`.
 * Resolves to where it went, or null when the node may not be changed.
 */
export async function changeAutoSettleRule(input: {
  readonly node: (AutoSettleRuleNodeView & { readonly environmentId: EnvironmentId }) | null;
  readonly value: SidebarAutoSettleAfterDays;
  readonly writeNode: (
    environmentId: EnvironmentId,
    patch: ServerSettingsPatch,
  ) => Promise<unknown>;
  readonly writeDevice: (value: SidebarAutoSettleAfterDays) => void;
}): Promise<AutoSettleRuleEdit["kind"] | null> {
  const edit = resolveAutoSettleRuleEdit(input.node, input.value);
  if (edit === null) return null;
  if (edit.kind === "device" || input.node === null) {
    input.writeDevice(input.value);
    return "device";
  }
  await input.writeNode(input.node.environmentId, edit.patch);
  return "node";
}

/**
 * The sentence that says where the rule applies: on the node the settings
 * show, or, for nodes that keep none (older ones), on this device only.
 */
export function autoSettleRuleScopeNote(
  scope:
    | { readonly node: Pick<AutoSettleRuleNodeView, "label" | "editable"> }
    | { readonly deviceRuleNodeLabels: ReadonlyArray<string> },
): string | null {
  if ("node" in scope) {
    const shared = `Set on ${scope.node.label}, so every device lists its tasks the same way.`;
    return scope.node.editable ? shared : `${shared} Only its owner can change it while connected.`;
  }
  const labels = scope.deviceRuleNodeLabels;
  if (labels.length === 0) return null;
  const verb = labels.length === 1 ? "does" : "do";
  return `${labels.join(", ")} ${verb} not keep this rule yet, so it applies on this device only.`;
}
