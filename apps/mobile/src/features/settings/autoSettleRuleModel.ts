import {
  autoSettleRuleScopeNote,
  autoSettleRuleTargetBlocker,
  changeAutoSettleRule,
  readNodeAutoSettleRule,
  type AutoSettleRuleTarget,
} from "@ryco/client-runtime/state/settings";
import type { EnvironmentId, ServerConfig } from "@ryco/contracts";
import type { ServerSettingsPatch, SidebarAutoSettleAfterDays } from "@ryco/contracts/settings";

export interface AutoSettleRuleNodeRow {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly value: SidebarAutoSettleAfterDays;
  /** This device may change the node's settings now (its owner, connected). */
  readonly editable: boolean;
}

export interface AutoSettleRuleModel {
  /** The connected nodes that keep their own rule, by label. */
  readonly nodes: ReadonlyArray<AutoSettleRuleNodeRow>;
  /** The node the options set the rule on; null sets this device's own rule. */
  readonly editing: AutoSettleRuleNodeRow | null;
  /** The rule the options show as selected. */
  readonly value: SidebarAutoSettleAfterDays;
  /** Connected nodes that keep no rule (older ones): their tasks follow this device's. */
  readonly deviceRuleNodeLabels: ReadonlyArray<string>;
}

/**
 * The Inbox settings' view of the auto-settle rule: each connected node keeps
 * its own, and the options edit the chosen node's (the first by label until
 * one is chosen). Without such a node they edit this device's own rule, which
 * nodes that keep none still follow.
 */
export function buildAutoSettleRuleModel(input: {
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly labelOf: (environmentId: EnvironmentId, config: ServerConfig) => string;
  readonly isOwner: (environmentId: EnvironmentId) => boolean;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly deviceValue: SidebarAutoSettleAfterDays;
}): AutoSettleRuleModel {
  const nodes: AutoSettleRuleNodeRow[] = [];
  const deviceRuleNodeLabels: string[] = [];
  for (const [environmentId, config] of input.configs) {
    if (!input.isConnected(environmentId)) continue;
    const label = input.labelOf(environmentId, config);
    const value = readNodeAutoSettleRule(config);
    if (value === undefined) {
      deviceRuleNodeLabels.push(label);
      continue;
    }
    nodes.push({ environmentId, label, value, editable: input.isOwner(environmentId) });
  }
  nodes.sort((left, right) => left.label.localeCompare(right.label));
  const editing =
    nodes.find((node) => node.environmentId === input.selectedEnvironmentId) ?? nodes[0] ?? null;
  return {
    nodes,
    editing,
    value: editing === null ? input.deviceValue : editing.value,
    deviceRuleNodeLabels: deviceRuleNodeLabels.toSorted((left, right) => left.localeCompare(right)),
  };
}

/** The sentence that says where the options' rule applies; null with no node to name. */
export function autoSettleRuleModelNote(model: AutoSettleRuleModel): string | null {
  return autoSettleRuleScopeNote(
    model.editing === null
      ? { deviceRuleNodeLabels: model.deviceRuleNodeLabels }
      : { node: model.editing },
  );
}

/**
 * Sets the rule the options show: on the node being edited, or, without one,
 * as this device's own rule. Null when the node may not be changed here.
 */
export function changeAutoSettleRuleModel(
  model: AutoSettleRuleModel,
  value: SidebarAutoSettleAfterDays,
  writers: {
    readonly writeNode: (
      environmentId: EnvironmentId,
      patch: ServerSettingsPatch,
    ) => Promise<unknown>;
    readonly writeDevice: (value: SidebarAutoSettleAfterDays) => void;
  },
): Promise<"node" | "device" | null> {
  return changeAutoSettleRule({
    node: model.editing === null ? null : { ...model.editing, ownsRule: true },
    value,
    ...writers,
  });
}

/** Every node "Apply to all connected nodes" tries, writable now or with why not. */
export function buildAutoSettleRuleTargets(input: {
  readonly environmentIds: Iterable<EnvironmentId>;
  readonly configs: ReadonlyMap<EnvironmentId, ServerConfig>;
  readonly labelOf: (environmentId: EnvironmentId) => string;
  readonly isOwner: (environmentId: EnvironmentId) => boolean;
  readonly isConnected: (environmentId: EnvironmentId) => boolean;
  readonly write: (environmentId: EnvironmentId, patch: ServerSettingsPatch) => Promise<unknown>;
}): ReadonlyArray<AutoSettleRuleTarget> {
  return [...new Set(input.environmentIds)].map((environmentId) => ({
    environmentId,
    label: input.labelOf(environmentId),
    blocker: autoSettleRuleTargetBlocker({
      connected: input.isConnected(environmentId),
      config: input.configs.get(environmentId),
      canWrite: input.isOwner(environmentId),
    }),
    write: (patch) => input.write(environmentId, patch),
  }));
}
