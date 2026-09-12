import type { EnvironmentApi, EnvironmentId } from "@ryco/contracts";

import type { WsRpcClient } from "../rpc/index.ts";

export function createEnvironmentApi(rpcClient: WsRpcClient): EnvironmentApi {
  return {
    ...(rpcClient.chatAttachments?.readChunk
      ? { attachments: { readChunk: rpcClient.chatAttachments.readChunk } }
      : {}),
    server: {
      refreshProviders: rpcClient.server.refreshProviders,
      searchAcpRegistry: rpcClient.server.searchAcpRegistry,
      installAcpRegistry: rpcClient.server.installAcpRegistry,
      getAcpRegistryAuthMethods: rpcClient.server.getAcpRegistryAuthMethods,
      authenticateAcpRegistry: rpcClient.server.authenticateAcpRegistry,
      updateProvider: rpcClient.server.updateProvider,
      getSettings: rpcClient.server.getSettings,
      updateSettings: rpcClient.server.updateSettings,
      upsertKeybinding: rpcClient.server.upsertKeybinding,
      getResourceTelemetryHistory: rpcClient.server.getResourceTelemetryHistory,
      retryResourceTelemetry: rpcClient.server.retryResourceTelemetry,
      signalDiagnosticProcess: rpcClient.server.signalDiagnosticProcess,
      getDiagnosticsSnapshot: rpcClient.server.getDiagnosticsSnapshot,
      discoverSourceControl: rpcClient.server.discoverSourceControl,
      listOpinionatedPlugins: rpcClient.server.listOpinionatedPlugins,
      checkOpinionatedPlugins: rpcClient.server.checkOpinionatedPlugins,
      installOpinionatedPlugin: rpcClient.server.installOpinionatedPlugin,
    },
    ...(rpcClient.keybindings
      ? {
          keybindings: {
            replaceCustom: rpcClient.keybindings.replaceCustom,
          },
        }
      : {}),
    ...(rpcClient.device ? { device: rpcClient.device } : {}),
    terminal: {
      open: (input) => rpcClient.terminal.open(input as never),
      write: (input) => rpcClient.terminal.write(input as never),
      resize: (input) => rpcClient.terminal.resize(input as never),
      clear: (input) => rpcClient.terminal.clear(input as never),
      restart: (input) => rpcClient.terminal.restart(input as never),
      close: (input) => rpcClient.terminal.close(input as never),
      onEvent: (callback) => rpcClient.terminal.onEvent(callback),
    },
    projects: {
      listEntries: rpcClient.projects.listEntries,
      readFile: rpcClient.projects.readFile,
      readIcon: rpcClient.projects.readIcon,
      readFileBinary: rpcClient.projects.readFileBinary,
      searchEntries: rpcClient.projects.searchEntries,
      writeFile: rpcClient.projects.writeFile,
      stageFileReference: rpcClient.projects.stageFileReference,
      initializeGit: rpcClient.projects.initializeGit,
    },
    filesystem: { browse: rpcClient.filesystem.browse },
    sourceControl: {
      lookupRepository: rpcClient.sourceControl.lookupRepository,
      searchRepositories: rpcClient.sourceControl.searchRepositories,
      cloneRepository: rpcClient.sourceControl.cloneRepository,
      publishRepository: rpcClient.sourceControl.publishRepository,
    },
    vcs: {
      pull: rpcClient.vcs.pull,
      refreshStatus: rpcClient.vcs.refreshStatus,
      onStatus: (input, callback, options) => rpcClient.vcs.onStatus(input, callback, options),
      listRefs: rpcClient.vcs.listRefs,
      createWorktree: rpcClient.vcs.createWorktree,
      removeWorktree: rpcClient.vcs.removeWorktree,
      createRef: rpcClient.vcs.createRef,
      switchRef: rpcClient.vcs.switchRef,
      init: rpcClient.vcs.init,
    },
    git: {
      runStackedAction: rpcClient.git.runStackedAction,
      resolvePullRequest: rpcClient.git.resolvePullRequest,
      preparePullRequestThread: rpcClient.git.preparePullRequestThread,
      createWorktreeForProject: rpcClient.git.createWorktreeForProject,
      findWorktreeForOrigin: rpcClient.git.findWorktreeForOrigin,
      archiveWorktree: rpcClient.git.archiveWorktree,
      restoreWorktree: rpcClient.git.restoreWorktree,
      deleteWorktree: rpcClient.git.deleteWorktree,
    },
    ...(rpcClient.worktrees
      ? {
          worktrees: {
            setManualPosition: rpcClient.worktrees.setManualPosition,
          },
        }
      : {}),
    ...(rpcClient.threads
      ? {
          threads: {
            setManualBucket: rpcClient.threads.setManualBucket,
            setManualPosition: rpcClient.threads.setManualPosition,
          },
        }
      : {}),
    orchestration: {
      dispatchCommand: rpcClient.orchestration.dispatchCommand,
      getTurnDiff: rpcClient.orchestration.getTurnDiff,
      getWorkflowScript: rpcClient.orchestration.getWorkflowScript,
      getTaskOutput: rpcClient.orchestration.getTaskOutput,
      stopBackgroundTask: rpcClient.orchestration.stopBackgroundTask,
      getFullThreadDiff: rpcClient.orchestration.getFullThreadDiff,
      searchThreadMessages: rpcClient.orchestration.searchThreadMessages,
      ...(rpcClient.orchestration.getThreadWindow
        ? { getThreadWindow: rpcClient.orchestration.getThreadWindow }
        : {}),
      ...(rpcClient.orchestration.getThreadHistoryPage
        ? { getThreadHistoryPage: rpcClient.orchestration.getThreadHistoryPage }
        : {}),
      subscribeShell: (callback, options) =>
        rpcClient.orchestration.subscribeShell(callback, options),
      subscribeThread: (input, callback, options) =>
        rpcClient.orchestration.subscribeThread(input, callback, options),
      ...(rpcClient.orchestration.subscribeThreadWindow
        ? {
            subscribeThreadWindow: (input, callback, options) =>
              rpcClient.orchestration.subscribeThreadWindow!(input, callback, options),
          }
        : {}),
    },
    contextHandoff: {
      getInspectionSummary: rpcClient.contextHandoff.getInspectionSummary,
      listInspectionEntries: rpcClient.contextHandoff.listInspectionEntries,
      readRawPayloadChunk: rpcClient.contextHandoff.readRawPayloadChunk,
      readExportChunk: rpcClient.contextHandoff.readExportChunk,
    },
    mcp: {
      listWorkspaces: rpcClient.mcp.listWorkspaces,
      listServers: rpcClient.mcp.listServers,
      upsertServer: rpcClient.mcp.upsertServer,
      setServerEnabled: rpcClient.mcp.setServerEnabled,
      removeServer: rpcClient.mcp.removeServer,
      reloadServers: rpcClient.mcp.reloadServers,
      startOauthLogin: rpcClient.mcp.startOauthLogin,
    },
    // Conditional like worktrees/threads: older environments (and partial
    // test doubles) predate the Agent Control surface.
    ...(rpcClient.agentControl
      ? {
          agentControl: {
            listProposals: rpcClient.agentControl.listProposals,
            getProposal: rpcClient.agentControl.getProposal,
            acceptProposal: rpcClient.agentControl.acceptProposal,
            rejectProposal: rpcClient.agentControl.rejectProposal,
            subscribeProposals: rpcClient.agentControl.subscribeProposals,
            listIntegrations: rpcClient.agentControl.listIntegrations,
            createIntegration: rpcClient.agentControl.createIntegration,
            updateIntegration: rpcClient.agentControl.updateIntegration,
            resumeIntegrationPairing: rpcClient.agentControl.resumeIntegrationPairing,
            revokeIntegration: rpcClient.agentControl.revokeIntegration,
            deleteIntegration: rpcClient.agentControl.deleteIntegration,
            listMcpInstallations: rpcClient.agentControl.listMcpInstallations,
            connectMcpInstallation: rpcClient.agentControl.connectMcpInstallation,
            repairMcpInstallation: rpcClient.agentControl.repairMcpInstallation,
            disconnectMcpInstallation: rpcClient.agentControl.disconnectMcpInstallation,
          },
        }
      : {}),
  };
}

export function createEnvironmentApiLookup(input: {
  readonly canReadConnections: () => boolean;
  readonly readClient: (environmentId: EnvironmentId) => WsRpcClient | null;
}) {
  const apis = new WeakMap<WsRpcClient, EnvironmentApi>();
  return {
    read: (environmentId: EnvironmentId): EnvironmentApi | undefined => {
      if (!input.canReadConnections() || !environmentId) return undefined;
      const client = input.readClient(environmentId);
      if (!client) return undefined;
      let api = apis.get(client);
      if (!api) {
        api = createEnvironmentApi(client);
        apis.set(client, api);
      }
      return api;
    },
  };
}
