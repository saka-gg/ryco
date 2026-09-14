import type { MenuAction } from "@react-native-menu/menu";

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
    const candidates = action.subactions?.map((child) => ({
      ...child,
      subtitle: child.subtitle ?? action.title,
      attributes: {
        ...child.attributes,
        disabled: action.attributes?.disabled || child.attributes?.disabled,
      },
    })) ?? [action];
    return candidates.filter(
      (candidate) =>
        !candidate.attributes?.hidden &&
        `${candidate.title} ${candidate.subtitle ?? ""}`.toLocaleLowerCase().includes(normalized),
    );
  });
}
