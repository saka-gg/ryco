import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { useState } from "react";

import { describeProjectRemoval, removeProjectCheckout } from "../../../projectMutations";
import { selectSidebarThreadsForProjectRef, useStore } from "../../../store";
import { SettingsRow } from "../../settings/settingsLayout";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../../ui/alert-dialog";
import { Button } from "../../ui/button";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { useProjectsPage } from "../ProjectsPageContext";
import { useEnvironmentPresence } from "../useEnvironmentPresence";
import { ProjectSection } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

/**
 * Removing the project from this device. The confirmation grows from the
 * button and states exactly what goes: the threads (with their history) go,
 * the files on disk stay.
 */
export function ProjectDangerSection({ member, canEdit }: ProjectSectionProps) {
  const { nav } = useProjectsPage();
  const presence = useEnvironmentPresence(member.environmentId);
  const threadCount = useStore(
    (state) =>
      selectSidebarThreadsForProjectRef(state, scopeProjectRef(member.environmentId, member.id))
        .length,
  );
  const [confirming, setConfirming] = useState(false);
  const [removing, setRemoving] = useState(false);
  const device = presence.isPrimary ? "this device" : presence.label;
  const removal = describeProjectRemoval({
    name: member.name,
    cwd: member.cwd,
    environmentLabel: presence.isPrimary ? null : presence.label,
    threadCount,
  });

  const remove = async () => {
    setRemoving(true);
    // Decided before the delete: its shell event can land before the reply.
    const leave = nav.planCheckoutRemoval();
    try {
      await removeProjectCheckout(member, { force: threadCount > 0 });
      setConfirming(false);
      leave();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: `Failed to remove "${member.name}"`,
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setRemoving(false);
    }
  };

  return (
    <ProjectSection section="danger" tone="danger">
      <SettingsRow
        title={`Remove from ${device}`}
        description={
          threadCount > 0
            ? `Deletes its ${threadCount} thread${threadCount === 1 ? "" : "s"} and their history. Files on disk are not touched.`
            : "Removes the project entry. Files on disk are not touched."
        }
        control={
          <Button
            size="sm"
            variant="destructive-outline"
            disabled={!canEdit}
            onClick={() => setConfirming(true)}
          >
            Remove project
          </Button>
        }
      />
      <AlertDialog open={confirming} onOpenChange={(open) => !removing && setConfirming(open)}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>{removal.title}</AlertDialogTitle>
            <AlertDialogDescription render={<div />} className="grid gap-1">
              {removal.lines.map((line) => (
                <span
                  key={line}
                  className={line.startsWith("Path:") ? "font-mono text-[11px]" : undefined}
                >
                  {line}
                </span>
              ))}
              <span>Files on disk are not touched.</span>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />} disabled={removing}>
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={removing} onClick={() => void remove()}>
              {removing ? "Removing…" : "Remove project"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ProjectSection>
  );
}
