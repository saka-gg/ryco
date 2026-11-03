import type { LifecycleSuggestionPolicy } from "@ryco/contracts";

import {
  LIFECYCLE_SUGGESTION_COPY,
  formatSuggestionDays,
  parseSuggestionDays,
  suggestionDayOptions,
  suggestionDaysValue,
  type LifecycleSuggestionField,
} from "./lifecycleSuggestionPolicy";
import { SettingsSection } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";
import { SharedSettingRow, sharedControlLabel } from "./sharedSettings/SharedSettingRow";

const FIELDS = ["archiveInactiveThreadsDays", "removeArchivedCheckoutsDays"] as const;

// Each row compares only the suggestion it edits.
const SELECT_FIELD: Record<
  LifecycleSuggestionField,
  (policy: LifecycleSuggestionPolicy) => unknown
> = {
  archiveInactiveThreadsDays: (policy) => policy.archiveInactiveThreadsDays,
  removeArchivedCheckoutsDays: (policy) => policy.removeArchivedCheckoutsDays,
};

/**
 * The device default for approval-only cleanup suggestions, shared across devices; "Off"
 * disables one. Each project can override it on its page, under Workspaces. Nothing is
 * archived or removed without a confirmed action.
 */
export function LifecycleSuggestionSettings(props: { readonly disabled: boolean }) {
  return (
    <SettingsSection
      title="Cleanup suggestions"
      owner="node"
      description="Suggestions appear on each project's page under Workspaces, where a project can also change these. They always need your approval: running work, background tasks, open terminals, pinned threads and unfinished goals are never suggested, and nothing is removed because a pull request merged."
    >
      {FIELDS.map((field) => {
        const copy = LIFECYCLE_SUGGESTION_COPY[field];
        return (
          <SharedSettingRow
            key={field}
            settingKey="lifecycleSuggestions"
            title={copy.title}
            description={copy.description}
            compareBy={SELECT_FIELD[field]}
            formatValue={(policy) => formatSuggestionDays(policy[field])}
            render={(control) => (
              <SettingsSelect
                ariaLabel={sharedControlLabel(copy.ariaLabel, control)}
                width="sm"
                disabled={props.disabled || control.disabled}
                value={suggestionDaysValue(control.value[field])}
                onValueChange={(value) =>
                  control.onChange({ ...control.value, [field]: parseSuggestionDays(value) })
                }
                options={suggestionDayOptions(control.value[field])}
              />
            )}
          />
        );
      })}
    </SettingsSection>
  );
}
