import { prewarmInIdleSlices, runWhenIdle } from "./idlePrewarm";
import { lazyScreen } from "./lazyScreen";

/**
 * Every route screen except Home, loaded on first visit.
 *
 * `Stack.tsx` and the locked stack in `AppAccessGate.tsx` used to import all of
 * these statically, so the thread detail, file viewer (shiki), review,
 * statistics, Hub account, E2EE ceremony, identity (WebView) and pairing
 * (camera) graphs were all evaluated before the first frame — for a launch
 * that shows Home. Home stays eager in `Stack.tsx`; each screen below now
 * pays only its own module cost, once, on its first render.
 */
export const ConnectionsRouteScreen = lazyScreen(
  "ConnectionsRouteScreen",
  () =>
    (
      require("../features/connection/ConnectionsRouteScreen") as typeof import("../features/connection/ConnectionsRouteScreen")
    ).ConnectionsRouteScreen,
);
export const ConnectionsNewRouteScreen = lazyScreen(
  "ConnectionsNewRouteScreen",
  () =>
    (
      require("../features/connection/ConnectionsNewRouteScreen") as typeof import("../features/connection/ConnectionsNewRouteScreen")
    ).ConnectionsNewRouteScreen,
);
export const E2eeNodeSecurityRouteScreen = lazyScreen(
  "E2eeNodeSecurityRouteScreen",
  () =>
    (
      require("../features/e2ee/E2eeNodeSecurityRouteScreen") as typeof import("../features/e2ee/E2eeNodeSecurityRouteScreen")
    ).E2eeNodeSecurityRouteScreen,
);
export const E2eeNodeVerificationRouteScreen = lazyScreen(
  "E2eeNodeVerificationRouteScreen",
  () =>
    (
      require("../features/e2ee/E2eeNodeVerificationRouteScreen") as typeof import("../features/e2ee/E2eeNodeVerificationRouteScreen")
    ).E2eeNodeVerificationRouteScreen,
);
export const ThreadFileEditRouteScreen = lazyScreen(
  "ThreadFileEditRouteScreen",
  () =>
    (
      require("../features/files/ThreadFileEditRouteScreen") as typeof import("../features/files/ThreadFileEditRouteScreen")
    ).ThreadFileEditRouteScreen,
);
export const ThreadFileSearchRouteScreen = lazyScreen(
  "ThreadFileSearchRouteScreen",
  () =>
    (
      require("../features/files/ThreadFileSearchRouteScreen") as typeof import("../features/files/ThreadFileSearchRouteScreen")
    ).ThreadFileSearchRouteScreen,
);
export const ThreadFileRouteScreen = lazyScreen(
  "ThreadFileRouteScreen",
  () =>
    (
      require("../features/files/ThreadFileRouteScreen") as typeof import("../features/files/ThreadFileRouteScreen")
    ).ThreadFileRouteScreen,
);
export const ThreadFilesRouteScreen = lazyScreen(
  "ThreadFilesRouteScreen",
  () =>
    (
      require("../features/files/ThreadFilesRouteScreen") as typeof import("../features/files/ThreadFilesRouteScreen")
    ).ThreadFilesRouteScreen,
);
export const HostedAccountRouteScreen = lazyScreen(
  "HostedAccountRouteScreen",
  () =>
    (
      require("../features/hostedHub/HostedAccountRouteScreen") as typeof import("../features/hostedHub/HostedAccountRouteScreen")
    ).HostedAccountRouteScreen,
);
export const NativeIdentityScreen = lazyScreen(
  "NativeIdentityScreen",
  () =>
    (
      require("../features/identity/NativeIdentityScreen") as typeof import("../features/identity/NativeIdentityScreen")
    ).NativeIdentityScreen,
);
export const NewTaskRouteScreen = lazyScreen(
  "NewTaskRouteScreen",
  () =>
    (
      require("../features/newTask/NewTaskRouteScreen") as typeof import("../features/newTask/NewTaskRouteScreen")
    ).NewTaskRouteScreen,
);
export const TaskDetailRouteScreen = lazyScreen(
  "TaskDetailRouteScreen",
  () =>
    (
      require("../features/tasks/TaskDetailRouteScreen") as typeof import("../features/tasks/TaskDetailRouteScreen")
    ).TaskDetailRouteScreen,
);
export const AddProjectRouteScreen = lazyScreen(
  "AddProjectRouteScreen",
  () =>
    (
      require("../features/projects/AddProjectRouteScreen") as typeof import("../features/projects/AddProjectRouteScreen")
    ).AddProjectRouteScreen,
);
export const ProjectRouteScreen = lazyScreen(
  "ProjectRouteScreen",
  () =>
    (
      require("../features/projects/ProjectRouteScreen") as typeof import("../features/projects/ProjectRouteScreen")
    ).ProjectRouteScreen,
);
export const ReviewCommentComposerSheet = lazyScreen(
  "ReviewCommentComposerSheet",
  () =>
    (
      require("../features/review/ReviewCommentComposerSheet") as typeof import("../features/review/ReviewCommentComposerSheet")
    ).ReviewCommentComposerSheet,
);
export const ReviewSheet = lazyScreen(
  "ReviewSheet",
  () =>
    (require("../features/review/ReviewSheet") as typeof import("../features/review/ReviewSheet"))
      .ReviewSheet,
);
export const ProjectNotesRouteScreen = lazyScreen(
  "ProjectNotesRouteScreen",
  () =>
    (
      require("../features/notes/ProjectNotesRouteScreen") as typeof import("../features/notes/ProjectNotesRouteScreen")
    ).ProjectNotesRouteScreen,
);
export const ThreadScriptsRouteScreen = lazyScreen(
  "ThreadScriptsRouteScreen",
  () =>
    (
      require("../features/scripts/ThreadScriptsRouteScreen") as typeof import("../features/scripts/ThreadScriptsRouteScreen")
    ).ThreadScriptsRouteScreen,
);
export const ThreadDevicesRouteScreen = lazyScreen(
  "ThreadDevicesRouteScreen",
  () =>
    (
      require("../features/devices/ThreadDevicesRouteScreen") as typeof import("../features/devices/ThreadDevicesRouteScreen")
    ).ThreadDevicesRouteScreen,
);
export const SourceControlBranchesRouteScreen = lazyScreen(
  "SourceControlBranchesRouteScreen",
  () =>
    (
      require("../features/sourceControl/SourceControlBranchesRouteScreen") as typeof import("../features/sourceControl/SourceControlBranchesRouteScreen")
    ).SourceControlBranchesRouteScreen,
);
export const SourceControlCommitRouteScreen = lazyScreen(
  "SourceControlCommitRouteScreen",
  () =>
    (
      require("../features/sourceControl/SourceControlCommitRouteScreen") as typeof import("../features/sourceControl/SourceControlCommitRouteScreen")
    ).SourceControlCommitRouteScreen,
);
export const SourceControlChangesRouteScreen = lazyScreen(
  "SourceControlChangesRouteScreen",
  () =>
    (
      require("../features/sourceControl/SourceControlChangesRouteScreen") as typeof import("../features/sourceControl/SourceControlChangesRouteScreen")
    ).SourceControlChangesRouteScreen,
);
export const SourceControlCompareRouteScreen = lazyScreen(
  "SourceControlCompareRouteScreen",
  () =>
    (
      require("../features/sourceControl/SourceControlCompareRouteScreen") as typeof import("../features/sourceControl/SourceControlCompareRouteScreen")
    ).SourceControlCompareRouteScreen,
);
export const SourceControlPublishRouteScreen = lazyScreen(
  "SourceControlPublishRouteScreen",
  () =>
    (
      require("../features/sourceControl/SourceControlPublishRouteScreen") as typeof import("../features/sourceControl/SourceControlPublishRouteScreen")
    ).SourceControlPublishRouteScreen,
);
export const SourceControlRouteScreen = lazyScreen(
  "SourceControlRouteScreen",
  () =>
    (
      require("../features/sourceControl/SourceControlRouteScreen") as typeof import("../features/sourceControl/SourceControlRouteScreen")
    ).SourceControlRouteScreen,
);
export const PullRequestsRouteScreen = lazyScreen(
  "PullRequestsRouteScreen",
  () =>
    (
      require("../features/pullRequests/PullRequestsRouteScreen") as typeof import("../features/pullRequests/PullRequestsRouteScreen")
    ).PullRequestsRouteScreen,
);
export const PullRequestRouteScreen = lazyScreen(
  "PullRequestRouteScreen",
  () =>
    (
      require("../features/pullRequests/PullRequestRouteScreen") as typeof import("../features/pullRequests/PullRequestRouteScreen")
    ).PullRequestRouteScreen,
);
export const PullRequestFileRouteScreen = lazyScreen(
  "PullRequestFileRouteScreen",
  () =>
    (
      require("../features/pullRequests/PullRequestFileRouteScreen") as typeof import("../features/pullRequests/PullRequestFileRouteScreen")
    ).PullRequestFileRouteScreen,
);
export const SettingsAppearanceRouteScreen = lazyScreen(
  "SettingsAppearanceRouteScreen",
  () =>
    (
      require("../features/settings/SettingsAppearanceRouteScreen") as typeof import("../features/settings/SettingsAppearanceRouteScreen")
    ).SettingsAppearanceRouteScreen,
);
export const SettingsAboutRouteScreen = lazyScreen(
  "SettingsAboutRouteScreen",
  () =>
    (
      require("../features/settings/SettingsAboutRouteScreen") as typeof import("../features/settings/SettingsAboutRouteScreen")
    ).SettingsAboutRouteScreen,
);
export const SettingsDiagnosticsRouteScreen = lazyScreen(
  "SettingsDiagnosticsRouteScreen",
  () =>
    (
      require("../features/settings/SettingsDiagnosticsRouteScreen") as typeof import("../features/settings/SettingsDiagnosticsRouteScreen")
    ).SettingsDiagnosticsRouteScreen,
);
export const SettingsClientStorageRouteScreen = lazyScreen(
  "SettingsClientStorageRouteScreen",
  () =>
    (
      require("../features/settings/SettingsClientStorageRouteScreen") as typeof import("../features/settings/SettingsClientStorageRouteScreen")
    ).SettingsClientStorageRouteScreen,
);
export const SettingsHubRouteScreen = lazyScreen(
  "SettingsHubRouteScreen",
  () =>
    (
      require("../features/settings/SettingsHubRouteScreen") as typeof import("../features/settings/SettingsHubRouteScreen")
    ).SettingsHubRouteScreen,
);
export const SettingsProviderAccountsRouteScreen = lazyScreen(
  "SettingsProviderAccountsRouteScreen",
  () =>
    (
      require("../features/settings/SettingsProviderAccountsRouteScreen") as typeof import("../features/settings/SettingsProviderAccountsRouteScreen")
    ).SettingsProviderAccountsRouteScreen,
);
export const ArchivedThreadsRouteScreen = lazyScreen(
  "ArchivedThreadsRouteScreen",
  () =>
    (
      require("../features/archive/ArchivedThreadsRouteScreen") as typeof import("../features/archive/ArchivedThreadsRouteScreen")
    ).ArchivedThreadsRouteScreen,
);
export const SettingsInboxRouteScreen = lazyScreen(
  "SettingsInboxRouteScreen",
  () =>
    (
      require("../features/settings/SettingsInboxRouteScreen") as typeof import("../features/settings/SettingsInboxRouteScreen")
    ).SettingsInboxRouteScreen,
);
export const SettingsNotificationsRouteScreen = lazyScreen(
  "SettingsNotificationsRouteScreen",
  () =>
    (
      require("../features/settings/SettingsNotificationsRouteScreen") as typeof import("../features/settings/SettingsNotificationsRouteScreen")
    ).SettingsNotificationsRouteScreen,
);
// The main tabs other than Chats, which loads with the app. A tab mounts on its first visit.
export const SettingsTabScreen = lazyScreen(
  "SettingsTabScreen",
  () =>
    (
      require("../features/settings/SettingsRouteScreen") as typeof import("../features/settings/SettingsRouteScreen")
    ).SettingsTabScreen,
);
export const UsageTabScreen = lazyScreen(
  "UsageTabScreen",
  () =>
    (
      require("../features/usage/UsageTabScreen") as typeof import("../features/usage/UsageTabScreen")
    ).UsageTabScreen,
);
export const TasksTabScreen = lazyScreen(
  "TasksTabScreen",
  () =>
    (
      require("../features/tasks/TasksTabScreen") as typeof import("../features/tasks/TasksTabScreen")
    ).TasksTabScreen,
);
// The PRs tab draws its own header (`stackHeader: { headerShown: false }` in
// `navigation/tabs/MainTabs.tsx`).
export const PullRequestsTabScreen = lazyScreen(
  "PullRequestsTabScreen",
  () =>
    (
      require("../features/pullRequests/PullRequestsTabScreen") as typeof import("../features/pullRequests/PullRequestsTabScreen")
    ).PullRequestsTabScreen,
);
export const GlobalSearchRouteScreen = lazyScreen(
  "GlobalSearchRouteScreen",
  () =>
    (
      require("../features/search/GlobalSearchRouteScreen") as typeof import("../features/search/GlobalSearchRouteScreen")
    ).GlobalSearchRouteScreen,
);
export const SettingsWorkspaceRouteScreen = lazyScreen(
  "SettingsWorkspaceRouteScreen",
  () =>
    (
      require("../features/settings/SettingsWorkspaceRouteScreen") as typeof import("../features/settings/SettingsWorkspaceRouteScreen")
    ).SettingsWorkspaceRouteScreen,
);
export const ThreadTerminalRouteScreen = lazyScreen(
  "ThreadTerminalRouteScreen",
  () =>
    (
      require("../features/terminal/ThreadTerminalRouteScreen") as typeof import("../features/terminal/ThreadTerminalRouteScreen")
    ).ThreadTerminalRouteScreen,
);
export const ThreadDeviceRouteScreen = lazyScreen(
  "ThreadDeviceRouteScreen",
  () =>
    (
      require("../features/devices/ThreadDeviceRouteScreen") as typeof import("../features/devices/ThreadDeviceRouteScreen")
    ).ThreadDeviceRouteScreen,
);
export const ThreadRouteScreen = lazyScreen(
  "ThreadRouteScreen",
  () =>
    (
      require("../features/threads/ThreadRouteScreen") as typeof import("../features/threads/ThreadRouteScreen")
    ).ThreadRouteScreen,
);

let workspacePrewarmScheduled = false;

/**
 * Called once Home has painted. Opening a thread is the next thing almost every
 * launch does, so the thread render path is evaluated in idle time rather than
 * on the tap. Under Metro's inline requires, evaluating the route module alone
 * would run only its wrapper, so the warm-up names the modules the first
 * thread render reaches (`threadRoutePrewarm.ts`). The review highlighter
 * (grammars are parsed on creation) warms after them, in a separate idle slice,
 * so the first code block in a thread is not slower than before it became lazy.
 */
export function scheduleWorkspaceRoutePrewarm(): void {
  if (workspacePrewarmScheduled) return;
  workspacePrewarmScheduled = true;
  runWhenIdle(() => {
    let modules: ReadonlyArray<() => unknown> = [];
    try {
      ThreadRouteScreen.preload();
      modules = (
        require("../features/threads/threadRoutePrewarm") as typeof import("../features/threads/threadRoutePrewarm")
      ).THREAD_ROUTE_PREWARM_MODULES;
    } catch {
      // The tap evaluates the route instead.
    }
    prewarmInIdleSlices(modules, () => {
      runWhenIdle(() => {
        void import("../features/review/shikiReviewHighlighter")
          .then((highlighter) => highlighter.prewarmReviewHighlighter())
          .catch(() => undefined);
      });
    });
  });
}
