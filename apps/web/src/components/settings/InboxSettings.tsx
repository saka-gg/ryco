import { useSettingsTarget } from "../../settingsTarget";
import {
  autoSettleRuleScopeNote,
  nodeOwnsAutoSettleRule,
  readNodeAutoSettleRule,
  type AutoSettleRuleNodeView,
} from "@ryco/client-runtime/state/settings";
import {
  DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS,
  SIDEBAR_AUTO_SETTLE_DAY_OPTIONS,
  type SidebarAutoSettleAfterDays,
} from "@ryco/contracts/settings";
import { ArchiveIcon } from "lucide-react";
import { type ReactNode } from "react";

import { usePrimaryEnvironmentDescriptor } from "../../environments/primary";
import { useEnvironmentSettingsTarget } from "../../hooks/useEnvironmentSettingsTarget";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { updateClientAutoSettleAfterDays, useSettings } from "../../hooks/useSettings";
import { setAutoSettleRule } from "../../nodeAutoSettlement";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";
import { errorMessage } from "~/lib/errorMessage";

function autoSettleLabel(value: SidebarAutoSettleAfterDays): string {
  return value === null ? "Off" : `After ${value} ${value === 1 ? "day" : "days"}`;
}

const AUTO_SETTLE_DESCRIPTION =
  "Move inactive tasks to Settled after their last message or turn. Running work, queued messages, pending input, open pull requests, and tasks kept active are protected.";

function AutoSettleSelect(props: {
  readonly value: SidebarAutoSettleAfterDays;
  readonly disabled: boolean;
  readonly onChange: (value: SidebarAutoSettleAfterDays) => void;
  readonly ariaLabel: string;
}) {
  return (
    <Select
      value={props.value?.toString() ?? "off"}
      disabled={props.disabled}
      onValueChange={(next) => {
        if (props.disabled) return;
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
      <SelectTrigger size="sm" className="w-48" aria-label={props.ariaLabel}>
        <SelectValue>{autoSettleLabel(props.value)}</SelectValue>
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
  );
}

/**
 * The rule as one device keeps it: the node's own when it keeps one, else this
 * app's (a node too old to keep it, and the frozen phone tier).
 */
export function AutoSettleSettingsSection(props: {
  /** The node the rule applies to; null shows this device's own rule. */
  readonly node: AutoSettleRuleNodeView | null;
  /** This device's own rule, for nodes that keep none. */
  readonly deviceValue: SidebarAutoSettleAfterDays;
  readonly onChange: (value: SidebarAutoSettleAfterDays) => void;
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
          <AutoSettleSelect
            value={value}
            disabled={disabled}
            onChange={props.onChange}
            ariaLabel="Auto-settle inactive tasks"
          />
        }
      />
    </SettingsSection>
  );
}

/**
 * The auto-settle rule, kept by each node so every device lists its tasks
 * alike, and shared between devices. A node too old to keep it leaves the rule
 * to each app, so this app's own applies there.
 */
function NodeAutoSettleSettings() {
  const target = useSettingsTarget();
  const primary = usePrimaryEnvironmentDescriptor();
  const { target: primaryTarget } = useEnvironmentSettingsTarget(
    target ? null : (primary?.environmentId ?? null),
  );
  const node = target ?? primaryTarget;
  const deviceValue = useSettings((settings) => settings.sidebarAutoSettleAfterDays);
  // The web phone tier is frozen: it keeps its device-only control.
  const phone = usePresentationTier() === "phone";
  const config = node?.serverConfig ?? null;
  const nodeRule = readNodeAutoSettleRule(config);

  if (phone) {
    return (
      <AutoSettleSettingsSection
        node={null}
        deviceValue={deviceValue}
        onChange={updateClientAutoSettleAfterDays}
      />
    );
  }
  if (node !== null && config !== null && nodeRule === undefined) {
    // An older node: this app's own rule, as before.
    const view: AutoSettleRuleNodeView = {
      label: node.nodeLabel,
      ownsRule: false,
      value: deviceValue,
      editable: true,
    };
    return (
      <AutoSettleSettingsSection
        node={view}
        deviceValue={deviceValue}
        onChange={(value) => {
          void setAutoSettleRule({ ...view, environmentId: node.environmentId }, value).catch(
            (error: unknown) =>
              toastManager.add(
                stackedThreadToast({
                  type: "error",
                  title: "Could not update the rule",
                  description: errorMessage(error, "An unexpected error occurred."),
                }),
              ),
          );
        }}
      />
    );
  }
  return (
    <SettingsSection title="Housekeeping" icon={<ArchiveIcon className="size-3.5" />}>
      <SharedSettingRow
        settingKey="threadAutoSettleAfterDays"
        description={AUTO_SETTLE_DESCRIPTION}
        knowsSetting={nodeOwnsAutoSettleRule}
        unknownSettingStatus="This device is too old to keep the rule; each app's own rule applies there."
        defaultValue={DEFAULT_SIDEBAR_AUTO_SETTLE_AFTER_DAYS}
        resetLabel="auto-settle inactive tasks"
        render={(control) => (
          <AutoSettleSelect
            value={control.value}
            disabled={control.disabled}
            onChange={control.onChange}
            ariaLabel={sharedControlLabel("Auto-settle inactive tasks", control)}
          />
        )}
      />
    </SettingsSection>
  );
}

export function InboxSettings() {
  return (
    <SettingsPageContainer>
      <NodeAutoSettleSettings />
    </SettingsPageContainer>
  );
}
