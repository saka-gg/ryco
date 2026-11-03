/**
 * The workspace tools that can occupy the regular-width inspector column.
 * Exactly one is shown at a time: the focused route's own tool.
 */
export type ThreadWorkspaceInspectorKind = "files" | "terminal";

export interface OwnedThreadWorkspaceInspector<T> {
  readonly owner: symbol;
  readonly kind: ThreadWorkspaceInspectorKind;
  readonly value: T;
}

/**
 * Release a registration only when its owner still holds the column.
 *
 * Focus moves between native routes in both orders (the next route can focus
 * before the previous one's cleanup runs), so a stale cleanup must never clear
 * the inspector that replaced it.
 */
export function releaseOwnedThreadWorkspaceInspector<T>(
  current: OwnedThreadWorkspaceInspector<T> | null,
  owner: symbol,
): OwnedThreadWorkspaceInspector<T> | null {
  return current?.owner === owner ? null : current;
}
