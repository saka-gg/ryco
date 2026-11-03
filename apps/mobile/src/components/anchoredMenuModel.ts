import type { MenuAction } from "@react-native-menu/menu";

// A nested submenu folds part of its parent's list (a provider's legacy
// models), so a search lists its leaves in place of the fold.
function searchCandidates(
  children: readonly MenuAction[],
  root: MenuAction,
  disabled: boolean | undefined,
): MenuAction[] {
  return children.flatMap((child) => {
    const childDisabled = disabled || child.attributes?.disabled;
    if (child.subactions?.length && !child.attributes?.hidden)
      return searchCandidates(child.subactions, root, childDisabled);
    return [
      {
        ...child,
        subtitle: child.subtitle ?? root.title,
        attributes: { ...child.attributes, disabled: childDisabled },
      },
    ];
  });
}

/** Search across providers; retain each result's identity and disabled state. */
export function filterAnchoredMenuActions(
  actions: readonly MenuAction[],
  submenu: readonly MenuAction[] | undefined,
  query: string,
): readonly MenuAction[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return (submenu ?? actions).filter((action) => !action.attributes?.hidden);
  return actions.flatMap((action) => {
    if (action.attributes?.hidden) return [];
    const candidates = action.subactions
      ? searchCandidates(action.subactions, action, action.attributes?.disabled)
      : [action];
    return candidates.filter(
      (candidate) =>
        !candidate.attributes?.hidden &&
        `${candidate.title} ${candidate.subtitle ?? ""}`.toLocaleLowerCase().includes(normalized),
    );
  });
}

/**
 * The current version of the submenu `path` leads to. Each level is looked up
 * by id among its parent's current actions, so checkmarks and disabled states
 * stay fresh at every depth; a level that is gone keeps the snapshot taken
 * when it opened.
 */
export function resolveAnchoredMenuParent(
  actions: readonly MenuAction[],
  path: readonly MenuAction[],
): MenuAction | null {
  let parent: MenuAction | null = null;
  let level = actions;
  for (const step of path) {
    parent = level.find((action) => action.id === step.id) ?? step;
    level = parent.subactions ?? [];
  }
  return parent;
}
