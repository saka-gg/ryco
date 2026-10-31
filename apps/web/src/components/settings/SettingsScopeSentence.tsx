import type { EnvironmentId } from "@ryco/contracts";
import { ChevronsUpDownIcon } from "lucide-react";

import { DeviceIcon } from "../DeviceIcon";
import { Button } from "../ui/button";
import {
  SETTINGS_NODE_STATUS_LABELS,
  SettingsNodeMenu,
  type SettingsNodeMenuModel,
} from "./SettingsNodeMenu";
import type { SettingsNodeStatus } from "./SettingsScopeSentence.logic";

/**
 * "Changes apply to [Studio ▾]" above a node section's title: the device its
 * rows read and write, switched with the same menu as the nav header. Display
 * only, plus that menu; it never opens a write target of its own.
 */
export function SettingsScopeSentence(props: {
  readonly model: SettingsNodeMenuModel;
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
  /** Why the device shown cannot be reached now. */
  readonly status: SettingsNodeStatus | null;
  /** Rows of this section may show "Mixed": say what it means. */
  readonly mixedClause: boolean;
}) {
  const device = (
    <>
      <DeviceIcon
        environmentId={props.environmentId}
        label={props.label}
        className="size-3.5 shrink-0"
      />
      <span className="min-w-0 truncate" data-testid="settings-scope-label">
        {props.label}
      </span>
    </>
  );
  return (
    <p
      className="mb-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground"
      data-testid="settings-scope-sentence"
    >
      <span className="shrink-0">Changes apply to</span>
      {props.model.choices.length > 1 ? (
        <SettingsNodeMenu
          model={props.model}
          trigger={
            <Button
              size="xs"
              variant="outline"
              // A combobox trigger takes no name from its content.
              aria-label={`${props.label}, switch device`}
              className="min-w-0 max-w-64 font-medium text-foreground"
            >
              {device}
              <ChevronsUpDownIcon aria-hidden className="size-3 shrink-0 opacity-60" />
            </Button>
          }
        />
      ) : (
        <span className="flex min-w-0 items-center gap-1.5 font-medium text-foreground">
          {device}
        </span>
      )}
      {props.status ? (
        <span className="shrink-0">{SETTINGS_NODE_STATUS_LABELS[props.status]}</span>
      ) : null}
      {props.mixedClause ? (
        <span className="shrink-0 text-muted-foreground/80">
          · rows marked Mixed differ on other nodes
        </span>
      ) : null}
    </p>
  );
}
