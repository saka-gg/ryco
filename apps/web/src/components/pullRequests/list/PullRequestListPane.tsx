import { useEffect, useRef } from "react";

import { useHandOffFocusOnUnmount } from "../pullRequestsFocus";
import { usePullRequestsLayoutStore } from "../pullRequestsLayoutStore";
import { usePullRequestsShortcut } from "../pullRequestsShortcuts";
import { ActiveFilterChips } from "./ActiveFilterChips";
import { ListHeader, type PullRequestListVariant } from "./ListHeader";
import { PullRequestInbox, type PullRequestInboxActions } from "./PullRequestInbox";
import { usePullRequestListSearch } from "./usePullRequestListSearch";

export { ListResizeHandle } from "./ListResizeHandle";

/**
 * The list column: one 52px bar (repository, search, filters) over the
 * grouped inbox. "docked" sits beside the reader, "drawer" is the sheet the
 * page opens below the docking breakpoint, and "fill" is the whole page when
 * nothing is selected on a narrow window (wider rows, more meta).
 */
export function PullRequestListPane(props: { readonly variant: PullRequestListVariant }) {
  const { variant } = props;
  const search = usePullRequestListSearch();
  const inputRef = useRef<HTMLInputElement>(null);
  const inboxRef = useRef<PullRequestInboxActions | null>(null);

  const focusSearch = () => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    input.select();
  };
  usePullRequestsShortcut("/", focusSearch);

  // `/` pressed while no list was mounted brought this pane in: focus its
  // field. Otherwise the drawer (a dialog; page shortcuts pause inside it)
  // starts on the rows so J/K, the arrows and Enter work at once. The sheet
  // moves focus to its first field when it opens, so wait for that first.
  useEffect(() => {
    const searchRequested = usePullRequestsLayoutStore.getState().consumeSearchFocus();
    if (!searchRequested && variant !== "drawer") return;
    const frame = requestAnimationFrame(() => {
      if (searchRequested) focusSearch();
      else inboxRef.current?.focusRows();
    });
    return () => cancelAnimationFrame(frame);
    // Runs once per mount: the request belongs to the pane that answers it.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [variant]);

  // The full-page list gives way to the reader when a row opens: hand focus
  // over so it continues there instead of falling to <body>.
  const rootRef = useRef<HTMLDivElement>(null);
  useHandOffFocusOnUnmount(rootRef);

  return (
    <div
      ref={rootRef}
      data-pr-list-pane={variant}
      className="pr-list-pane flex h-full min-h-0 min-w-0 flex-1 flex-col bg-(--pr-list-bg)"
    >
      <ListHeader
        variant={variant}
        search={search}
        inputRef={inputRef}
        onSubmit={() => inboxRef.current?.openFirst()}
        onFocusRows={() => inboxRef.current?.focusRows()}
      />
      <PullRequestInbox
        ref={inboxRef}
        variant={variant}
        search={search}
        onFocusSearch={focusSearch}
        header={<ActiveFilterChips />}
      />
    </div>
  );
}
