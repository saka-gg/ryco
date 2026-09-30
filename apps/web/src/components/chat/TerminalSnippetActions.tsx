import type { ScopedThreadRef } from "@ryco/contracts";
import { WS_METHODS } from "@ryco/contracts";
import { scopeProjectRef } from "@ryco/client-runtime/scoped";
import { resolveHostedRpcCapability } from "@ryco/client-runtime/authorization";
import { useCallback, useLayoutEffect, useRef, type ReactNode } from "react";
import { isHostedHubMode } from "../../env";
import { readEnvironmentConnection } from "../../environments/runtime";
import { useHostedHubStore } from "../../hostedHub/state";
import { useHostedRpcCapability } from "../../hostedHub/capabilities";
import { readHostedNodeMutationLease } from "../../hostedHub/hostedConnectionCoordinator";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import { randomUUID } from "../../lib/utils";
import { useStore } from "../../store";
import { createProjectSelectorByRef, createThreadSelectorByRef } from "../../storeSelectors";
import { selectThreadTerminalState, useTerminalStateStore } from "../../terminalStateStore";
import { terminalSnippetBroker } from "../../terminalSnippetInsertion";
import { usePaneFocusRef } from "./PaneFocus";
import { TerminalSnippetActionContext } from "./CodeBlockActions";

/** Presentation adapter: the shared runtime and server retain mutation policy. */
export function TerminalSnippetActions({
  threadRef,
  children,
}: {
  threadRef: ScopedThreadRef;
  children: ReactNode;
}) {
  const isPhone = usePresentationTier() === "phone";
  const capability = useHostedRpcCapability(WS_METHODS.terminalWrite);
  const focused = usePaneFocusRef();
  const alive = useRef(false);
  const generation = useRef(0);
  const pending = useRef(new Set<() => void>());
  useLayoutEffect(() => {
    alive.current = true;
    generation.current += 1;
    const requests = pending.current;
    return () => {
      alive.current = false;
      for (const cancel of requests) cancel();
      requests.clear();
    };
    // Each ownership/capability transition fences already captured callbacks.
    // oxlint-disable-next-line react/exhaustive-effect-dependencies
  }, [threadRef.environmentId, threadRef.threadId, isPhone, capability.allowed]);

  const insert = useCallback(
    async (source: string) => {
      const connection = readEnvironmentConnection(threadRef.environmentId);
      const actionGeneration = generation.current;
      const evidence = connection?.shellSnapshotReadiness.read();
      const hostedGeneration = useHostedHubStore.getState().generation;
      const lease = isHostedHubMode() ? readHostedNodeMutationLease(threadRef.environmentId) : null;
      if (isHostedHubMode() && !lease)
        throw new Error("This node must be current and authorized before terminal insertion.");
      const thread = createThreadSelectorByRef(threadRef)(useStore.getState());
      const project = thread
        ? createProjectSelectorByRef(scopeProjectRef(threadRef.environmentId, thread.projectId))(
            useStore.getState(),
          )
        : undefined;
      if (!connection || !evidence || !thread || !project)
        throw new Error(
          "The current thread workspace and connection must be ready before insertion.",
        );
      const cwd = thread.worktreePath ?? project.cwd;
      const worktreePath = thread.worktreePath ?? null;
      let targetTerminalId: string | null = null;
      const isCurrent = () => {
        const hosted = useHostedHubStore.getState();
        const currentLease = isHostedHubMode()
          ? readHostedNodeMutationLease(threadRef.environmentId)
          : null;
        if (
          lease &&
          (!currentLease ||
            currentLease.selectionGeneration !== lease.selectionGeneration ||
            currentLease.snapshotGeneration !== lease.snapshotGeneration)
        )
          return false;
        const allowed = resolveHostedRpcCapability({
          hosted: isHostedHubMode(),
          role: hosted.effectiveRole,
          fresh: hosted.directoryStatus === "ready" && hosted.transportStatus === "online",
          browserCurrent: hosted.browserStatus === "current",
          sessionReady: hosted.sessionStatus === "ready",
          method: WS_METHODS.terminalWrite,
        }).allowed;
        const currentThread = createThreadSelectorByRef(threadRef)(useStore.getState());
        const currentProject = currentThread
          ? createProjectSelectorByRef(
              scopeProjectRef(threadRef.environmentId, currentThread.projectId),
            )(useStore.getState())
          : undefined;
        const terminal = selectThreadTerminalState(
          useTerminalStateStore.getState().terminalStateByThreadKey,
          threadRef,
        );
        return (
          alive.current &&
          generation.current === actionGeneration &&
          focused.current &&
          !isPhone &&
          allowed &&
          hosted.generation === hostedGeneration &&
          readEnvironmentConnection(threadRef.environmentId) === connection &&
          connection.shellSnapshotReadiness.read() === evidence &&
          currentThread?.projectId === thread.projectId &&
          (currentThread?.worktreePath ?? null) === worktreePath &&
          currentProject?.cwd === project.cwd &&
          (targetTerminalId === null ||
            (terminal.terminalOpen && terminal.activeTerminalId === targetTerminalId))
        );
      };
      if (!isCurrent())
        throw new Error(
          "Terminal insertion is unavailable until this thread is current and authorized.",
        );
      // A dedicated fresh pane never overwrites or combines with unfinished input.
      const terminalId = `terminal-${randomUUID()}`;
      targetTerminalId = terminalId;
      const request = terminalSnippetBroker.request(
        { threadRef, terminalId, cwd, worktreePath },
        source,
        isCurrent,
      );
      pending.current.add(request.cancel);
      const store = useTerminalStateStore.getState();
      store.clearTerminalLaunchContext(threadRef);
      store.newTerminal(threadRef, terminalId);
      store.setTerminalOpen(threadRef, true);
      try {
        await request.promise;
      } finally {
        pending.current.delete(request.cancel);
      }
    },
    [focused, isPhone, threadRef],
  );

  return (
    <TerminalSnippetActionContext value={isPhone || !capability.allowed ? null : insert}>
      {children}
    </TerminalSnippetActionContext>
  );
}
