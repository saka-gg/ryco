import type { SelectedLineRange } from "@pierre/diffs";
import {
  buildSubmitReviewInput,
  diffSideToAnnotationSide,
  EMPTY_REVIEW_DRAFT,
  indexReviewThreads,
  selectReviewDraft,
  type ReviewDraftComment,
} from "@ryco/client-runtime/state/pull-request-review";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { useDiffFileNavigation } from "../../../hooks/useDiffFileNavigation";
import { useDiffLayout } from "../../../hooks/useDiffLayout";
import { useTheme } from "../../../hooks/useTheme";
import { cn } from "../../../lib/utils";
import { usePullRequestReviewDraftStore } from "../../../pullRequestReviewDraftStore";
import {
  createChangeRequestDiffFilesLoader,
  invalidateSourceControl,
  useSubmitChangeRequestReviewMutation,
} from "../../../rpc/useSourceControl";
import { DiffWorkerPoolProvider } from "../../DiffWorkerPoolProvider";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { usePullRequestAgentHandoff } from "../agentHandoff";
import {
  usePullRequestHostName,
  usePullRequestSelection,
  usePullRequestsPage,
} from "../PullRequestsPageContext";
import { usePullRequestsLayoutStore } from "../pullRequestsLayoutStore";
import { usePullRequestsShortcut } from "../pullRequestsShortcuts";
import type { DiffFileActions, DiffRenderSettings } from "./DiffFileSection";
import {
  findDiffLineElement,
  flashDiffLine,
  flashElement,
  holdInView,
  nextFrame,
  revealDiffLine,
  waitForDiffLayout,
} from "./diffReveal";
import { FileTreePane, type FileThreadCounts } from "./FileTreePane";
import {
  adjacentFilePath,
  adjacentThreadStop,
  commitScopedReviewThreads,
  fileAtHeadUrl,
  lineCommentTarget,
  lineCommentTargetLabel,
  lineCommentTargetTexts,
  splitFilePath,
  unresolvedThreadStops,
  type LineCommentTarget,
} from "./pullRequestFiles.logic";
import { useFileTreeShown, usePullRequestFilesUiStore } from "./pullRequestFilesStore";
import {
  DiffUnavailable,
  PullRequestDiffStream,
  type DiffStreamState,
} from "./PullRequestDiffStream";
import { useFilesViewed } from "./useFilesViewed";
import { usePullRequestDiffFiles } from "./usePullRequestDiffFiles";

const TREE_WIDTH = 248;
const EMPTY_KEYS: ReadonlySet<string> = new Set();

/** A line composer is tied to the patch it was opened on. */
interface ComposerState {
  readonly path: string;
  readonly target: LineCommentTarget;
  /** Head of the diff it was opened on: the target's line numbers refer to it. */
  readonly headSha: string;
  /** That file's patch; another patch (a new push changed the file) may have moved the lines. */
  readonly renderKey: string;
}

interface LineSelectionState {
  readonly path: string;
  readonly range: SelectedLineRange;
  readonly final: boolean;
  readonly renderKey: string;
}

/** The anchor fields a pending draft takes from a line target. */
function draftAnchorFields(target: LineCommentTarget) {
  return {
    path: target.path,
    line: target.line,
    side: target.side,
    ...(target.startLine !== undefined
      ? { startLine: target.startLine, startSide: target.startSide ?? target.side }
      : {}),
  };
}

function scrollerIn(viewport: HTMLElement | null): HTMLElement | null {
  return viewport?.querySelector<HTMLElement>(".diff-render-surface") ?? null;
}

function sectionIn(viewport: HTMLElement | null, path: string): HTMLElement | null {
  return (
    viewport?.querySelector<HTMLElement>(`[data-diff-file-path="${CSS.escape(path)}"]`) ?? null
  );
}

/** The file header's open/close toggle: where focus lands when the diff takes it back. */
function headerToggleIn(viewport: HTMLElement | null, path: string): HTMLElement | null {
  return (
    sectionIn(viewport, path)?.querySelector<HTMLElement>("header button[aria-expanded]") ?? null
  );
}

/** Bring a file's header to the top of the diff. */
function scrollToSection(viewport: HTMLElement | null, path: string): void {
  const scroller = scrollerIn(viewport);
  const section = sectionIn(viewport, path);
  if (!scroller || !section) return;
  scroller.scrollTop = Math.max(0, scrollOffsetOf(scroller, section));
}

/** Top of `element` in the scroller's content coordinates. */
function scrollOffsetOf(scroller: HTMLElement, element: HTMLElement): number {
  return (
    element.getBoundingClientRect().top - scroller.getBoundingClientRect().top + scroller.scrollTop
  );
}

/**
 * The Files tab: the whole change request (or one commit) as one virtualized
 * diff, full width, with the file tree docked at 248px on wide readers and
 * laid over the diff on narrow ones. Review happens in place: threads sit
 * under their lines, the gutter `+` (drag for a range) opens a composer, and
 * a line selection offers "Comment" or "Ask agent". Links to a file, line or
 * thread scroll there and flash once.
 *
 * The diff worker pool (and its highlighter) starts with the first visit to
 * Files: no other tab renders a diff.
 */
export function FilesTab() {
  const { model } = usePullRequestsPage();
  if (!model.capabilities.diff) return <FilesUnavailable />;
  return (
    <DiffWorkerPoolProvider>
      <FilesTabContent />
    </DiffWorkerPoolProvider>
  );
}

/** A host whose provider cannot produce the diff: no tree, no reads, a way out. */
function FilesUnavailable() {
  const selection = usePullRequestSelection();
  const hostName = usePullRequestHostName();
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      <DiffUnavailable
        hostName={hostName}
        url={selection.detail.data?.url ?? selection.summary?.url ?? null}
      />
    </div>
  );
}

function FilesTabContent() {
  const { nav, layout, model } = usePullRequestsPage();
  const capabilities = model.capabilities;
  const selection = usePullRequestSelection();
  const handoff = usePullRequestAgentHandoff();
  const hostName = usePullRequestHostName();
  const { resolvedTheme } = useTheme();
  const [diffLayout] = useDiffLayout();
  const commitSha = nav.search.commit ?? null;
  const active = nav.tab === "files";
  const detail = selection.detail.data;
  const activity = selection.activity.data;
  const headSha = selection.headSha;

  // The detail lists the files (whole change request only) before the diff arrives.
  const provisionalPaths = useMemo(
    () => (commitSha === null ? detail?.files?.map((file) => file.path) : undefined),
    [commitSha, detail?.files],
  );
  // Both reads are keyed by the head: wait for it, so a cold link does not
  // read once without it and again with it (the detail's paths fill the wait).
  const files = usePullRequestDiffFiles({
    environmentId: model.environmentId,
    cwd: model.cwd,
    reference: selection.reference,
    headSha,
    commitSha,
    enabled: model.environmentId !== null && model.cwd !== null && headSha !== null,
    provisionalPaths: provisionalPaths,
  });
  // The head the diff on screen was read at; it trails `headSha` while a new head loads.
  const diffHeadSha = files.headSha;
  const viewed = useFilesViewed({
    environmentId: model.environmentId,
    cwd: model.cwd,
    reference: selection.reference,
    headSha,
    // Hosts without viewed storage are never asked.
    active: active && headSha !== null && capabilities.viewedFiles,
  });

  // ── Threads and drafts ──────────────────────────────────────────────
  const allThreads = activity?.reviewThreads;
  // A commit's diff shows only the conversations written on it, at their original lines.
  const threadIndex = useMemo(
    () =>
      commitSha
        ? indexReviewThreads(
            commitScopedReviewThreads(
              allThreads ?? [],
              commitSha,
              (path) => files.byPath.get(path)?.fileDiff,
            ),
            "original",
          )
        : selection.threads,
    [allThreads, commitSha, files.byPath, selection.threads],
  );
  const threadCounts = useMemo(() => {
    const counts = new Map<string, FileThreadCounts>();
    for (const [path, threads] of threadIndex.byPath) {
      counts.set(path, {
        total: threads.length,
        unresolved: threads.filter((thread) => !thread.isResolved).length,
      });
    }
    return counts;
  }, [threadIndex]);

  const draftKey = selection.draftKey;
  const draft = usePullRequestReviewDraftStore((state) =>
    draftKey ? selectReviewDraft(state, draftKey) : EMPTY_REVIEW_DRAFT,
  );
  const draftsByPath = useMemo(() => {
    const byPath = new Map<string, ReviewDraftComment[]>();
    // Drafts belong to the head; a single commit's line numbers are another file.
    if (commitSha) return byPath;
    for (const comment of draft.comments) {
      const list = byPath.get(comment.path);
      if (list) list.push(comment);
      else byPath.set(comment.path, [comment]);
    }
    return byPath;
  }, [commitSha, draft.comments]);

  // ── Per-file UI state ───────────────────────────────────────────────
  const [openOverrides, setOpenOverrides] = useState<ReadonlyMap<string, boolean>>(() => new Map());
  const [composer, setComposer] = useState<ComposerState | null>(null);
  const [lineSelection, setLineSelection] = useState<LineSelectionState | null>(null);
  /** Patches (render keys) whose full contents the host refused. */
  const [expansionBlocked, setExpansionBlocked] = useState<ReadonlySet<string>>(EMPTY_KEYS);

  // A commit scope is another diff: its files start fresh. A new head keeps
  // what the reader set up; state tied to one file's patch checks it below.
  const [scope, setScope] = useState(commitSha);
  if (scope !== commitSha) {
    setScope(commitSha);
    setOpenOverrides(new Map());
    setLineSelection(null);
  }
  const patchKeyOf = (path: string) => files.byPath.get(path)?.renderKey;
  // The composer and the selection show only on the patch they were made on
  // (the composer never in a commit scope, where commenting is off).
  const liveComposer =
    composer !== null && commitSha === null && patchKeyOf(composer.path) === composer.renderKey
      ? composer
      : null;
  const liveSelection =
    lineSelection !== null && patchKeyOf(lineSelection.path) === lineSelection.renderKey
      ? lineSelection
      : null;
  // A new push changed the file under an open composer: its lines may now be other code.
  const composerOrphaned =
    composer !== null &&
    commitSha === null &&
    files.status === "ready" &&
    patchKeyOf(composer.path) !== composer.renderKey;

  const isOpen = useCallback(
    (path: string) => {
      const override = openOverrides.get(path);
      if (override !== undefined) return override;
      const file = files.byPath.get(path);
      return !(file?.startsCollapsed ?? false) && viewed.states.get(path) !== "viewed";
    },
    [files.byPath, openOverrides, viewed.states],
  );
  const setOpen = useCallback((path: string, open: boolean) => {
    setOpenOverrides((current) => {
      if (current.get(path) === open) return current;
      const next = new Map(current);
      next.set(path, open);
      return next;
    });
  }, []);

  // ── Review capabilities ─────────────────────────────────────────────
  const viewer = activity?.viewer ?? null;
  const commentingSupported = capabilities.lineComments;
  const commentingReason = !commentingSupported
    ? "Line comments aren’t available for this host"
    : commitSha
      ? "Comments are off while viewing a single commit"
      : !diffHeadSha || !draftKey
        ? "The pull request is still loading"
        : viewer && !viewer.canReview
          ? "You can’t review this pull request"
          : undefined;
  const reviewStarted = draft.comments.length > 0;

  const loadDiffFiles = useMemo(() => {
    // Hunk expansion reads both sides' contents; hosts without that read get none.
    if (!diffHeadSha || !capabilities.fileContents) return undefined;
    if (!commitSha) {
      return createChangeRequestDiffFilesLoader({
        environmentId: model.environmentId,
        cwd: model.cwd,
        reference: selection.reference,
        headSha: diffHeadSha,
      });
    }
    // A commit expands against its parent; the first commit's parent is unknown here.
    const commits = detail?.commits ?? [];
    const index = commits.findIndex((commit) => commit.oid === commitSha);
    const parent = index > 0 ? commits[index - 1] : undefined;
    return parent
      ? createChangeRequestDiffFilesLoader({
          environmentId: model.environmentId,
          cwd: model.cwd,
          reference: selection.reference,
          headSha: commitSha,
          baseSha: parent.oid,
        })
      : undefined;
  }, [
    capabilities.fileContents,
    commitSha,
    detail?.commits,
    diffHeadSha,
    model.cwd,
    model.environmentId,
    selection.reference,
  ]);

  const pullRequestUrl = detail?.url ?? selection.summary?.url ?? null;
  const settings = useMemo<DiffRenderSettings>(
    () => ({
      theme: resolvedTheme,
      diffStyle: diffLayout === "split" ? "split" : "unified",
      loadDiffFiles,
      commenting: {
        supported: commentingSupported,
        enabled: commentingReason === undefined,
        reason: commentingReason,
      },
      ask: {
        supported: handoff.supported,
        enabled: handoff.available,
        reason: handoff.unavailableReason,
      },
      mode: commitSha ? "original" : "current",
      headSha: diffHeadSha,
      reviewStarted,
      viewerLogin: viewer?.login ?? "You",
      viewerAvatarUrl: undefined,
      headUrlFor: (path) => fileAtHeadUrl(pullRequestUrl, commitSha ?? diffHeadSha, path),
    }),
    [
      commentingReason,
      commentingSupported,
      commitSha,
      diffHeadSha,
      diffLayout,
      handoff.available,
      handoff.supported,
      handoff.unavailableReason,
      loadDiffFiles,
      pullRequestUrl,
      resolvedTheme,
      reviewStarted,
      viewer?.login,
    ],
  );

  // ── Scrolling ───────────────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement>(null);
  const scrollerOf = () => scrollerIn(viewportRef.current);
  const sectionOf = (path: string) => sectionIn(viewportRef.current, path);
  const spy = useDiffFileNavigation(viewportRef, files.paths, active && files.status === "ready");
  const currentPath = spy.path;
  const scrollToFile = (path: string) => scrollToSection(viewportRef.current, path);

  // ── Actions shared by every file (stable through a ref) ─────────────
  const submitReview = useSubmitChangeRequestReviewMutation(selection.mutationTarget);
  const addComment = usePullRequestReviewDraftStore((state) => state.addComment);
  const updateComment = usePullRequestReviewDraftStore((state) => state.updateComment);
  const removeComment = usePullRequestReviewDraftStore((state) => state.removeComment);
  const { copyToClipboard } = useCopyToClipboard<string>({
    onCopy: (what) =>
      toastManager.add(
        stackedThreadToast({ type: "success", title: `Copied ${what}`, timeout: 1600 }),
      ),
  });

  const toggleViewed = useCallback(
    (path: string, next: boolean) => {
      viewed.setViewed(path, next);
      setOpen(path, !next);
    },
    [setOpen, viewed],
  );

  // Pierre reports the gutter drag's range as a line selection right after it
  // opens the composer; the open composer owns its file's highlight. Mirrors
  // `composer`: `openComposerAt` is the only writer of both.
  const composerRef = useRef(composer);
  // What the composer holds, outside React state: it survives the composer
  // remounting (a theme change, a file's patch changing under it) without a
  // page render per keystroke.
  const composerBodyRef = useRef("");
  // A file whose header takes focus back once the diff settles (the composer
  // or the overlay tree that held focus closed).
  const focusHeaderRef = useRef<string | null>(null);
  const openComposerAt = (next: ComposerState | null) => {
    composerRef.current = next;
    composerBodyRef.current = "";
    setComposer(next);
  };
  // Only the composer's own actions close it; focus that was in it (or that a
  // button disabled mid-send dropped to <body>) goes to its file's header.
  const closeComposer = () => {
    const current = composerRef.current;
    const focused = document.activeElement;
    const field = viewportRef.current?.querySelector("[data-line-composer]");
    if (current && (focused === document.body || (field?.contains(focused) ?? false))) {
      focusHeaderRef.current = current.path;
    }
    openComposerAt(null);
  };
  // Keep what was written on lines a new push changed: as a pending comment
  // on the head it was written against (marked outdated, never sent).
  const parkOrphanedComposer = () => {
    const current = composerRef.current;
    if (!current) return;
    const body = composerBodyRef.current.trim();
    focusHeaderRef.current = current.path;
    openComposerAt(null);
    if (body.length === 0 || !draftKey) return;
    addComment(draftKey, { ...draftAnchorFields(current.target), body, headSha: current.headSha });
    toastManager.add(
      stackedThreadToast({
        type: "info",
        title: `${splitFilePath(current.path).name} changed in a new push`,
        description: "Your comment was kept as an outdated pending comment.",
      }),
    );
  };
  const onComposerOrphaned = useEffectEvent(parkOrphanedComposer);
  useEffect(() => {
    if (composerOrphaned) onComposerOrphaned();
  }, [composerOrphaned]);

  const actions: DiffFileActions = {
    toggleOpen: (path) => setOpen(path, !isOpen(path)),
    toggleViewed,
    openComposer: (path, range) => {
      const file = files.byPath.get(path);
      if (commentingReason !== undefined || !diffHeadSha || !file) return;
      setOpen(path, true);
      setLineSelection(null);
      openComposerAt({
        path,
        target: lineCommentTarget(path, range),
        headSha: diffHeadSha,
        renderKey: file.renderKey,
      });
    },
    closeComposer,
    composerBody: () => composerBodyRef.current,
    rememberComposerBody: (body) => {
      composerBodyRef.current = body;
    },
    selectLines: (path, range, final) => {
      if (composerRef.current?.path === path) return;
      const renderKey = patchKeyOf(path);
      setLineSelection(range && renderKey ? { path, range, final, renderKey } : null);
    },
    // A live composer's file has the same patch at the diff's head, so its
    // lines refer to that head.
    addDraft: (target, body) => {
      if (!draftKey || !diffHeadSha) return;
      addComment(draftKey, { ...draftAnchorFields(target), body, headSha: diffHeadSha });
      closeComposer();
    },
    commentNow: async (target, body) => {
      if (!diffHeadSha || !model.cwd) throw new Error("The pull request is still loading.");
      const built = buildSubmitReviewInput(
        {
          ...EMPTY_REVIEW_DRAFT,
          comments: [
            {
              id: "comment-now",
              subjectType: "line",
              ...draftAnchorFields(target),
              body,
              headSha: diffHeadSha,
              createdAt: Date.now(),
            },
          ],
        },
        {
          cwd: model.cwd,
          reference: selection.reference,
          headSha: diffHeadSha,
          event: "comment",
        },
      );
      if (!built.ok) throw new Error(built.message);
      const { cwd: _cwd, reference: _reference, ...payload } = built.input;
      await submitReview.mutateAsync(payload);
      closeComposer();
      toastManager.add(
        stackedThreadToast({ type: "success", title: "Comment sent", timeout: 1800 }),
      );
    },
    updateDraft: (draftId, body) => {
      if (draftKey) updateComment(draftKey, draftId, { body });
    },
    removeDraft: (draftId) => {
      if (draftKey) removeComment(draftKey, draftId);
    },
    askAboutLines: (target, lines) => {
      setLineSelection(null);
      void handoff.start({
        kind: "ask-selection",
        prompt: `About ${target.path} (${lineCommentTargetLabel(target)}) in pull request #${selection.number}: `,
        context: `${target.path}, ${lineCommentTargetLabel(target)}${
          commitSha ? ` at ${commitSha.slice(0, 7)}` : ""
        }:\n\`\`\`\n${lines.join("\n")}\n\`\`\``,
      });
    },
    copyPath: (path) => copyToClipboard(path, "path"),
    expansionUnavailable: (renderKey) =>
      setExpansionBlocked((current) => {
        if (current.has(renderKey)) return current;
        const next = new Set(current);
        next.add(renderKey);
        return next;
      }),
  };
  const actionsRef = useRef(actions);
  useLayoutEffect(() => {
    actionsRef.current = actions;
  });

  // ── Deep links: file / line / side / thread ─────────────────────────
  const revealRef = useRef<{ key: string; controller: AbortController } | null>(null);
  const lastThreadRef = useRef<string | null>(null);
  const search = nav.search;
  const revealKey = JSON.stringify([
    search.file ?? null,
    search.line ?? null,
    search.side ?? null,
    search.thread ?? null,
    commitSha,
  ]);
  // A thread link waits for the conversations (on a cold link they arrive
  // after the diff); without them it falls back to the link's file and line.
  const threadsSettled =
    allThreads !== undefined || !capabilities.activity || selection.activity.error !== null;
  const reveal = async (signal: AbortSignal) => {
    let path = search.file ?? null;
    let line = search.line ?? null;
    let side = diffSideToAnnotationSide(search.side ?? "right");
    let threadId: string | null = null;
    const thread = search.thread
      ? allThreads?.find((candidate) => candidate.id === search.thread)
      : undefined;
    const shown =
      thread !== undefined &&
      (threadIndex.byPath.get(thread.path) ?? []).some((entry) => entry.id === thread.id);
    if (thread && shown) {
      threadId = thread.id;
      path = thread.path;
      const anchored = threadIndex.anchoredByPath
        .get(thread.path)
        ?.find((entry) => entry.thread.id === thread.id);
      line = anchored && anchored.anchor.lineNumber > 0 ? anchored.anchor.lineNumber : null;
      if (anchored) side = anchored.anchor.side;
      lastThreadRef.current = thread.id;
    } else if (thread) {
      // Written on another commit than the one in scope: land on its file.
      path = search.file ?? thread.path;
      line = null;
    }
    if (!path || !files.byPath.has(path)) return;
    const targetPath = path;
    setOpen(targetPath, true);
    // A collapsed file mounts its diff first; then every file has to be laid out
    // (the highlighter worker may still be warming up) before anything is measured.
    for (
      let attempt = 0;
      attempt < 30 && !sectionOf(targetPath)?.querySelector("diffs-container");
      attempt += 1
    ) {
      if (signal.aborted) return;
      await nextFrame();
    }
    const viewport = viewportRef.current;
    if (!viewport || !(await waitForDiffLayout(viewport, signal))) return;
    const scroller = scrollerOf();
    const section = sectionOf(targetPath);
    if (!scroller || !section || signal.aborted) return;

    const findThread = () =>
      threadId === null
        ? null
        : section.querySelector<HTMLElement>(`[data-review-thread-id="${CSS.escape(threadId)}"]`);
    const findLine = () => (line === null ? null : findDiffLineElement(section, side, line));
    const walkToLine = () =>
      line === null
        ? Promise.resolve(null)
        : revealDiffLine({ scroller, fileElement: section, side, line, signal });

    if (line === null && threadId === null) {
      scrollToFile(targetPath);
      await holdInView({
        scroller,
        resolve: () => sectionOf(targetPath),
        recover: async () => sectionOf(targetPath),
        signal,
        align: "start",
      });
      return;
    }
    if (line !== null) await walkToLine();
    else scrollToFile(targetPath);
    const target = await holdInView({
      scroller,
      resolve: () => (threadId === null ? findLine() : findThread()),
      recover: async () => {
        await walkToLine();
        return threadId === null ? findLine() : findThread();
      },
      signal,
    });
    if (!target || signal.aborted) return;
    if (threadId === null) flashDiffLine(target);
    else flashElement(target);
  };
  const revealFromLink = useEffectEvent(reveal);
  useEffect(() => {
    if (!active || files.status !== "ready") return;
    if (!search.file && !search.thread) return;
    if (search.thread && !threadsSettled) return;
    if (revealRef.current?.key === revealKey) return;
    revealRef.current?.controller.abort();
    const controller = new AbortController();
    revealRef.current = { key: revealKey, controller };
    void revealFromLink(controller.signal);
  }, [active, files.status, revealKey, search.file, search.thread, threadsSettled]);
  useEffect(() => () => revealRef.current?.controller.abort(), []);

  // ── Tree ────────────────────────────────────────────────────────────
  const treeShown = useFileTreeShown(layout.treeDocked);
  const setTreeOverlayOpen = usePullRequestFilesUiStore((state) => state.setTreeOverlayOpen);
  const setTreeHidden = usePullRequestsLayoutStore((state) => state.setTreeHidden);
  const filterRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLElement>(null);
  const overlayOpen = !layout.treeDocked && treeShown;
  // Each reader (one pull request) mounts its own Files tab: start with overlays closed.
  useEffect(() => {
    usePullRequestFilesUiStore.getState().setTreeOverlayOpen(false);
    usePullRequestFilesUiStore.getState().setCommitMenuOpen(false);
  }, []);

  // Stable (it changes only when the tree docks or undocks), so scroll-spy
  // renders reach only the two tree rows whose plate moves.
  const selectFromTree = useCallback(
    (path: string) => {
      setOpen(path, true);
      scrollToSection(viewportRef.current, path);
      if (layout.treeDocked) return;
      // The overlay closes over the file it opened: focus follows to that file.
      if (overlayRef.current?.contains(document.activeElement)) focusHeaderRef.current = path;
      setTreeOverlayOpen(false);
    },
    [layout.treeDocked, setOpen, setTreeOverlayOpen],
  );
  const dismissOverlay = useCallback(() => setTreeOverlayOpen(false), [setTreeOverlayOpen]);

  // The overlay tree takes focus when it opens (`T` puts it in the filter
  // instead) and gives it back when it closes, so focus never stays behind
  // in the inert panel.
  useLayoutEffect(() => {
    const overlay = overlayRef.current;
    if (!overlayOpen || !overlay) return;
    const opener = document.activeElement;
    if (!overlay.contains(opener)) {
      const row =
        overlay.querySelector<HTMLElement>('[data-tree-path] > button[aria-current="true"]') ??
        overlay.querySelector<HTMLElement>("[data-tree-path] > button") ??
        filterRef.current;
      row?.focus({ preventScroll: true });
    }
    return () => {
      const focused = document.activeElement;
      if (focused !== null && focused !== document.body && !overlay.contains(focused)) return;
      // Picking a file hands focus to that file's header (below).
      if (focusHeaderRef.current !== null) return;
      if (
        opener instanceof HTMLElement &&
        opener !== document.body &&
        opener.isConnected &&
        !overlay.contains(opener)
      ) {
        opener.focus({ preventScroll: true });
      }
    };
  }, [overlayOpen]);

  // Hand focus to a file's header once the composer or overlay that held it is gone.
  useLayoutEffect(() => {
    const path = focusHeaderRef.current;
    if (path === null) return;
    focusHeaderRef.current = null;
    const focused = document.activeElement;
    const stranded =
      focused === null ||
      focused === document.body ||
      !focused.isConnected ||
      (overlayRef.current?.contains(focused) ?? false);
    if (stranded) headerToggleIn(viewportRef.current, path)?.focus({ preventScroll: true });
  });

  // ── Keys (Files only; J/K here override the page's PR stepping) ─────
  const stepFile = (direction: 1 | -1) => {
    const target = adjacentFilePath(files.paths, currentPath, direction);
    if (target) scrollToFile(target);
  };
  usePullRequestsShortcut("j", () => stepFile(1), { tab: "files" });
  usePullRequestsShortcut("k", () => stepFile(-1), { tab: "files" });
  usePullRequestsShortcut(
    "v",
    () => {
      if (!currentPath || !viewed.supported || !viewed.writable) return false;
      if (viewed.states.get(currentPath) === "viewed") {
        toggleViewed(currentPath, false);
        return;
      }
      const next = adjacentFilePath(files.paths, currentPath, 1);
      const scroller = scrollerOf();
      const nextSection = next ? sectionOf(next) : null;
      const body = sectionOf(currentPath)?.querySelector<HTMLElement>("[data-diff-file-body]");
      if (scroller && nextSection && body && next !== currentPath) {
        // The current file is about to fold to its header: land the next file
        // where it will end up, so it slides up into place as the fold runs.
        scroller.scrollTop = Math.max(0, scrollOffsetOf(scroller, nextSection) - body.offsetHeight);
      }
      toggleViewed(currentPath, true);
    },
    { tab: "files" },
  );
  usePullRequestsShortcut(
    "t",
    () => {
      if (layout.treeDocked) setTreeHidden(false);
      else setTreeOverlayOpen(true);
      requestAnimationFrame(() => filterRef.current?.focus());
    },
    { tab: "files" },
  );
  const stepThread = (direction: 1 | -1) => {
    const stops = unresolvedThreadStops(files.paths, threadIndex.anchoredByPath);
    const stop = adjacentThreadStop(
      stops,
      files.paths,
      { threadId: lastThreadRef.current, path: currentPath },
      direction,
    );
    if (!stop) return false;
    lastThreadRef.current = stop.threadId;
    nav.setSearch({
      file: stop.path,
      thread: stop.threadId,
      line: undefined,
      side: undefined,
    });
  };
  usePullRequestsShortcut("n", () => stepThread(1), { tab: "files" });
  usePullRequestsShortcut("p", () => stepThread(-1), { tab: "files" });
  usePullRequestsShortcut(
    "a",
    () => {
      if (!liveSelection?.final || !handoff.available) return false;
      const file = files.byPath.get(liveSelection.path);
      if (!file) return false;
      const target = lineCommentTarget(liveSelection.path, liveSelection.range);
      actionsRef.current.askAboutLines(target, lineCommentTargetTexts(file.fileDiff, target));
    },
    { tab: "files", enabled: liveSelection?.final === true },
  );
  // Esc closes the top layer first: the overlay tree, then (the composer's own
  // field cancels it) the line selection.
  usePullRequestsShortcut(
    "escape",
    () => {
      if (overlayOpen || liveComposer) return false;
      setLineSelection(null);
    },
    { tab: "files", enabled: liveSelection !== null },
  );
  usePullRequestsShortcut(
    "escape",
    () => {
      if (!overlayOpen) return false;
      setTreeOverlayOpen(false);
    },
    { tab: "files", enabled: overlayOpen },
  );

  // ── Stream state ────────────────────────────────────────────────────
  const outdatedByPath = threadIndex.offDiffByPath;
  const streamState = useMemo<DiffStreamState>(
    () => ({
      isOpen,
      viewed,
      threadsByPath: threadIndex.byPath,
      outdatedByPath,
      draftsByPath,
      threadCounts,
      composer: liveComposer,
      selection: liveSelection,
      expansionBlocked,
    }),
    [
      draftsByPath,
      expansionBlocked,
      isOpen,
      liveComposer,
      liveSelection,
      outdatedByPath,
      threadCounts,
      threadIndex.byPath,
      viewed,
    ],
  );

  const tree = (
    <FileTreePane
      files={files}
      currentPath={currentPath}
      viewed={viewed}
      threadCounts={threadCounts}
      onSelectFile={selectFromTree}
      onToggleViewed={toggleViewed}
      onDismiss={layout.treeDocked ? undefined : dismissOverlay}
      filterRef={filterRef}
      className="h-full"
    />
  );

  return (
    <div className="relative flex min-h-0 min-w-0 flex-1">
      {layout.treeDocked ? (
        treeShown ? (
          <aside
            aria-label="Files"
            className="flex min-h-0 shrink-0 flex-col border-r border-border/70"
            style={{ width: TREE_WIDTH }}
          >
            {tree}
          </aside>
        ) : null
      ) : (
        <>
          <button
            type="button"
            aria-hidden
            tabIndex={-1}
            onClick={() => setTreeOverlayOpen(false)}
            className={cn(
              "absolute inset-0 z-30 cursor-default bg-transparent",
              treeShown ? "block" : "hidden",
            )}
          />
          <aside
            ref={overlayRef}
            aria-label="Files"
            data-open={treeShown}
            inert={!treeShown}
            className={cn(
              "pr-tree-overlay absolute inset-y-0 left-0 z-40 flex w-[min(18rem,85%)] flex-col border-r border-border/70 bg-background shadow-lg/5",
              treeShown ? "visible translate-x-0" : "invisible -translate-x-full",
            )}
          >
            {tree}
          </aside>
        </>
      )}
      <PullRequestDiffStream
        files={files}
        state={streamState}
        settings={settings}
        actionsRef={actionsRef}
        viewportRef={viewportRef}
        filesUrl={pullRequestUrl ? `${pullRequestUrl}/files` : null}
        hostName={hostName}
        commitScoped={commitSha !== null}
        onRetry={() =>
          invalidateSourceControl({ environmentId: model.environmentId, cwd: model.cwd })
        }
      />
    </div>
  );
}
