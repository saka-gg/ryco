import type { SidebarProjectGroupMember } from "../../../sidebarProjectGrouping";
import type { ProjectSection } from "../projectsSearch";

/** Props every section of a project's page takes. */
export interface ProjectSectionProps {
  /** The scoped checkout (the project on one device) the section edits. */
  readonly member: SidebarProjectGroupMember;
  /**
   * Orchestration writes (`project.meta.update`, avatar, scripts, delete) are
   * allowed: the hosted capability holds and the checkout's device is
   * reachable. The reason when not is shown once, under the hero.
   */
  readonly canEdit: boolean;
  /**
   * The device's own settings for this project can change (owner only). When
   * not, sections leave those editors out; the page says why once.
   */
  readonly canManageNode: boolean;
}

/** DOM id of a section, so deep links and the section navigation can find it. */
export function projectSectionId(section: ProjectSection): string {
  return `project-section-${section}`;
}

export const PROJECT_SECTION_LABELS: Record<ProjectSection, string> = {
  devices: "Devices",
  location: "Location",
  repository: "Repository",
  workspaces: "Workspaces",
  defaults: "New threads",
  actions: "Actions",
  instructions: "Agent instructions",
  automations: "Automations",
  integrations: "Jira & Bitbucket",
  danger: "Danger zone",
};

/**
 * How the section navigation groups the page: the project itself, how agents
 * work in it, what it connects to, and removal on its own.
 */
export const PROJECT_SECTION_GROUPS: ReadonlyArray<{
  readonly label: string | null;
  readonly sections: readonly ProjectSection[];
}> = [
  { label: "Project", sections: ["devices", "location", "repository", "workspaces"] },
  { label: "Agents", sections: ["defaults", "actions", "instructions", "automations"] },
  { label: "Integrations", sections: ["integrations"] },
  { label: null, sections: ["danger"] },
];

/**
 * Which sections a checkout shows. Node-owned settings (new-thread defaults,
 * the Atlassian link) need the device owner; everyone else never sees an
 * editor they cannot use.
 */
export function visibleProjectSections(input: {
  readonly canManageNode: boolean;
}): readonly ProjectSection[] {
  return PROJECT_SECTION_GROUPS.flatMap((group) => group.sections).filter(
    (section) => input.canManageNode || (section !== "defaults" && section !== "integrations"),
  );
}
