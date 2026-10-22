import { ProjectCopyError } from "@ryco/contracts/project-copy";

/**
 * What the project copy placeholders answer until each service's live layer replaces them. The
 * node does not advertise `capabilities.projectCopy` meanwhile, so clients never call them.
 */
export const NOT_AVAILABLE_YET = "not available yet";

export const notAvailableYet = () =>
  new ProjectCopyError({ code: "internal", message: NOT_AVAILABLE_YET });
