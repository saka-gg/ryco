import type {
  EnvironmentId,
  LifecycleSuggestionPolicy,
  ServerSettingsPatch,
} from "@ryco/contracts";
import { resolveLifecycleSuggestionPolicy } from "@ryco/shared/workspaceLifecycle";
import { useCallback, useState } from "react";

import { updateEnvironmentServerSettings } from "../../environments/runtime";
import { useServerConfig } from "../../rpc/serverState";
import { stackedThreadToast, toastManager } from "../ui/toast";

export type LifecycleSuggestionField = keyof LifecycleSuggestionPolicy;

const DAY_OPTIONS = [7, 14, 30, 60, 90];

export const LIFECYCLE_SUGGESTION_COPY: Record<
  LifecycleSuggestionField,
  { readonly title: string; readonly description: string; readonly ariaLabel: string }
> = {
  archiveInactiveThreadsDays: {
    title: "Suggest archiving inactive conversations",
    description: "After this many days without activity.",
    ariaLabel: "Inactive conversation suggestion",
  },
  removeArchivedCheckoutsDays: {
    title: "Suggest removing finished checkouts",
    description:
      "Once every conversation of a workspace has been archived this long. History and the branch are always kept.",
    ariaLabel: "Finished checkout suggestion",
  },
};

export function formatSuggestionDays(days: number | null): string {
  return days === null ? "Off" : `${days} days`;
}

/** "Off", then day counts; an unusual saved value stays selectable. */
export function suggestionDayOptions(
  current: number | null,
): Array<{ readonly value: string; readonly label: string }> {
  const days =
    current !== null && !DAY_OPTIONS.includes(current) ? [...DAY_OPTIONS, current] : DAY_OPTIONS;
  return [
    { value: "off", label: "Off" },
    ...days
      .toSorted((a, b) => a - b)
      .map((value) => ({ value: String(value), label: formatSuggestionDays(value) })),
  ];
}

export const suggestionDaysValue = (days: number | null): string =>
  days === null ? "off" : String(days);

export const parseSuggestionDays = (value: string): number | null =>
  value === "off" ? null : Number(value);

/**
 * Reads and writes the approval-only cleanup suggestions of one device: the
 * device default (`projectId` null) or one project's override, which follows
 * the device default until it is set and can be reset back to it.
 */
export function useLifecycleSuggestionPolicyEditor(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectId: string | null;
}) {
  const { environmentId, projectId } = input;
  const settings = useServerConfig()?.settings;
  const [saving, setSaving] = useState(false);
  const policy = settings ? resolveLifecycleSuggestionPolicy(settings, projectId) : null;
  const devicePolicy = settings ? resolveLifecycleSuggestionPolicy(settings, null) : null;
  const overridden = Boolean(projectId && settings?.projectLifecycleSuggestions[projectId]);

  /** `null` clears a project override (the device default is never cleared). */
  const save = useCallback(
    async (next: LifecycleSuggestionPolicy | null) => {
      if (!environmentId || (!projectId && !next)) return;
      const patch: ServerSettingsPatch = projectId
        ? { projectLifecycleSuggestions: { [projectId]: next } }
        : { lifecycleSuggestions: next! };
      setSaving(true);
      try {
        await updateEnvironmentServerSettings(environmentId, patch);
        return true;
      } catch (error) {
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Could not save suggestion settings",
            description: error instanceof Error ? error.message : "An error occurred.",
          }),
        );
        return false;
      } finally {
        setSaving(false);
      }
    },
    [environmentId, projectId],
  );

  const setField = useCallback(
    (field: LifecycleSuggestionField, days: number | null) =>
      policy ? save({ ...policy, [field]: days }) : Promise.resolve(undefined),
    [policy, save],
  );

  return { policy, devicePolicy, overridden, saving, save, setField };
}
