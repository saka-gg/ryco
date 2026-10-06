import type { ComponentType } from "react";

import type { ProjectSection } from "../projectsSearch";
import { ProjectActionsSection } from "./ProjectActionsSection";
import { ProjectAtlassianSection } from "./ProjectAtlassianSection";
import { ProjectAutomationsSection } from "./ProjectAutomationsSection";
import { ProjectDangerSection } from "./ProjectDangerSection";
import { ProjectDevicesSection } from "./ProjectDevicesSection";
import { ProjectInstructionsSection } from "./ProjectInstructionsSection";
import { ProjectLocationSection } from "./ProjectLocationSection";
import { ProjectNewThreadsSection } from "./ProjectNewThreadsSection";
import { ProjectRepositorySection } from "./ProjectRepositorySection";
import type { ProjectSectionProps } from "./projectSectionTypes";
import { ProjectWorkspacesSection } from "./ProjectWorkspacesSection";

/** Every section of a project's page; the settings view and the map's project card render these. */
export const PROJECT_SECTION_COMPONENTS: Record<
  ProjectSection,
  ComponentType<ProjectSectionProps>
> = {
  devices: ProjectDevicesSection,
  location: ProjectLocationSection,
  repository: ProjectRepositorySection,
  workspaces: ProjectWorkspacesSection,
  defaults: ProjectNewThreadsSection,
  actions: ProjectActionsSection,
  instructions: ProjectInstructionsSection,
  automations: ProjectAutomationsSection,
  integrations: ProjectAtlassianSection,
  danger: ProjectDangerSection,
};
