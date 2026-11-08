/**
 * The sections of a project's settings, in page order, with their labels and
 * groups. The web projects page and the phone's project settings list the same
 * sections under the same names; each surface leaves out what it cannot edit.
 */

/** Every section of a project's page, in page order. */
export const PROJECT_SECTIONS = [
  "devices",
  "location",
  "repository",
  "workspaces",
  "defaults",
  "actions",
  "instructions",
  "automations",
  "integrations",
  "danger",
] as const;
export type ProjectSection = (typeof PROJECT_SECTIONS)[number];

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
