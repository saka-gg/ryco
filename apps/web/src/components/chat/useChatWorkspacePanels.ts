import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, MessageId, ThreadId, TurnId } from "@ryco/contracts";
import { useEvent } from "../../hooks/useEvent";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import type { DraftId } from "../../composerDraftStore";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import {
  buildOpenAgentSearch,
  buildOpenAgentsSearch,
  buildOpenAgentsWorkflowSearch,
  buildOpenBrowserSearch,
  buildOpenFilesSearch,
  buildOpenPullRequestSearch,
  buildOpenRenderSearch,
  buildOpenReviewSearch,
  buildOpenSimulatorSearch,
  buildOpenTerminalSearch,
  buildOpenWorkspaceSearch,
  buildCloseWorkspacePanelSearch,
  formatWorkspaceRenderKey,
  workspaceAgentKeyForRuntimeAgent,
  type WorkspacePullRequestReveal,
} from "../../workspaceRouteSearch";

export interface UseChatWorkspacePanelsInput {
  navigate: ReturnType<typeof useNavigate>;
  environmentId: EnvironmentId;
  threadId: ThreadId;
  routeKind: "server" | "draft";
  draftId: DraftId | null;
  isServerThread: boolean;
  hasActiveProject: boolean;
  diffOpen: boolean;
  workspacePanelOpen: boolean;
  externalToggleWorkspacePanel: (() => void) | undefined;
  onDiffPanelOpen: (() => void) | undefined;
  onPreviewPanelOpen: (() => void) | undefined;
  onTerminalPanelOpen: (() => void) | undefined;
  onSimulatorPanelOpen: (() => void) | undefined;
  onAgentPanelOpen: (() => void) | undefined;
}

export interface UseChatWorkspacePanelsResult {
  onOpenReviewPanel: () => void;
  onToggleDiff: () => void;
  onOpenFilesPanel: () => void;
  onOpenBrowserPanel: () => void;
  /**
   * Desktop: the thread's (or a given) change request in the workspace panel,
   * optionally landing once on its Checks tab or one job there.
   */
  onOpenPullRequestPanel: (pullRequestNumber?: number, reveal?: WorkspacePullRequestReveal) => void;
  onOpenTerminalPanel: () => void;
  onOpenSimulatorPanel: () => void;
  onToggleWorkspacePanel: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onCloseDiff: () => void;
  onOpenAgentsPanel: () => void;
  /** Desktop: the Agents tab with one runtime subagent selected. */
  onOpenRuntimeAgentPanel: (agentId: string) => void;
  /** Desktop: the Agents tab focused once on one workflow. */
  onOpenAgentsWorkflowPanel: (workflowId: string) => void;
  onOpenSubagentPanel: (subagent: ThreadSubagentView) => void;
  /** Desktop: an agent's HTML render full size, in the workspace panel's page tab. */
  onOpenHtmlRender: (messageId: MessageId, attachmentId: string) => void;
}

/**
 * Owns the right-panel / workspace routing glue: opening and closing the diff,
 * files, terminal, agent, and combined workspace panels by mutating the route
 * search params.
 */
export function useChatWorkspacePanels(
  input: UseChatWorkspacePanelsInput,
): UseChatWorkspacePanelsResult {
  const {
    navigate,
    environmentId,
    threadId,
    routeKind,
    draftId,
    isServerThread,
    hasActiveProject,
    diffOpen,
    workspacePanelOpen,
    externalToggleWorkspacePanel,
    onDiffPanelOpen,
    onPreviewPanelOpen,
    onTerminalPanelOpen,
    onSimulatorPanelOpen,
    onAgentPanelOpen,
  } = input;
  const isPhoneTier = usePresentationTier() === "phone";

  /**
   * Replaces the current route's search: the draft route for a draft, else the
   * server thread's route. By default nothing happens before the server thread
   * exists; `requireServerThread: false` navigates the server route regardless
   * (the route is already current while its thread is still loading).
   */
  const navigateWorkspaceSearch = useEvent(
    (
      build: (previous: Record<string, unknown>) => Record<string, unknown>,
      options?: { readonly requireServerThread?: boolean },
    ) => {
      if (routeKind === "draft" && draftId) {
        void navigate({ to: "/draft/$draftId", params: { draftId }, replace: true, search: build });
        return;
      }
      if ((options?.requireServerThread ?? true) && !isServerThread) return;
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
        replace: true,
        search: build,
      });
    },
  );

  const onOpenReviewPanel = useEvent(() => {
    if (!isServerThread) {
      return;
    }
    onDiffPanelOpen?.();
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: (previous) => buildOpenReviewSearch(previous),
    });
  });
  const onToggleDiff = useEvent(() => {
    if (!isServerThread) {
      return;
    }
    if (!diffOpen) {
      onOpenReviewPanel();
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: (previous) =>
        diffOpen ? buildCloseWorkspacePanelSearch(previous) : buildOpenReviewSearch(previous),
    });
  });
  const onOpenFilesPanel = useEvent(() => {
    if (!hasActiveProject) {
      return;
    }
    onPreviewPanelOpen?.();
    const nextSearch = (previous: Record<string, unknown>) => buildOpenFilesSearch(previous);
    if (routeKind === "draft" && draftId) {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: true,
        search: nextSearch,
      });
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: nextSearch,
    });
  });
  const onOpenBrowserPanel = useEvent(() => {
    if (!hasActiveProject || isPhoneTier) return;
    const search = (previous: Record<string, unknown>) => buildOpenBrowserSearch(previous);
    if (routeKind === "draft" && draftId) {
      void navigate({ to: "/draft/$draftId", params: { draftId }, replace: true, search });
    } else {
      void navigate({
        to: "/$environmentId/$threadId",
        params: { environmentId, threadId },
        replace: true,
        search,
      });
    }
  });
  const onOpenPullRequestPanel = useEvent(
    (pullRequestNumber?: number, reveal?: WorkspacePullRequestReveal) => {
      if (!hasActiveProject || isPhoneTier) return;
      navigateWorkspaceSearch(
        (previous) => buildOpenPullRequestSearch(previous, pullRequestNumber, reveal),
        { requireServerThread: false },
      );
    },
  );
  const onOpenTerminalPanel = useEvent(() => {
    onTerminalPanelOpen?.();
    const nextSearch = (previous: Record<string, unknown>) => buildOpenTerminalSearch(previous);
    if (routeKind === "draft" && draftId) {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: true,
        search: nextSearch,
      });
      return;
    }
    if (!isServerThread) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: nextSearch,
    });
  });
  const onOpenSimulatorPanel = useEvent(() => {
    if (isPhoneTier) return;
    onSimulatorPanelOpen?.();
    const nextSearch = (previous: Record<string, unknown>) => buildOpenSimulatorSearch(previous);
    if (routeKind === "draft" && draftId) {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: true,
        search: nextSearch,
      });
      return;
    }
    if (!isServerThread) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
      replace: true,
      search: nextSearch,
    });
  });
  const onToggleWorkspacePanel = useEvent(() => {
    if (externalToggleWorkspacePanel) {
      externalToggleWorkspacePanel();
      return;
    }
    const nextSearch = (previous: Record<string, unknown>) =>
      workspacePanelOpen
        ? buildCloseWorkspacePanelSearch(previous)
        : buildOpenWorkspaceSearch(previous);

    if (routeKind === "draft" && draftId) {
      void navigate({
        to: "/draft/$draftId",
        params: { draftId },
        replace: true,
        search: nextSearch,
      });
      return;
    }

    if (!isServerThread) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      replace: true,
      search: nextSearch,
    });
  });
  const onOpenTurnDiff = useCallback(
    (turnId: TurnId, filePath?: string) => {
      if (!isServerThread) {
        return;
      }
      onDiffPanelOpen?.();
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId,
          threadId,
        },
        search: (previous) =>
          buildOpenReviewSearch(previous, {
            diffTurnId: turnId,
            diffFilePath: filePath ?? undefined,
          }),
      });
    },
    [environmentId, isServerThread, navigate, onDiffPanelOpen, threadId],
  );
  const onCloseDiff = useCallback(() => {
    if (!isServerThread) {
      return;
    }
    void navigate({
      to: "/$environmentId/$threadId",
      params: {
        environmentId,
        threadId,
      },
      search: (previous) => buildCloseWorkspacePanelSearch(previous),
    });
  }, [environmentId, isServerThread, navigate, threadId]);
  const onOpenAgentsPanel = useEvent(() => {
    // The frozen phone tier has no Agents workspace (AGENTS.md) — never
    // route phone callers into it.
    if (isPhoneTier) {
      return;
    }
    navigateWorkspaceSearch((previous) => buildOpenAgentsSearch(previous));
  });
  const onOpenRuntimeAgentPanel = useEvent((agentId: string) => {
    if (isPhoneTier) return;
    navigateWorkspaceSearch((previous) =>
      buildOpenAgentsSearch(previous, workspaceAgentKeyForRuntimeAgent(agentId)),
    );
  });
  const onOpenAgentsWorkflowPanel = useEvent((workflowId: string) => {
    if (isPhoneTier) return;
    navigateWorkspaceSearch((previous) => buildOpenAgentsWorkflowSearch(previous, workflowId));
  });
  const onOpenSubagentPanel = useCallback(
    (subagent: ThreadSubagentView) => {
      onAgentPanelOpen?.();
      const nextSearch = (previous: Record<string, unknown>) =>
        buildOpenAgentSearch(previous, subagent.key);

      if (routeKind === "draft" && draftId) {
        void navigate({
          to: "/draft/$draftId",
          params: { draftId },
          search: nextSearch,
        });
        return;
      }

      if (!isServerThread) {
        return;
      }
      void navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId,
          threadId,
        },
        search: nextSearch,
      });
    },
    [draftId, environmentId, isServerThread, navigate, onAgentPanelOpen, routeKind, threadId],
  );

  const onOpenHtmlRender = useEvent((messageId: MessageId, attachmentId: string) => {
    // Pages live in server threads; the frozen phone tier keeps its dialog.
    if (!isServerThread || isPhoneTier) return;
    void navigate({
      to: "/$environmentId/$threadId",
      params: { environmentId, threadId },
      search: (previous) =>
        buildOpenRenderSearch(previous, formatWorkspaceRenderKey({ messageId, attachmentId })),
    });
  });

  return {
    onOpenReviewPanel,
    onToggleDiff,
    onOpenFilesPanel,
    onOpenBrowserPanel,
    onOpenPullRequestPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    onToggleWorkspacePanel,
    onOpenTurnDiff,
    onCloseDiff,
    onOpenAgentsPanel,
    onOpenRuntimeAgentPanel,
    onOpenAgentsWorkflowPanel,
    onOpenSubagentPanel,
    onOpenHtmlRender,
  };
}
