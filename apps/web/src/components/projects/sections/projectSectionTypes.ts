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

export {
  PROJECT_SECTION_GROUPS,
  PROJECT_SECTION_LABELS,
  visibleProjectSections,
} from "@ryco/client-runtime/projectSettings/sections";
