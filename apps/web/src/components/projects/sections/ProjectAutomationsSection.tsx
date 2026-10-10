import { AutomationsSummary } from "../../automations/AutomationsSummary";
import { ProjectSection } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

/** Scheduled agent runs for this checkout, said in one line; the Automations dialog edits them. */
export function ProjectAutomationsSection({ member }: ProjectSectionProps) {
  return (
    <ProjectSection
      section="automations"
      description="Schedule a task, approve each occurrence, then follow its thread. The device must be running when work is due."
    >
      <AutomationsSummary environmentId={member.environmentId} projectId={member.id} />
    </ProjectSection>
  );
}
