import { retargetPreviewFileSessions } from "./components/previewFileSessionRegistry";
import { useComposerDraftStore } from "./composerDraftStore";
import {
  configureThreadsRuntime,
  setThreadsRuntimeConfigurator,
} from "@ryco/client-runtime/state/threads";

import { resolveEnvironmentHttpUrl } from "./environments/runtime";
import { isHostedHubMode } from "./env";
import { webClock, webFrameScheduler, webObservability } from "./platform";

setThreadsRuntimeConfigurator(() => {
  configureThreadsRuntime({
    onCheckoutRelocated: (input) => {
      useComposerDraftStore.getState().retargetCheckoutPath(input);
      retargetPreviewFileSessions(input);
    },
    clock: { now: () => webClock.now() },
    frameScheduler: { scheduleFrame: (callback) => webFrameScheduler.scheduleFrame(callback) },
    observability: webObservability,
    isHostedHubMode: () => isHostedHubMode(),
    resolveAttachmentPreviewUrl: ({ environmentId, attachmentId }) =>
      resolveEnvironmentHttpUrl({
        environmentId,
        pathname: `/attachments/${encodeURIComponent(attachmentId)}`,
      }),
  });
});

export {
  applyOrchestrationEvent,
  applyOrchestrationEvents,
  applyShellEvent,
  createEnvironmentFallbackThreadRefSelector,
  createProjectSelectorByRef,
  createShellEventCoalescer,
  createThreadSelectorAcrossEnvironments,
  createThreadSelectorByRef,
  getThreadFromEnvironmentState,
  removeEnvironmentState,
  removeThreadByRef,
  selectBootstrapCompleteForActiveEnvironment,
  selectBootstrapCompleteForEnvironment,
  selectDelegatedChildThreadsForThreadRef,
  selectEnvironmentState,
  selectProjectByRef,
  selectProjectsAcrossEnvironments,
  selectProjectsForEnvironment,
  selectSidebarThreadSummaryByRef,
  selectSidebarThreadsAcrossEnvironments,
  selectSidebarThreadsForProjectRef,
  selectSidebarThreadsForProjectRefs,
  selectSidebarWorktreesAcrossEnvironments,
  selectSidebarWorktreesForProjectRef,
  selectSidebarWorktreesForProjectRefs,
  selectThreadByRef,
  selectThreadExistsByRef,
  selectThreadIdsByProjectRef,
  selectThreadShellsAcrossEnvironments,
  selectThreadsAcrossEnvironments,
  selectThreadsForEnvironment,
  setActiveEnvironmentId,
  setSidebarWorktreeTitle,
  setThreadBranch,
  setThreadError,
  SHELL_COALESCE_THRESHOLD_EVENTS_PER_MS,
  syncServerShellSnapshot,
  syncServerThreadDetail,
  useStore,
} from "@ryco/client-runtime/state/threads";
export type {
  AppState,
  EnvironmentState,
  ShellEventCoalescer,
} from "@ryco/client-runtime/state/threads";
