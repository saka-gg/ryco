import { useSettingsDialogStore } from "../../../settingsDialogStore";
import { ProjectPreferenceSettings } from "../../settings/ProjectPreferenceSettings";
import { SettingsRow } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { ProjectNodeSettingsScope, useEnvironmentProjectChoices } from "./ProjectNodeSettingsScope";
import { ProjectSection } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

/**
 * How new threads in this project start: model and effort, local or
 * worktree, branch prefix, setup script. Each field overrides the device
 * default or follows it.
 */
export function ProjectNewThreadsSection({ member }: ProjectSectionProps) {
  const projects = useEnvironmentProjectChoices(member.environmentId);
  return (
    <ProjectSection
      section="defaults"
      description="Overrides for this project. Fields you don't change follow the device defaults."
    >
      <ProjectNodeSettingsScope environmentId={member.environmentId}>
        <ProjectPreferenceSettings projectId={member.id} projects={projects} />
      </ProjectNodeSettingsScope>
      <SettingsRow
        title="Device defaults"
        description="The defaults every project on this device starts from live in Settings."
        control={
          <Button
            size="sm"
            variant="ghost"
            onClick={() =>
              useSettingsDialogStore.getState().openSettings("general", member.environmentId)
            }
          >
            Open settings
          </Button>
        }
      />
    </ProjectSection>
  );
}
