import {
  LOWER_BOUND_NOTE,
  type DiskUsageReading,
} from "@ryco/client-runtime/projectSettings/diskUsage";
import type { WorkspaceActionId } from "@ryco/client-runtime/state/lifecycle";
import { Alert } from "react-native";

import { SettingsRow } from "../settings/components/SettingsRow";
import { ProjectSettingsSection, SectionMessage } from "./ProjectSettingsSection";
import {
  projectWorkspacesView,
  workspaceActionLabel,
  workspaceRowDetail,
  type ProjectWorkspaceRow,
} from "./projectSettingsModel";
import type { ProjectWorkspaceInspection } from "./useProjectWorkspaceData";

/**
 * The project's workspaces as its machine inspected them: what each holds that exists nowhere
 * else, what it takes on disk, and Archive, Restore or Delete. Delete opens its review.
 */
export function ProjectWorkspacesSection(props: {
  readonly inspection: ProjectWorkspaceInspection;
  readonly disk: DiskUsageReading;
  readonly canChange: boolean;
  readonly busyWorktreeId: string | null;
  readonly error: string | null;
  readonly onRemeasure: () => void;
  readonly onAction: (row: ProjectWorkspaceRow, action: WorkspaceActionId) => void;
}) {
  const { inspection } = props;
  const view = projectWorkspacesView({
    summaries: inspection.status === "ready" ? inspection.summaries : [],
    disk: props.disk,
  });

  const openMenu = (row: ProjectWorkspaceRow) =>
    Alert.alert(row.title, row.branch !== row.title ? row.branch : undefined, [
      ...row.actions.map((action) => ({
        text: workspaceActionLabel(action),
        style: action === "delete-workspace" ? ("destructive" as const) : ("default" as const),
        onPress: () => props.onAction(row, action),
      })),
      { text: "Cancel", style: "cancel" as const },
    ]);

  return (
    <ProjectSettingsSection
      section="workspaces"
      footer={view.diskPartial ? LOWER_BOUND_NOTE : "The main checkout counts with its Git data."}
    >
      <SettingsRow first label="On disk" value={view.diskTotal} />
      {props.disk.status !== "unavailable" ? (
        <SettingsRow label="Measure again" onPress={props.onRemeasure} />
      ) : null}
      {inspection.status === "unavailable" ? (
        <SectionMessage message="This machine cannot inspect its workspaces from here." />
      ) : inspection.status === "loading" ? (
        <SectionMessage message="Inspecting the workspaces…" />
      ) : inspection.status === "error" ? (
        <SectionMessage tone="danger" message={inspection.message} />
      ) : view.rows.length === 0 ? (
        <SectionMessage message="No worktrees. Tasks run in the project folder itself." />
      ) : (
        view.rows.map((row) => (
          <SettingsRow
            key={row.worktreeId}
            label={row.title}
            detail={workspaceRowDetail(row)}
            value={props.busyWorktreeId === row.worktreeId ? "Working…" : (row.disk ?? undefined)}
            disabled={props.busyWorktreeId === row.worktreeId}
            {...(props.canChange && row.actions.length > 0 ? { onPress: () => openMenu(row) } : {})}
          />
        ))
      )}
      {props.error ? <SectionMessage tone="danger" message={props.error} /> : null}
    </ProjectSettingsSection>
  );
}
