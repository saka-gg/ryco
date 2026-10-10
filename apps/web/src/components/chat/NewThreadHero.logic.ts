/**
 * Pure presentation logic for the empty-thread hero. Kept apart from the view
 * so the headline copy and the project-switch gating are unit-testable without
 * a DOM.
 */

/** How long a project name may grow before the headline elides it. */
export const NEW_THREAD_HERO_PROJECT_NAME_LIMIT = 42;

export interface NewThreadHeadline {
  /** Copy before the project name (empty when there is no project). */
  readonly prefix: string;
  /** The project name as rendered, already elided. Null hides the slot. */
  readonly projectName: string | null;
  /** Copy after the project name. */
  readonly suffix: string;
  /** Flat string for `aria-label` and tests. */
  readonly text: string;
}

function elideProjectName(projectName: string): string {
  const trimmed = projectName.trim();
  if (trimmed.length <= NEW_THREAD_HERO_PROJECT_NAME_LIMIT) {
    return trimmed;
  }
  return `${trimmed.slice(0, NEW_THREAD_HERO_PROJECT_NAME_LIMIT - 1).trimEnd()}…`;
}

/**
 * "What should we do in <project>?" — falling back to a project-less headline
 * when the thread has no resolvable project (unavailable environment, project
 * removed while the draft survived).
 */
export function resolveNewThreadHeadline(input: {
  readonly projectName: string | null | undefined;
}): NewThreadHeadline {
  const projectName = input.projectName?.trim();
  if (!projectName) {
    return {
      prefix: "What should we do?",
      projectName: null,
      suffix: "",
      text: "What should we do?",
    };
  }
  const elided = elideProjectName(projectName);
  return {
    prefix: "What should we do in ",
    projectName: elided,
    suffix: "?",
    text: `What should we do in ${elided}?`,
  };
}

/**
 * The headline's project name doubles as a project switcher, but only where
 * switching is meaningful and safe: draft threads (a server thread is already
 * bound to its project), before the thread is locked to an environment, and
 * when there is somewhere else to switch to. "No project" counts as a
 * destination wherever chats are available.
 */
export function canSwitchNewThreadProject(input: {
  readonly routeKind: "draft" | "server";
  readonly envLocked: boolean;
  /** Real projects only; chats are not projects. */
  readonly projectCount: number;
  readonly chatsAvailable?: boolean;
}): boolean {
  const destinations = input.projectCount + (input.chatsAvailable ? 1 : 0);
  return input.routeKind === "draft" && !input.envLocked && destinations > 1;
}

/**
 * "or start without a project" under the headline: a project draft that has
 * not been sent, on a node that can host chats.
 */
export function canStartNewThreadWithoutProject(input: {
  readonly routeKind: "draft" | "server";
  readonly envLocked: boolean;
  readonly chatsAvailable: boolean;
  readonly pendingChat: boolean;
}): boolean {
  return (
    input.routeKind === "draft" && !input.envLocked && input.chatsAvailable && !input.pendingChat
  );
}
