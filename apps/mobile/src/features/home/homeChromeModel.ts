// Numbers of the lists' bottom chrome, kept pure so they are testable without
// a React Native renderer.

/** The floating bar height the undo notice clears (`SidebarUndoNoticeHost`). */
export const HOME_TOOLBAR_HEIGHT = 56;
export const HOME_TOOLBAR_INSET = 12;

/** Safe-area, toolbar, and breathing room for the last list row outside the tabs. */
export const HOME_LIST_PADDING_BOTTOM = 124;

/** Room a tab's last list row keeps above the floating New task button. */
export const FLOATING_ACTION_CLEARANCE = 76;

/**
 * Bottom padding of a list: inside a tab, the tab bar's inset plus room for
 * the floating button; elsewhere, room for the bottom chrome.
 */
export function listBottomPadding(contentInsets: { readonly bottom: number } | undefined): number {
  return contentInsets === undefined
    ? HOME_LIST_PADDING_BOTTOM
    : contentInsets.bottom + FLOATING_ACTION_CLEARANCE;
}
