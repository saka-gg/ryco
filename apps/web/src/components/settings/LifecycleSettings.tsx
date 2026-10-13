import { type EnvironmentId } from "@ryco/contracts";

import {
  LIFECYCLE_SUGGESTION_COPY,
  parseSuggestionDays,
  suggestionDayOptions,
  suggestionDaysValue,
  useLifecycleSuggestionPolicyEditor,
} from "./lifecycleSuggestionPolicy";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsSelect } from "./SettingsSelect";

/**
 * The device default for approval-only cleanup suggestions; "Off" disables one.
 * Each project can override it on its page, under Workspaces. Nothing is
 * archived or removed without a confirmed action.
 */
export function LifecycleSuggestionSettings(props: {
  readonly environmentId: EnvironmentId | null;
  readonly disabled: boolean;
}) {
  const editor = useLifecycleSuggestionPolicyEditor({
    environmentId: props.environmentId,
    projectId: null,
  });
  const busy = props.disabled || editor.saving || editor.policy === null;
  return (
    <SettingsSection
      title="Cleanup suggestions"
      owner="node"
      description="Suggestions appear on each project's page under Workspaces, where a project can also change these. They always need your approval: running work, background tasks, open terminals, pinned threads and unfinished goals are never suggested, and nothing is removed because a pull request merged."
    >
      {(["archiveInactiveThreadsDays", "removeArchivedCheckoutsDays"] as const).map((field) => {
        const copy = LIFECYCLE_SUGGESTION_COPY[field];
        const days = editor.policy?.[field] ?? null;
        return (
          <SettingsRow
            key={field}
            title={copy.title}
            description={copy.description}
            control={
              <SettingsSelect
                ariaLabel={copy.ariaLabel}
                width="sm"
                disabled={busy}
                value={suggestionDaysValue(days)}
                onValueChange={(value) => void editor.setField(field, parseSuggestionDays(value))}
                options={suggestionDayOptions(days)}
              />
            }
          />
        );
      })}
    </SettingsSection>
  );
}
