import { usePullRequestsPage } from "./PullRequestsPageContext";
import { usePullRequestsLayoutStore } from "./pullRequestsLayoutStore";
import { usePullRequestsShortcut } from "./pullRequestsShortcuts";
import { PullRequestShortcutsDialog } from "./PullRequestShortcutsDialog";

/**
 * Page-wide keys that work whatever is on screen (the empty reader, Files,
 * a hidden list). Areas register their own keys and win while mounted (Files
 * claims J/K on its tab; a mounted list claims `/` to focus its field); these
 * are the defaults underneath, plus the shortcuts dialog (`?`, the bar menu).
 */
export function PullRequestsPageShortcuts() {
  const { nav, layout } = usePullRequestsPage();
  const shortcutsOpen = usePullRequestsLayoutStore((state) => state.shortcutsOpen);
  const setShortcutsOpen = usePullRequestsLayoutStore((state) => state.setShortcutsOpen);
  usePullRequestsShortcut("j", () => nav.stepPullRequest(1));
  usePullRequestsShortcut("k", () => nav.stepPullRequest(-1));
  usePullRequestsShortcut("shift+j", () => nav.stepPullRequest(1));
  usePullRequestsShortcut("shift+k", () => nav.stepPullRequest(-1));
  usePullRequestsShortcut("[", () => nav.stepStackLayer(-1));
  usePullRequestsShortcut("]", () => nav.stepStackLayer(1));
  usePullRequestsShortcut("\\", () => layout.toggleList());
  // No list is mounted (hidden, or the drawer is closed): bring it back, and
  // the pane that mounts focuses its search field.
  usePullRequestsShortcut("/", () => {
    if (layout.listVisible || layout.listFillsPage) return false;
    usePullRequestsLayoutStore.getState().requestSearchFocus();
    if (layout.listDocked) usePullRequestsLayoutStore.getState().setListHidden(false);
    else layout.openDrawer();
  });
  usePullRequestsShortcut("?", () => setShortcutsOpen(true));
  return <PullRequestShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />;
}
