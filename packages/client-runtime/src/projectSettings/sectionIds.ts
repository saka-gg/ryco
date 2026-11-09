// FILE: sectionIds.ts
// Purpose: The ids of a project page's sections, in page order: all the web's
//          boot path needs (its URL search parser). Labels and groups live in
//          `sections.ts`, with the screens that show them.
// Layer: Client runtime, pure.

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
