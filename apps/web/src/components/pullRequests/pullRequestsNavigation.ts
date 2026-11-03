import type { CrossRepositoryListModel } from "./crossRepository/crossRepositoryList.logic";
import type { PullRequestSelectionMotion, PullRequestsNavigation } from "./PullRequestsPageContext";
import {
  resolvePullRequestsTab,
  selectPullRequestSearch,
  type PullRequestsSearch,
} from "./pullRequestsSearch";
import type { PullRequestsModel } from "./usePullRequestsModel";

/**
 * The page's navigation rules, shared by `PullRequestsPage` (router-backed)
 * and the test provider (in-memory), so tests exercise exactly what the page
 * runs. The URL is the single source of truth: every method computes the next
 * search and hands it to `commit`.
 */

export type PullRequestsNavigationActions = Omit<PullRequestsNavigation, "search" | "tab">;

export interface PullRequestsNavigationDeps {
  readonly getSearch: () => PullRequestsSearch;
  readonly getModel: () => Pick<PullRequestsModel, "list" | "selection">;
  /** `env`/`project` of the page's repository, stamped on every selection. */
  readonly getRepositoryParams: () => Pick<PullRequestsSearch, "env" | "project">;
  readonly commit: (
    next: PullRequestsSearch,
    options: {
      /** Push a history entry; otherwise replace. */
      readonly push: boolean;
      /** Run the navigation as a typed view transition (stack layer push). */
      readonly viewTransitionTypes?: ReadonlyArray<string>;
    },
  ) => void;
  readonly setSelectionMotion: (motion: PullRequestSelectionMotion) => void;
  readonly closeDrawer: () => void;
  /** The View Transitions API exists and pane motion is not reduced. */
  readonly canRunPushTransition: () => boolean;
  /**
   * Called on every `revealJob`, before the URL changes: a repeat reveal of
   * the same job leaves the URL as it was, so the surface counts reveals
   * (`jobRevealToken`) for the Checks tab to land again.
   */
  readonly onRevealJob?: () => void;
  /**
   * All repositories' rows (`ordered` for J/K, `byKey` to select one, the selected key);
   * null or absent on one repository's list.
   */
  readonly getCrossRepositoryRows?: () => Pick<
    CrossRepositoryListModel,
    "ordered" | "byKey" | "selectedKey"
  > | null;
  /** Remembers All repositories (`all`) or one repository (`null`) for the next visit. */
  readonly rememberScope?: (scope: "all" | null) => void;
  /** Opens a row whose repository is not in Ryco on its host. */
  readonly openExternal?: (url: string) => void;
  readonly now?: () => number;
}

/**
 * How the reader moves for a selection change. Layer moves push (vertical,
 * whole body) except on Files, where a ghost of the diff would be both costly
 * and noisy, so Files settles like any other move (spec motion #3 → #2).
 */
export function derivePullRequestSelectionMotion(input: {
  readonly current: PullRequestsSearch;
  readonly pr: number | undefined;
  readonly via: "list" | "stack" | "link" | undefined;
  readonly model: Pick<PullRequestsModel, "list" | "selection">;
  readonly token: number;
}): PullRequestSelectionMotion {
  const { current, pr, via, model, token } = input;
  const stack = model.selection?.detail.data?.stack;
  const target = stack?.entries.find((entry) => entry.number === pr);
  if (
    via === "stack" &&
    stack &&
    target &&
    pr !== current.pr &&
    resolvePullRequestsTab(current) !== "files"
  ) {
    const selection = model.selection;
    const fromTitle = selection?.detail.data?.title ?? selection?.summary?.title;
    return {
      kind: "push",
      direction: target.position > stack.position ? 1 : -1,
      token,
      ...(selection && fromTitle ? { from: { number: selection.number, title: fromTitle } } : {}),
    };
  }
  if (pr !== undefined && current.pr !== undefined && pr !== current.pr) {
    const from = model.list.ordered.findIndex((entry) => entry.number === current.pr);
    const to = model.list.ordered.findIndex((entry) => entry.number === pr);
    return {
      kind: "settle",
      direction: from === -1 || to === -1 ? 0 : to > from ? 1 : -1,
      token,
    };
  }
  return { kind: "settle", direction: 0, token };
}

export function createPullRequestsNavigation(
  deps: PullRequestsNavigationDeps,
): PullRequestsNavigationActions {
  const now = deps.now ?? Date.now;
  const replace = (next: PullRequestsSearch) => deps.commit(next, { push: false });

  const selectPullRequest: PullRequestsNavigation["selectPullRequest"] = (pr, options) => {
    // Choosing anything in the drawer (even the row already open) dismisses it.
    deps.closeDrawer();
    const current = deps.getSearch();
    if (pr === current.pr && options?.tab === undefined) return;
    const motion = derivePullRequestSelectionMotion({
      current,
      pr,
      via: options?.via,
      model: deps.getModel(),
      token: now(),
    });
    deps.setSelectionMotion(motion);
    const pushTransition =
      motion.kind === "push" && deps.canRunPushTransition()
        ? [motion.direction === 1 ? "pr-push-up" : "pr-push-down"]
        : undefined;
    deps.commit(
      {
        ...selectPullRequestSearch(current, pr, options?.tab),
        ...(pr === undefined ? {} : deps.getRepositoryParams()),
      },
      {
        push: options?.push ?? false,
        ...(pushTransition ? { viewTransitionTypes: pushTransition } : {}),
      },
    );
  };

  const selectCrossRepositoryRow: PullRequestsNavigation["selectCrossRepositoryRow"] = (
    rowKey,
    options,
  ) => {
    deps.closeDrawer();
    const rows = deps.getCrossRepositoryRows?.() ?? null;
    const row = rows?.byKey.get(rowKey);
    if (!rows || !row) return;
    if (row.checkout === null) {
      deps.openExternal?.(row.url);
      return;
    }
    if (rows.selectedKey === rowKey) return;
    const current = deps.getSearch();
    const from =
      rows.selectedKey === null
        ? -1
        : rows.ordered.findIndex((entry) => entry.rowKey === rows.selectedKey);
    const to = rows.ordered.findIndex((entry) => entry.rowKey === rowKey);
    deps.setSelectionMotion({
      kind: "settle",
      direction: from === -1 || to === -1 ? 0 : to > from ? 1 : -1,
      token: now(),
    });
    deps.commit(
      {
        ...selectPullRequestSearch(current, row.number),
        scope: "all",
        env: row.checkout.environmentId,
        project: row.checkout.projectId,
        // A link (pasted, or `#123`) was typed into the search; it goes with the selection.
        ...(options?.via === "link" ? { q: undefined } : {}),
      },
      { push: options?.push ?? false },
    );
  };

  return {
    setSearch: (patch, options) =>
      deps.commit({ ...deps.getSearch(), ...patch }, { push: options?.push ?? false }),
    selectPullRequest,
    selectCrossRepositoryRow,
    stepPullRequest: (offset) => {
      const cross = deps.getCrossRepositoryRows?.() ?? null;
      if (cross) {
        const rows = cross.ordered;
        if (rows.length === 0) return;
        const index =
          cross.selectedKey === null
            ? -1
            : rows.findIndex((entry) => entry.rowKey === cross.selectedKey);
        const nextIndex =
          index === -1
            ? offset === 1
              ? 0
              : rows.length - 1
            : Math.min(rows.length - 1, Math.max(0, index + offset));
        const nextRow = rows[nextIndex];
        if (nextRow && nextRow.rowKey !== cross.selectedKey) {
          selectCrossRepositoryRow(nextRow.rowKey, { via: "list" });
        }
        return;
      }
      const ordered = deps.getModel().list.ordered;
      if (ordered.length === 0) return;
      const currentPr = deps.getSearch().pr;
      const index = ordered.findIndex((entry) => entry.number === currentPr);
      const nextIndex =
        index === -1
          ? offset === 1
            ? 0
            : ordered.length - 1
          : Math.min(ordered.length - 1, Math.max(0, index + offset));
      const next = ordered[nextIndex];
      if (next && next.number !== currentPr) selectPullRequest(next.number, { via: "list" });
    },
    stepStackLayer: (offset) => {
      const stack = deps.getModel().selection?.detail.data?.stack;
      if (!stack) return;
      const target = stack.entries.find((entry) => entry.position === stack.position + offset);
      if (target) selectPullRequest(target.number, { via: "stack" });
    },
    setTab: (nextTab) => {
      const current = deps.getSearch();
      if (resolvePullRequestsTab(current) === nextTab) return;
      replace({
        ...current,
        tab: nextTab === "conversation" ? undefined : nextTab,
        ...(nextTab === "checks" ? {} : { job: undefined }),
      });
    },
    revealThread: (threadId) => {
      const current = deps.getSearch();
      const selection = deps.getModel().selection;
      const thread = selection?.activity.data?.reviewThreads.find((entry) => entry.id === threadId);
      const anchored =
        thread !== undefined &&
        (selection?.threads.anchoredByPath.get(thread.path) ?? []).some(
          (entry) => entry.thread.id === threadId,
        );
      replace(
        anchored && thread
          ? {
              ...current,
              tab: "files",
              file: thread.path,
              thread: threadId,
              line: undefined,
              side: undefined,
              commit: undefined,
            }
          : { ...current, tab: undefined, thread: threadId },
      );
    },
    // Callers (pending-comment jumps, log `path:line` links) point at the
    // whole change request's diff; a commit scope would hide drafts and
    // resolve the line against the wrong version of the file.
    revealFile: (path, line, side) =>
      replace({
        ...deps.getSearch(),
        tab: "files",
        file: path,
        line,
        side: line === undefined ? undefined : side,
        thread: undefined,
        commit: undefined,
      }),
    revealJob: (jobId) => {
      deps.onRevealJob?.();
      replace({ ...deps.getSearch(), tab: "checks", job: jobId });
    },
    scopeToCommit: (sha) =>
      replace({
        ...deps.getSearch(),
        tab: "files",
        commit: sha,
        file: undefined,
        line: undefined,
        side: undefined,
        thread: undefined,
      }),
    selectRepository: (option) => {
      const current = deps.getSearch();
      deps.rememberScope?.(null);
      deps.commit(
        {
          env: option.environmentId,
          project: option.projectId,
          ...(current.state ? { state: current.state } : {}),
          ...(current.sort ? { sort: current.sort } : {}),
        },
        { push: true },
      );
    },
    showAllRepositories: () => {
      const current = deps.getSearch();
      deps.closeDrawer();
      deps.rememberScope?.("all");
      deps.commit(
        {
          scope: "all",
          ...(current.state ? { state: current.state } : {}),
          ...(current.only ? { only: current.only } : {}),
          ...(current.label ? { label: current.label } : {}),
          ...(current.sort ? { sort: current.sort } : {}),
        },
        { push: true },
      );
    },
  };
}
