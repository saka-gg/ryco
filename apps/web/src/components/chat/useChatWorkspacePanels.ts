import { useCallback } from "react";
import { useNavigate } from "@tanstack/react-router";
import type { EnvironmentId, ThreadId, TurnId } from "@ryco/contracts";
import { useEvent } from "../../hooks/useEvent";
import { usePresentationTier } from "../../hooks/usePresentationTier";
import type { DraftId } from "../../composerDraftStore";
import type { ThreadSubagentView } from "../../threadWorkspaceViewModel";
import {
  buildOpenAgentSearch,
  buildOpenAgentsSearch,
  buildOpenBrowserSearch,
  buildOpenFilesSearch,
  buildOpenReviewSearch,
  buildOpenSimulatorSearch,
  buildOpenTerminalSearch,
  buildOpenWorkspaceSearch,
  stripWorkspacePanelSearchParams,
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
  onOpenTerminalPanel: () => void;
  onOpenSimulatorPanel: () => void;
  onToggleWorkspacePanel: () => void;
  onOpenTurnDiff: (turnId: TurnId, filePath?: string) => void;
  onCloseDiff: () => void;
  onOpenAgentsPanel: () => void;
  onOpenSubagentPanel: (subagent: ThreadSubagentView) => void;
}

const CLOSE_WORKSPACE_PANEL_SEARCH = (previous: Record<string, unknown>) => ({
  ...stripWorkspacePanelSearchParams(previous),
  diff: undefined,
  diffTurnId: undefined,
  diffFilePath: undefined,
  preview: undefined,
  workspaceOpen: undefined,
  workspaceTab: undefined,
  workspaceAgentKey: undefined,
});

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
        diffOpen ? CLOSE_WORKSPACE_PANEL_SEARCH(previous) : buildOpenReviewSearch(previous),
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
        ? CLOSE_WORKSPACE_PANEL_SEARCH(previous)
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
      search: (previous) => CLOSE_WORKSPACE_PANEL_SEARCH(previous),
    });
  }, [environmentId, isServerThread, navigate, threadId]);
  const onOpenAgentsPanel = useEvent(() => {
    // The frozen phone tier has no Agents workspace (AGENTS.md) — never
    // route phone callers into it.
    if (isPhoneTier) {
      return;
    }
    const nextSearch = (previous: Record<string, unknown>) => buildOpenAgentsSearch(previous);
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

  return {
    onOpenReviewPanel,
    onToggleDiff,
    onOpenFilesPanel,
    onOpenBrowserPanel,
    onOpenTerminalPanel,
    onOpenSimulatorPanel,
    onToggleWorkspacePanel,
    onOpenTurnDiff,
    onCloseDiff,
    onOpenAgentsPanel,
    onOpenSubagentPanel,
  };
}
