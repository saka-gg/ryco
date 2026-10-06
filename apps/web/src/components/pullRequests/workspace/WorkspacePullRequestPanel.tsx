import type { EnvironmentId } from "@ryco/contracts";
import { useNavigate } from "@tanstack/react-router";
import { GitPullRequestIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useElementWidth } from "../../../hooks/useElementWidth";
import { useEvent } from "../../../hooks/useEvent";
import { useLogicalProjectSnapshots } from "../../../hooks/useLogicalProjectSnapshots";
import { buildPullRequestLocation } from "../../../pullRequestsRoute";
import type { Project } from "../../../types";
import { Button } from "../../ui/button";
import { PullRequestReader } from "../PullRequestReader";
import {
  PullRequestsPageContext,
  type PullRequestSelectionMotion,
  type PullRequestsLayout,
  type PullRequestsNavigation,
  type PullRequestsPageContextValue,
  type PullRequestsSurface,
  usePullRequestsPage,
} from "../PullRequestsPageContext";
import {
  buildPullRequestRepositoryOptions,
  pullRequestRepositoryKey,
  type PullRequestRepositoryOption,
} from "../pullRequestRepositories.logic";
import { pullRequestReaderKey } from "../pullRequestsLayoutStore";
import { createPullRequestsNavigation } from "../pullRequestsNavigation";
import { resolvePullRequestsTab, type PullRequestsSearch } from "../pullRequestsSearch";
import { PullRequestsShortcutsProvider, usePullRequestsShortcut } from "../pullRequestsShortcuts";
import { usePullRequestsLayout } from "../usePullRequestsLayout";
import { usePullRequestsModel } from "../usePullRequestsModel";

/**
 * A thread's change request inside its workspace panel: the pull requests
 * page's reader (Conversation, Files, Checks, Commits, the facts and the
 * review flow) without the list. The page keeps the reader's state in its
 * URL; here the thread route only names the change request
 * (`workspacePr`, else the thread's own), and the reader's tab, revealed
 * file, thread or job live per change request for the session, so switching
 * workspace tabs and back resumes where the user was.
 */

type ReaderSearch = Omit<PullRequestsSearch, "env" | "project" | "pr">;

const readerSearchByKey = new Map<string, ReaderSearch>();

function readerFields(search: PullRequestsSearch): ReaderSearch {
  const { env: _env, project: _project, pr: _pr, ...rest } = search;
  return Object.fromEntries(
    Object.entries(rest).filter(([, value]) => value !== undefined),
  ) as ReaderSearch;
}

const NO_SELECTION_MOTION: PullRequestSelectionMotion = { kind: "none", token: 0 };

/** No list means no drawer: the page's drawer state must stay untouched. */
const NO_DRAWER: Partial<PullRequestsLayout> = {
  drawerOpen: false,
  toggleList: () => undefined,
  openDrawer: () => undefined,
  closeDrawer: () => undefined,
};

export interface WorkspacePullRequestPanelProps {
  readonly environmentId: EnvironmentId | null;
  readonly project: Pick<Project, "id" | "name" | "cwd" | "customAvatarContentHash"> | null;
  /** The change request to read: the route's pinned one, else the thread's. */
  readonly number: number | null;
  /** The thread's change request is still being looked up. */
  readonly resolving: boolean;
  /** Pin another change request (a stack layer) on the thread route. */
  readonly onSelectNumber: (number: number) => void;
  /** `\` toggles the workspace's pull request switcher (absent: no switcher). */
  readonly onTogglePullRequests?: (() => void) | undefined;
  /** The empty state offers "Link pull request…" (absent: linking is unavailable). */
  readonly onLinkPullRequest?: ((anchor: HTMLElement) => void) | undefined;
}

export default function WorkspacePullRequestPanel(props: WorkspacePullRequestPanelProps) {
  const { environmentId, project, number } = props;
  // The same option the page builds, so per-repository state (merge method,
  // hand-off drafts, reader state) is shared with it. Snapshots can trail the
  // thread's project for a moment; a provisional option keeps the reader up.
  const { snapshots } = useLogicalProjectSnapshots();
  const repository = useMemo<PullRequestRepositoryOption | null>(() => {
    if (!environmentId || !project) return null;
    const key = pullRequestRepositoryKey(environmentId, project.id);
    return (
      buildPullRequestRepositoryOptions(snapshots).find((option) => option.key === key) ?? {
        key,
        environmentId,
        projectId: project.id,
        cwd: project.cwd,
        name: project.name,
        environmentLabel: null,
        customAvatarContentHash: project.customAvatarContentHash ?? null,
        repositoryKey: key,
        isRepresentative: true,
      }
    );
  }, [environmentId, project, snapshots]);

  if (!repository || number === null) {
    return (
      <WorkspacePullRequestEmptyState
        resolving={props.resolving && repository !== null}
        onLinkPullRequest={props.onLinkPullRequest}
      />
    );
  }
  return (
    <WorkspacePullRequestReader
      key={pullRequestReaderKey(repository.key, number)}
      repository={repository}
      number={number}
      onSelectNumber={props.onSelectNumber}
      onTogglePullRequests={props.onTogglePullRequests}
    />
  );
}

function WorkspacePullRequestReader(props: {
  readonly repository: PullRequestRepositoryOption;
  readonly number: number;
  readonly onSelectNumber: (number: number) => void;
  readonly onTogglePullRequests?: (() => void) | undefined;
}) {
  const { repository, number } = props;
  const readerKey = pullRequestReaderKey(repository.key, number);
  const [reader, setReader] = useState<ReaderSearch>(() => readerSearchByKey.get(readerKey) ?? {});
  const search = useMemo<PullRequestsSearch>(() => ({ ...reader, pr: number }), [number, reader]);
  const tab = resolvePullRequestsTab(search);
  const model = usePullRequestsModel({ repository, search, includeList: false });

  const rootRef = useRef<HTMLDivElement>(null);
  const width = useElementWidth(rootRef, 480);
  const layout = usePullRequestsLayout({
    pageWidth: width,
    hasSelection: true,
    tab,
    listless: true,
    overrides: NO_DRAWER,
  });

  const [selectionMotion, setSelectionMotion] =
    useState<PullRequestSelectionMotion>(NO_SELECTION_MOTION);
  const getSearch = useEvent(() => search);
  const getModel = useEvent(() => model);
  const onSelectNumber = useEvent(props.onSelectNumber);
  const commit = useEvent((next: PullRequestsSearch) => {
    const fields = readerFields(next);
    if (next.pr !== undefined && next.pr !== number) {
      // Another change request (a stack layer): it mounts its own reader.
      readerSearchByKey.set(pullRequestReaderKey(repository.key, next.pr), fields);
      onSelectNumber(next.pr);
      return;
    }
    readerSearchByKey.set(readerKey, fields);
    setReader(fields);
  });
  const actions = useMemo(
    () =>
      createPullRequestsNavigation({
        getSearch,
        getModel,
        getRepositoryParams: () => ({}),
        commit,
        setSelectionMotion,
        closeDrawer: () => undefined,
        // Layer pushes run router view transitions; this panel has no route of its own.
        canRunPushTransition: () => false,
      }),
    [commit, getModel, getSearch],
  );
  const nav = useMemo<PullRequestsNavigation>(
    () => ({ search, tab, ...actions }),
    [actions, search, tab],
  );

  const navigate = useNavigate();
  const openOnPage = useEvent(() => {
    void navigate(
      buildPullRequestLocation({
        environmentId: repository.environmentId,
        projectId: repository.projectId,
        number,
        tab,
      }),
    );
  });
  const surface = useMemo<PullRequestsSurface>(
    () => ({ kind: "workspace", openOnPage }),
    [openOnPage],
  );

  const value = useMemo<PullRequestsPageContextValue>(
    () => ({
      surface,
      repository,
      repositoryStatus: { kind: "ready" },
      repositories: [repository],
      model,
      nav,
      layout,
      selectionMotion,
      readerKey,
    }),
    [layout, model, nav, readerKey, repository, selectionMotion, surface],
  );

  return (
    <PullRequestsPageContext.Provider value={value}>
      <PullRequestsShortcutsProvider tab={tab} enabled scope={rootRef}>
        <WorkspacePullRequestShortcuts onTogglePullRequests={props.onTogglePullRequests} />
        {/* Focusable so a click on plain reader content keeps its keys in scope. */}
        <div
          ref={rootRef}
          tabIndex={-1}
          data-slot="workspace-pull-request"
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background text-foreground outline-none"
        >
          {model.selection ? <PullRequestReader /> : null}
        </div>
      </PullRequestsShortcutsProvider>
    </PullRequestsPageContext.Provider>
  );
}

/**
 * The page-wide stack keys that still make sense for one change request, and
 * `\` for the workspace's pull requests (on the page it toggles the list).
 */
function WorkspacePullRequestShortcuts(props: {
  readonly onTogglePullRequests?: (() => void) | undefined;
}) {
  const { nav } = usePullRequestsPage();
  const toggle = props.onTogglePullRequests;
  usePullRequestsShortcut("[", () => nav.stepStackLayer(-1));
  usePullRequestsShortcut("]", () => nav.stepStackLayer(1));
  usePullRequestsShortcut("\\", () => toggle?.(), { enabled: toggle !== undefined });
  return null;
}

function WorkspacePullRequestEmptyState(props: {
  readonly resolving: boolean;
  readonly onLinkPullRequest?: ((anchor: HTMLElement) => void) | undefined;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
      <div className="max-w-64">
        <GitPullRequestIcon aria-hidden className="mx-auto size-5 text-muted-foreground/60" />
        <p className="mt-3 text-sm font-medium text-foreground">
          {props.resolving ? "Looking for this thread's pull request…" : "No pull request yet"}
        </p>
        {props.resolving ? null : (
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            Once this thread's branch has an open pull request, it opens here.
          </p>
        )}
        {!props.resolving && props.onLinkPullRequest ? (
          <Button
            variant="outline"
            size="sm"
            className="mt-3"
            onClick={(event) => props.onLinkPullRequest?.(event.currentTarget)}
          >
            Link pull request…
          </Button>
        ) : null}
      </div>
    </div>
  );
}
