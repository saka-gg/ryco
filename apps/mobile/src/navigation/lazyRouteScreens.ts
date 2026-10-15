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
export const SourceControlRouteScreen = lazyScreen(
  "SourceControlRouteScreen",
  () =>
    (
      require("../features/sourceControl/SourceControlRouteScreen") as typeof import("../features/sourceControl/SourceControlRouteScreen")
    ).SourceControlRouteScreen,
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
export const SettingsStatisticsRouteScreen = lazyScreen(
  "SettingsStatisticsRouteScreen",
  () =>
    (
      require("../features/settings/SettingsStatisticsRouteScreen") as typeof import("../features/settings/SettingsStatisticsRouteScreen")
    ).SettingsStatisticsRouteScreen,
);
export const SettingsInboxRouteScreen = lazyScreen(
  "SettingsInboxRouteScreen",
  () =>
    (
      require("../features/settings/SettingsInboxRouteScreen") as typeof import("../features/settings/SettingsInboxRouteScreen")
    ).SettingsInboxRouteScreen,
);
export const SettingsRouteScreen = lazyScreen(
  "SettingsRouteScreen",
  () =>
    (
      require("../features/settings/SettingsRouteScreen") as typeof import("../features/settings/SettingsRouteScreen")
    ).SettingsRouteScreen,
);
export const SettingsWorkspaceRouteScreen = lazyScreen(
  "SettingsWorkspaceRouteScreen",
  () =>
    (
      require("../features/settings/SettingsWorkspaceRouteScreen") as typeof import("../features/settings/SettingsWorkspaceRouteScreen")
    ).SettingsWorkspaceRouteScreen,
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
