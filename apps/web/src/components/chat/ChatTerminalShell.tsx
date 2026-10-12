import { terminalSnippetBroker } from "../../terminalSnippetInsertion";
import type { EnvironmentId, ResolvedKeybindingsConfig, ThreadId } from "@ryco/contracts";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { memo, Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { randomUUID } from "~/lib/utils";
import { readEnvironmentApi } from "../../environmentApi";
import { useComposerDraftStore } from "../../composerDraftStore";
import { type TerminalContextSelection } from "../../lib/terminalContext";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { useStore } from "../../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../../storeSelectors";
import { prepareThreadTerminal, resolveThreadTerminalLaunch } from "../../terminalPrepare";
import { useLazyComponentReady } from "../../lib/preloadableLazy";
import { LazyThreadTerminalDrawer as ThreadTerminalDrawer } from "../../workspacePanelPreload";

export type PersistentTerminalLaunchContext = {
  cwd: string;
  worktreePath: string | null;
};

export interface PersistentThreadTerminalDrawerProps {
  threadRef: { environmentId: EnvironmentId; threadId: ThreadId };
  threadId: ThreadId;
  visible: boolean;
  launchContext: PersistentTerminalLaunchContext | null;
  focusRequestId: number;
  splitShortcutLabel: string | undefined;
  newShortcutLabel: string | undefined;
  closeShortcutLabel: string | undefined;
  keybindings: ResolvedKeybindingsConfig;
  onAddTerminalContext: (selection: TerminalContextSelection) => void;
}

export const PersistentThreadTerminalDrawer = memo(function PersistentThreadTerminalDrawer({
  threadRef,
  threadId,
  visible,
  launchContext,
  focusRequestId,
  splitShortcutLabel,
  newShortcutLabel,
  closeShortcutLabel,
  keybindings,
  onAddTerminalContext,
}: PersistentThreadTerminalDrawerProps) {
  const serverThread = useStore(useMemo(() => createThreadSelectorByRef(threadRef), [threadRef]));
  const draftThread = useComposerDraftStore((store) => store.getDraftThreadByRef(threadRef));
  const projectRef = serverThread
    ? scopeProjectRef(serverThread.environmentId, serverThread.projectId)
    : draftThread
      ? scopeProjectRef(draftThread.environmentId, draftThread.projectId)
      : null;
  const project = useStore(useMemo(() => createProjectSelectorByRef(projectRef), [projectRef]));
  const terminalState = useTerminalStateStore((state) =>
    selectThreadTerminalState(state.terminalStateByThreadKey, threadRef),
  );
  const storeSetTerminalHeight = useTerminalStateStore((state) => state.setTerminalHeight);
  const storeSplitTerminal = useTerminalStateStore((state) => state.splitTerminal);
  const storeNewTerminal = useTerminalStateStore((state) => state.newTerminal);
  const storeSetActiveTerminal = useTerminalStateStore((state) => state.setActiveTerminal);
  const storeCloseTerminal = useTerminalStateStore((state) => state.closeTerminal);
  const [localFocusRequestId, setLocalFocusRequestId] = useState(0);
  const worktreePath = serverThread?.worktreePath ?? draftThread?.worktreePath ?? null;
  const projectCwd = project?.cwd ?? null;
  const hasLaunchContext = launchContext !== null;
  const launchCwd = launchContext?.cwd ?? null;
  const launchWorktreePath = launchContext?.worktreePath ?? null;
  // Keyed by values: a new `runtimeEnv` identity would rebuild the terminal.
  const launch = useMemo(
    () =>
      resolveThreadTerminalLaunch({
        projectCwd,
        threadWorktreePath: worktreePath,
        launchContext:
          hasLaunchContext && launchCwd !== null
            ? { cwd: launchCwd, worktreePath: launchWorktreePath }
            : null,
      }),
    [hasLaunchContext, launchCwd, launchWorktreePath, projectCwd, worktreePath],
  );
  const drawerOpen = Boolean(project && terminalState.terminalOpen && launch);
  const activeTerminalId = terminalState.activeTerminalId;
  // The drawer mounts once its chunk resolved: its loading row is an ordinary
  // render, so the terminal never waits on React's Suspense reveal throttle.
  const drawerReady = useLazyComponentReady(ThreadTerminalDrawer, drawerOpen);

  // The drawer was just opened (toggle, shortcut, server start) and its xterm
  // chunk is still loading: start the PTY now so shell startup overlaps it.
  // Only for the drawer the user sees: hidden drawers of other threads, an
  // unfocused pane or a role without terminal access never open early.
  useEffect(() => {
    if (!visible || !drawerOpen || !launch || ThreadTerminalDrawer.isLoaded()) return;
    prepareThreadTerminal({
      environmentId: threadRef.environmentId,
      threadId,
      terminalId: activeTerminalId,
      launch,
      layout: "drawer",
    });
  }, [activeTerminalId, drawerOpen, launch, threadId, threadRef.environmentId, visible]);

  const bumpFocusRequestId = useCallback(() => {
    if (!visible) {
      return;
    }
    setLocalFocusRequestId((value) => value + 1);
  }, [visible]);

  const setTerminalHeight = useCallback(
    (height: number) => {
      storeSetTerminalHeight(threadRef, height);
    },
    [storeSetTerminalHeight, threadRef],
  );

  const splitTerminal = useCallback(() => {
    storeSplitTerminal(threadRef, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeSplitTerminal, threadRef]);

  const createNewTerminal = useCallback(() => {
    storeNewTerminal(threadRef, `terminal-${randomUUID()}`);
    bumpFocusRequestId();
  }, [bumpFocusRequestId, storeNewTerminal, threadRef]);

  const activateTerminal = useCallback(
    (terminalId: string) => {
      storeSetActiveTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeSetActiveTerminal, threadRef],
  );

  const closeTerminal = useCallback(
    (terminalId: string) => {
      const api = readEnvironmentApi(threadRef.environmentId);
      if (!api) return;
      const isFinalTerminal = terminalState.terminalIds.length <= 1;
      void terminalSnippetBroker
        .close({ threadRef, terminalId }, api.terminal, isFinalTerminal)
        .catch(() => undefined);

      storeCloseTerminal(threadRef, terminalId);
      bumpFocusRequestId();
    },
    [bumpFocusRequestId, storeCloseTerminal, terminalState.terminalIds.length, threadRef],
  );

  const handleAddTerminalContext = useCallback(
    (selection: TerminalContextSelection) => {
      if (!visible) {
        return;
      }
      onAddTerminalContext(selection);
    },
    [onAddTerminalContext, visible],
  );

  if (!drawerOpen || !launch) {
    return null;
  }

  const loadingRow = (
    <div
      className="thread-terminal-drawer relative flex min-w-0 shrink-0 items-center border-border/80 border-t bg-background px-4 text-muted-foreground text-sm"
      style={{ height: terminalState.terminalHeight }}
    >
      Loading terminal...
    </div>
  );

  return (
    <div className={visible ? undefined : "hidden"}>
      {drawerReady ? (
        <Suspense fallback={loadingRow}>
          <ThreadTerminalDrawer
            threadRef={threadRef}
            threadId={threadId}
            cwd={launch.cwd}
            worktreePath={launch.worktreePath}
            runtimeEnv={launch.runtimeEnv}
            visible={visible}
            height={terminalState.terminalHeight}
            terminalIds={terminalState.terminalIds}
            runningTerminalIds={terminalState.runningTerminalIds}
            activeTerminalId={terminalState.activeTerminalId}
            terminalGroups={terminalState.terminalGroups}
            activeTerminalGroupId={terminalState.activeTerminalGroupId}
            focusRequestId={focusRequestId + localFocusRequestId + (visible ? 1 : 0)}
            onSplitTerminal={splitTerminal}
            onNewTerminal={createNewTerminal}
            splitShortcutLabel={visible ? splitShortcutLabel : undefined}
            newShortcutLabel={visible ? newShortcutLabel : undefined}
            closeShortcutLabel={visible ? closeShortcutLabel : undefined}
            keybindings={keybindings}
            onActiveTerminalChange={activateTerminal}
            onCloseTerminal={closeTerminal}
            onHeightChange={setTerminalHeight}
            onAddTerminalContext={handleAddTerminalContext}
          />
        </Suspense>
      ) : (
        loadingRow
      )}
    </div>
  );
});
