import { FolderOpenIcon } from "lucide-react";
import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../../environments/primary";
import { readLocalApi } from "../../../localApi";
import { updateProjectMeta } from "../../../projectMutations";
import { SettingsRow } from "../../settings/settingsLayout";
import { WorktreeRootSettings } from "../../settings/WorktreeRootSettings";
import { WorktreeSubmoduleSettings } from "../../settings/WorktreeSubmoduleSettings";
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
import { Input } from "../../ui/input";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { useEnvironmentPresence } from "../useEnvironmentPresence";
import { ProjectNodeSettingsScope, useEnvironmentProjectChoices } from "./ProjectNodeSettingsScope";
import { ProjectSection, useSavedFlash } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

/**
 * Where the checkout lives on its device, and where its worktrees go. Moving
 * the root re-points the project; the files themselves are not moved.
 */
export function ProjectLocationSection({ member, canEdit, canManageNode }: ProjectSectionProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const presence = useEnvironmentPresence(member.environmentId);
  const saved = useSavedFlash();
  const projects = useEnvironmentProjectChoices(member.environmentId);
  const [draft, setDraft] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const value = draft ?? member.cwd;
  const nextRoot = value.trim();
  const changed = nextRoot.length > 0 && nextRoot !== member.cwd;
  // The folder picker browses this machine, so it only fits checkouts on it.
  const canBrowse =
    member.environmentId === primaryEnvironmentId &&
    typeof window !== "undefined" &&
    window.desktopBridge !== undefined;

  const browse = async () => {
    const picked = await readLocalApi()?.dialogs.pickFolder({
      initialPath: nextRoot || member.cwd,
    });
    if (picked) setDraft(picked);
  };

  const move = async () => {
    setSaving(true);
    try {
      await updateProjectMeta(member, { workspaceRoot: nextRoot });
      setDraft(null);
      setConfirming(false);
      saved.flash();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to change the project root",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProjectSection
      section="location"
      description={`Where the project lives on ${presence.isPrimary ? "this device" : presence.label}, and where its worktrees go.`}
      savedToken={saved.token}
    >
      <SettingsRow
        title="Project root"
        description="The folder threads in this project run in. Changing it re-points the project; nothing on disk moves."
      >
        <form
          className="flex min-w-0 flex-col gap-2 @[36rem]/detail:flex-row"
          onSubmit={(event) => {
            event.preventDefault();
            if (changed && canEdit) setConfirming(true);
          }}
        >
          <Input
            aria-label="Project root"
            value={value}
            disabled={!canEdit}
            spellCheck={false}
            className="min-w-0 flex-1 font-mono text-xs"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && draft !== null) {
                event.preventDefault();
                setDraft(null);
              }
            }}
          />
          <div className="flex shrink-0 gap-2">
            {canBrowse ? (
              <Button
                type="button"
                variant="outline"
                disabled={!canEdit}
                onClick={() => void browse()}
              >
                <FolderOpenIcon className="size-3.5" />
                Browse
              </Button>
            ) : null}
            <Button type="submit" variant="outline" disabled={!canEdit || !changed}>
              Move
            </Button>
          </div>
        </form>
      </SettingsRow>
      {canManageNode ? (
        <ProjectNodeSettingsScope environmentId={member.environmentId}>
          <WorktreeRootSettings projectId={member.id} projects={projects} />
          <WorktreeSubmoduleSettings projectId={member.id} projects={projects} />
        </ProjectNodeSettingsScope>
      ) : null}

      <AlertDialog open={confirming} onOpenChange={(open) => !saving && setConfirming(open)}>
        <AlertDialogPopup className="max-w-md">
          <AlertDialogHeader>
            <AlertDialogTitle>Change the project root?</AlertDialogTitle>
            <AlertDialogDescription>
              New threads and worktrees start from the new folder. Existing threads keep their
              history; files are not moved.
            </AlertDialogDescription>
            <div className="mt-1 grid gap-1 text-left font-mono text-[11px] text-muted-foreground">
              <span
                className="truncate line-through decoration-muted-foreground/50"
                title={member.cwd}
              >
                {member.cwd}
              </span>
              <span className="truncate text-foreground" title={nextRoot}>
                {nextRoot}
              </span>
            </div>
          </AlertDialogHeader>
          <AlertDialogFooter variant="bare">
            <AlertDialogClose render={<Button variant="outline" />} disabled={saving}>
              Cancel
            </AlertDialogClose>
            <Button disabled={saving} onClick={() => void move()}>
              {saving ? "Moving…" : "Change root"}
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </ProjectSection>
  );
}
