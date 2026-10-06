import type { PullRequestsTab } from "./pullRequestsSearch";

// The handoff itself is shared with the projects page.
export {
  handOffPageFocus,
  takePageFocusHandoff,
  useHandOffFocusOnUnmount,
} from "../../hooks/usePageFocusHandoff";

export const READER_TAB_SELECTOR_ATTRIBUTE = "data-pr-reader-tab";

/** The reader bar's button for `tab`, inside `root` (default: the document). */
export function readerTabButton(
  tab: PullRequestsTab | null,
  root: ParentNode = document,
): HTMLElement | null {
  const selector =
    tab === null
      ? `[${READER_TAB_SELECTOR_ATTRIBUTE}] [role="tab"][aria-selected="true"]`
      : `[${READER_TAB_SELECTOR_ATTRIBUTE}] [role="tab"][data-sliding-tab-id="${tab}"]`;
  return root.querySelector<HTMLElement>(selector);
}
