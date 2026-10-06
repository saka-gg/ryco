import { AutomationCentre } from "../../automations/AutomationCentre";
import { ProjectSection } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

/** Scheduled agent runs scoped to this project; the centre owns its own controls. */
export function ProjectAutomationsSection({ member, canEdit }: ProjectSectionProps) {
  return (
    <ProjectSection
      section="automations"
      description="Schedule a task, approve each occurrence, then follow its thread. The device must be running when work is due."
      bare
    >
      <AutomationCentre
        environmentId={member.environmentId}
        projectId={member.id}
        embedded
        disabledReasonShownByHost={!canEdit}
      />
    </ProjectSection>
  );
}
