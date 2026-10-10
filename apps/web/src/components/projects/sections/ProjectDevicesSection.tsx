import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import type { SidebarProjectGroupingMode } from "@ryco/contracts";
import type { UnifiedSettings } from "@ryco/contracts/settings";
import { ArrowRightIcon } from "lucide-react";
import { useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

import { useDeviceName } from "../../../deviceName";
import { isElectron } from "../../../env";
import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { useSavedEnvironmentRegistryStore } from "../../../environments/runtime";
import { useSettings, useUpdateSettings } from "../../../hooks/useSettings";
import { cn } from "../../../lib/utils";
import { useDesktopWorkspaceState } from "../../../platform/desktopWorkspace";
import {
  readProjectGroupingChoice,
  withProjectGroupingChoice,
  type ProjectGroupingChoice,
} from "../../../projectMutations";
import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import { selectSidebarThreadsForProjectRef, useStore } from "../../../store";
import { DeviceIcon } from "../../DeviceIcon";
import { RelativeTime } from "../../pullRequests/primitives";
import { SettingsSelect } from "../../settings/SettingsSelect";
import { SETTINGS_INSET_CLASS, SettingsBlock, SettingsRow } from "../../settings/settingsLayout";
import {
  PROJECT_GROUPING_MODE_LABELS,
  projectGroupingModeDescription,
} from "../../sidebar/sidebarProjectGroupingLabels";
import {
  devicesWithoutProject,
  formatProjectPath,
  inferHomeDirectory,
  threadActivityTimestamp,
} from "../projectsModel.logic";
import { useProjectsPage, useProjectsSelection } from "../ProjectsPageContext";
import { useEnvironmentPresence, type EnvironmentPresenceStatus } from "../useEnvironmentPresence";
import { ProjectSection, useSavedFlash } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

const STATUS_LABEL: Record<EnvironmentPresenceStatus, string> = {
  online: "Online",
  connecting: "Connecting",
  cached: "Offline · cached",
  offline: "Offline",
};

const selectGroupingMode = (settings: UnifiedSettings) => settings.sidebarProjectGroupingMode;
const selectGroupingOverrides = (settings: UnifiedSettings) =>
  settings.sidebarProjectGroupingOverrides;

function PresenceDot(props: { readonly status: EnvironmentPresenceStatus }) {
  return (
    <span
      aria-hidden
      className={cn(
        "size-1.5 shrink-0 rounded-full",
        props.status === "online" && "bg-success",
        props.status === "connecting" && "animate-status-pulse bg-warning",
        (props.status === "cached" || props.status === "offline") &&
          "border border-muted-foreground/50 bg-transparent",
      )}
    />
  );
}

/** Thread count and last activity of one checkout. */
function useCheckoutActivity(member: SidebarProjectGroupMember) {
  const threads = useStore(
    useShallow((state) =>
      selectSidebarThreadsForProjectRef(state, scopeProjectRef(member.environmentId, member.id)),
    ),
  );
  return useMemo(
    () => ({
      count: threads.length,
      lastActive: threads.reduce(
        (latest, thread) => Math.max(latest, threadActivityTimestamp(thread)),
        0,
      ),
    }),
    [threads],
  );
}

/**
 * One checkout: its device, reachability, path and how busy it is. With more
 * than one, the rows are how the page switches which checkout it edits.
 */
function CheckoutRow(props: {
  readonly member: SidebarProjectGroupMember;
  readonly editing: boolean;
  readonly selectable: boolean;
  readonly onSelect: () => void;
}) {
  const presence = useEnvironmentPresence(props.member.environmentId);
  const activity = useCheckoutActivity(props.member);
  const body = (
    <>
      <span className="grid size-8 shrink-0 place-items-center rounded-[min(var(--radius-lg),0.625rem)] bg-foreground/5 text-foreground/80">
        <DeviceIcon
          environmentId={props.member.environmentId}
          label={presence.label}
          className="size-4"
        />
      </span>
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-1.5">
          <span className="truncate text-[13px] font-medium">{presence.label}</span>
          <PresenceDot status={presence.status} />
          <span className="sr-only">{STATUS_LABEL[presence.status]}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="truncate font-mono" title={props.member.cwd}>
            {formatProjectPath(props.member.cwd, inferHomeDirectory(props.member.cwd))}
          </span>
          <span aria-hidden>·</span>
          {presence.status === "online" ? null : (
            <span className="shrink-0">{STATUS_LABEL[presence.status]} ·</span>
          )}
          <span className="shrink-0 tabular-nums">
            {activity.count} thread{activity.count === 1 ? "" : "s"}
          </span>
          {activity.lastActive > 0 ? (
            <span className="hidden shrink-0 @[36rem]/detail:inline">
              · <RelativeTime value={new Date(activity.lastActive).toISOString()} withSuffix />
            </span>
          ) : null}
        </span>
      </span>
      {props.selectable ? (
        props.editing ? (
          <span className="shrink-0 rounded-[min(var(--radius-sm),0.25rem)] bg-foreground/[0.07] px-1.5 py-px text-[11px] font-medium text-foreground/80">
            Editing
          </span>
        ) : (
          <span className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground opacity-0 transition-opacity duration-(--app-motion-duration-chip) group-hover/checkout:opacity-100 group-focus-visible/checkout:opacity-100">
            Edit here
            <ArrowRightIcon className="size-3" />
          </span>
        )
      ) : null}
    </>
  );
  const className = cn(
    "flex w-full min-w-0 items-center gap-3 border-t border-border/60 py-3 text-left first:border-t-0",
    SETTINGS_INSET_CLASS,
  );
  if (!props.selectable) return <div className={className}>{body}</div>;
  return (
    <button
      type="button"
      aria-current={props.editing ? "true" : undefined}
      onClick={props.onSelect}
      className={cn(
        className,
        "group/checkout outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:bg-accent/55",
        props.editing ? "bg-accent/40" : "hover:bg-accent/40",
      )}
    >
      {body}
    </button>
  );
}

/** Devices this client knows, by environment id, with the labels people recognize. */
function useKnownDevices(): ReadonlyArray<{
  readonly environmentId: string;
  readonly label: string;
}> {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const primaryName = useDeviceName();
  const saved = useSavedEnvironmentRegistryStore((state) => state.byId);
  const desktop = useDesktopWorkspaceState();
  return useMemo(() => {
    const devices: Array<{ environmentId: string; label: string }> = [];
    if (primaryEnvironmentId)
      devices.push({ environmentId: primaryEnvironmentId, label: primaryName });
    // The desktop's own Hub alias is this device again; never list it twice.
    const localAlias = isElectron ? desktop.localEnvironmentId : null;
    for (const record of Object.values(saved)) {
      if (record.environmentId !== localAlias)
        devices.push({ environmentId: record.environmentId, label: record.label });
    }
    for (const machine of desktop.machines) {
      if (machine.environmentId !== localAlias)
        devices.push({ environmentId: machine.environmentId, label: machine.label });
    }
    return devices;
  }, [desktop.localEnvironmentId, desktop.machines, primaryEnvironmentId, primaryName, saved]);
}

/**
 * Where the project is checked out, and where not. With several checkouts the
 * rows pick which one the rest of the page edits. Sidebar grouping is a
 * browser preference about these checkouts, so it lives here too.
 */
export function ProjectDevicesSection({ member }: ProjectSectionProps) {
  const { nav } = useProjectsPage();
  const { snapshot } = useProjectsSelection();
  const knownDevices = useKnownDevices();
  // Only a device whose project list has arrived can be said to lack it;
  // one that is offline or still syncing simply is not known yet.
  const syncedEnvironmentIds = useStore(
    useShallow((state) =>
      Object.entries(state.environmentStateById)
        .filter(([, environmentState]) => environmentState.bootstrapComplete)
        .map(([environmentId]) => environmentId),
    ),
  );
  const missing = devicesWithoutProject({
    knownDevices: knownDevices.filter((device) =>
      syncedEnvironmentIds.includes(device.environmentId),
    ),
    projectEnvironmentIds: new Set(
      snapshot.memberProjects.map((candidate) => candidate.environmentId),
    ),
  });
  const selectable = snapshot.memberProjects.length > 1;

  const saved = useSavedFlash();
  const groupingMode = useSettings(selectGroupingMode);
  const groupingOverrides = useSettings(selectGroupingOverrides);
  const { updateSettings } = useUpdateSettings();
  const groupingChoice = readProjectGroupingChoice(groupingOverrides, member);
  const groupingOptions: Array<{ value: ProjectGroupingChoice; label: string }> = [
    {
      value: "inherit",
      label: `Default (${PROJECT_GROUPING_MODE_LABELS[groupingMode].toLowerCase()})`,
    },
    ...(Object.keys(PROJECT_GROUPING_MODE_LABELS) as SidebarProjectGroupingMode[]).map((mode) => ({
      value: mode,
      label: PROJECT_GROUPING_MODE_LABELS[mode],
    })),
  ];

  return (
    <ProjectSection
      section="devices"
      description={
        selectable
          ? "Pick a device to edit the project as it is there."
          : "Where this project is checked out."
      }
      savedToken={saved.token}
    >
      <div role="group" aria-label="Checkouts">
        {snapshot.memberProjects.map((candidate) => (
          <CheckoutRow
            key={`${candidate.environmentId}:${candidate.id}`}
            member={candidate}
            selectable={selectable}
            editing={candidate.environmentId === member.environmentId && candidate.id === member.id}
            onSelect={() =>
              nav.selectCheckout({
                environmentId: candidate.environmentId,
                projectId: candidate.id,
              })
            }
          />
        ))}
      </div>
      {missing.length > 0 ? (
        <SettingsBlock className="py-2.5 text-xs text-muted-foreground">
          Not on {missing.join(", ")}
        </SettingsBlock>
      ) : null}
      <SettingsRow
        title="Sidebar grouping"
        description={
          groupingChoice === "inherit"
            ? "Follows the sidebar's grouping setting. Applies to this browser."
            : `${projectGroupingModeDescription(groupingChoice)} Applies to this browser.`
        }
        control={
          <SettingsSelect
            ariaLabel="Sidebar grouping"
            value={groupingChoice}
            options={groupingOptions}
            width="lg"
            onValueChange={(choice) => {
              updateSettings({
                sidebarProjectGroupingOverrides: withProjectGroupingChoice(
                  groupingOverrides,
                  member,
                  choice,
                ),
              });
              saved.flash();
            }}
          />
        }
      />
    </ProjectSection>
  );
}
