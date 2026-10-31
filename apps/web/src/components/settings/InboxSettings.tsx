import { useSettingsTarget } from "../../settingsTarget";
import {
  autoSettleRuleScopeNote,
  nodeAutoSettleRulePatch,
  nodeOwnsAutoSettleRule,
  readNodeAutoSettleRule,
  type AutoSettleRuleNodeView,
} from "@ryco/client-runtime/state/settings";
import {
  applyNodeSettingsPatch,
  describeNodeSettingsApplyResult,
} from "@ryco/client-runtime/state/settings/nodeSettingsFanOut";
import {
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type ServerSettings,
  type SidebarAutoSettleAfterDays,
} from "@ryco/contracts/settings";
import { resolveAutoSettleAfterDays } from "@ryco/shared/threadSettlement";
import { ArchiveIcon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { useEnvironmentSettingsTarget } from "../../hooks/useEnvironmentSettingsTarget";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { updateClientAutoSettleAfterDays, useSettings } from "../../hooks/useSettings";
import { setAutoSettleRule } from "../../nodeAutoSettlement";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { MixedNodesBadge, useNodeSettingsAgreement } from "./ApplyToAllNodes";
import { readNodeSettingsTarget, useKnownSettingsNodes } from "./nodeSettingsTargets";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unexpected error occurred.";
}

function autoSettleLabel(value: SidebarAutoSettleAfterDays): string {
  return value === null ? "Off" : `After ${value} ${value === 1 ? "day" : "days"}`;
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
                <SelectValue>{autoSettleLabel(value)}</SelectValue>
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

// Module level, so the agreement is not re-read for a new selector on every render.
const selectAutoSettleRule = (settings: ServerSettings): SidebarAutoSettleAfterDays =>
  resolveAutoSettleAfterDays(settings.threadAutoSettleAfterDays);

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
  const knownNodes = useKnownSettingsNodes();
  const agreement = useNodeSettingsAgreement(selectAutoSettleRule, nodeOwnsAutoSettleRule);
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
    void applyNodeSettingsPatch(
      knownNodes.map(readNodeSettingsTarget),
      nodeAutoSettleRulePatch(view?.ownsRule ? view.value : deviceValue),
      { supported: nodeOwnsAutoSettleRule },
    )
      .then((result) => setStatus(describeNodeSettingsApplyResult(result)))
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
      status={
        status || agreement.kind === "mixed" ? (
          <>
            <MixedNodesBadge agreement={agreement} format={autoSettleLabel} />
            {status ? <span role="status">{status}</span> : null}
          </>
        ) : null
      }
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
