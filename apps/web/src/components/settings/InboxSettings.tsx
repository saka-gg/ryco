import { useSettingsTarget } from "../../settingsTarget";
import { EnvironmentId } from "@ryco/contracts";
import {
  autoSettleRuleScopeNote,
  readNodeAutoSettleRule,
  type AutoSettleRuleNodeView,
} from "@ryco/client-runtime/state/settings";
import {
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type SidebarAutoSettleAfterDays,
} from "@ryco/contracts/settings";
import { ArchiveIcon } from "lucide-react";
import { useMemo, useState, type ReactNode } from "react";

import { isHostedHubMode } from "../../env";
import { useSavedEnvironmentRegistryStore } from "../../environments/runtime";
import { isSavedEnvironmentSwitchedOff } from "@ryco/client-runtime/connection";
import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { useEnvironmentSettingsTarget } from "../../hooks/useEnvironmentSettingsTarget";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { updateClientAutoSettleAfterDays, useSettings } from "../../hooks/useSettings";
import { useHostedHubStore } from "../../hostedHub/state";
import {
  applyAutoSettleRuleToAllNodes,
  setAutoSettleRule,
  type AutoSettleRuleNode,
} from "../../nodeAutoSettlement";
import { useDesktopWorkspaceState } from "../../platform/desktopWorkspace";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

const AUTO_SETTLE_DESCRIPTION =
  "Move inactive tasks to Settled after their last message or turn. Running work, queued messages, pending input, open pull requests, and tasks kept active are protected.";

export function AutoSettleSettingsSection(props: {
  /** The node the rule applies to; null shows this device's own rule. */
  readonly node: AutoSettleRuleNodeView | null;
  /** This device's own rule, for nodes that keep none. */
  readonly deviceValue: SidebarAutoSettleAfterDays;
  readonly onChange: (value: SidebarAutoSettleAfterDays) => void;
  readonly onApplyToAll?: (() => void) | undefined;
  readonly busy?: boolean | undefined;
  readonly status?: ReactNode;
}) {
  // The node's own rule when it keeps one; otherwise this device's applies.
  const ruleNode = props.node?.ownsRule ? props.node : null;
  const value = ruleNode ? ruleNode.value : props.deviceValue;
  const disabled = props.busy === true || (ruleNode !== null && !ruleNode.editable);
  const note =
    props.node === null
      ? null
      : autoSettleRuleScopeNote(
          ruleNode ? { node: ruleNode } : { deviceRuleNodeLabels: [props.node.label] },
        );
  return (
    <SettingsSection title="Housekeeping" icon={<ArchiveIcon className="size-3.5" />}>
      <SettingsRow
        title="Auto-settle inactive tasks"
        {...(props.node ? { scope: ruleNode ? ruleNode.label : "This device" } : {})}
        description={note ? `${AUTO_SETTLE_DESCRIPTION} ${note}` : AUTO_SETTLE_DESCRIPTION}
        status={props.status}
        control={
          <>
            <Select
              value={value?.toString() ?? "off"}
              disabled={disabled}
              onValueChange={(next) => {
                if (disabled) return;
                const parsed = next === "off" ? null : Number(next);
                if (
                  parsed === null ||
                  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS.includes(
                    parsed as Exclude<SidebarAutoSettleAfterDays, null>,
                  )
                ) {
                  props.onChange(parsed as SidebarAutoSettleAfterDays);
                }
              }}
            >
              <SelectTrigger className="w-48" aria-label="Auto-settle inactive tasks">
                <SelectValue>
                  {value === null ? "Off" : `After ${value} ${value === 1 ? "day" : "days"}`}
                </SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                <SelectItem hideIndicator value="off">
                  Off
                </SelectItem>
                {SIDEBAR_AUTO_SETTLE_DAY_OPTIONS.map((days) => (
                  <SelectItem key={days} hideIndicator value={String(days)}>
                    After {days} {days === 1 ? "day" : "days"}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            {props.onApplyToAll ? (
              <Button
                size="xs"
                variant="outline"
                disabled={props.busy === true}
                onClick={props.onApplyToAll}
              >
                Apply to all connected nodes
              </Button>
            ) : null}
          </>
        }
      />
    </SettingsSection>
  );
}

/**
 * Every node this client knows: the primary, then the hosted session's nodes,
 * or the saved environments and the Desktop workspace's machines.
 */
function useAutoSettleRuleNodes(): ReadonlyArray<AutoSettleRuleNode> {
  const hosted = isHostedHubMode();
  const primary = usePrimaryEnvironmentDescriptor();
  const hostedNodes = useHostedHubStore((state) => state.nodes);
  const savedEnvironments = useSavedEnvironmentRegistryStore((state) => state.byId);
  const desktopWorkspace = useDesktopWorkspaceState();
  return useMemo(() => {
    const nodes = new Map<EnvironmentId, string>();
    if (primary) nodes.set(primary.environmentId, primary.label);
    if (hosted) {
      for (const node of hostedNodes) {
        if (node.revokedAt !== null || node.capabilities?.nativeClientRequired === true) continue;
        if (!nodes.has(node.environmentId)) nodes.set(node.environmentId, node.label);
      }
    } else {
      for (const entry of Object.values(savedEnvironments)) {
        if (entry.environmentId === desktopWorkspace.localEnvironmentId) continue;
        // Left out while switched off, as in the sidebar.
        if (isSavedEnvironmentSwitchedOff(entry)) continue;
        if (!nodes.has(entry.environmentId)) nodes.set(entry.environmentId, entry.label);
      }
      for (const machine of desktopWorkspace.machines) {
        if (machine.environmentId === desktopWorkspace.localEnvironmentId) continue;
        if (!nodes.has(machine.environmentId)) nodes.set(machine.environmentId, machine.label);
      }
    }
    return [...nodes].map(([environmentId, label]) => ({ environmentId, label }));
  }, [desktopWorkspace, hosted, hostedNodes, primary, savedEnvironments]);
}

/**
 * The auto-settle rule of the node the settings show (the settings target, or
 * the primary node), kept by that node so every device lists its tasks alike.
 * An older node leaves the rule to each device, so this device's own applies.
 */
function NodeAutoSettleSettings() {
  const target = useSettingsTarget();
  const primary = usePrimaryEnvironmentDescriptor();
  const { target: primaryTarget } = useEnvironmentSettingsTarget(
    target ? null : (primary?.environmentId ?? null),
  );
  const node = target ?? primaryTarget;
  const deviceValue = useSettings((settings) => settings.sidebarAutoSettleAfterDays);
  const knownNodes = useAutoSettleRuleNodes();
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  // The web phone tier is frozen: it keeps its device-only control.
  const phone = usePresentationTier() === "phone";

  const config = node?.serverConfig ?? null;
  const nodeRule = readNodeAutoSettleRule(config);
  const view: AutoSettleRuleNodeView | null =
    node === null
      ? null
      : {
          label: node.nodeLabel,
          ownsRule: nodeRule !== undefined,
          value: nodeRule === undefined ? deviceValue : nodeRule,
          editable:
            node.connected &&
            node.canManage !== false &&
            node.canMutate !== false &&
            config !== null,
        };

  const change = (value: SidebarAutoSettleAfterDays) => {
    setStatus(null);
    // Only a write to the node waits; this device's own rule changes at once.
    const writesNode = view?.ownsRule === true;
    if (writesNode) setBusy(true);
    void setAutoSettleRule(
      node === null || view === null ? null : { ...view, environmentId: node.environmentId },
      value,
    )
      .catch((error: unknown) => {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: `Could not update ${node?.nodeLabel ?? "the node"}`,
            description: errorMessage(error),
          }),
        );
      })
      .finally(() => {
        if (writesNode) setBusy(false);
      });
  };

  const applyToAll = () => {
    setBusy(true);
    setStatus(null);
    void applyAutoSettleRuleToAllNodes(view?.ownsRule ? view.value : deviceValue, knownNodes)
      .then(setStatus)
      .finally(() => setBusy(false));
  };

  if (phone) {
    return (
      <AutoSettleSettingsSection
        node={null}
        deviceValue={deviceValue}
        onChange={updateClientAutoSettleAfterDays}
      />
    );
  }
  return (
    <AutoSettleSettingsSection
      node={view}
      deviceValue={deviceValue}
      onChange={change}
      onApplyToAll={knownNodes.length > (view === null ? 0 : 1) ? applyToAll : undefined}
      busy={busy}
      status={status ? <span role="status">{status}</span> : null}
    />
  );
}

export function InboxSettings() {
  return (
    <SettingsPageContainer>
      <NodeAutoSettleSettings />
    </SettingsPageContainer>
  );
}
