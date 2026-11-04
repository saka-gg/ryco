import { type ServerLifecycleWelcomePayload, WS_METHODS } from "@ryco/contracts";
import { scopedProjectKey, scopeProjectRef } from "@ryco/client-runtime/scoped";
import { isSavedEnvironmentSwitchedOff } from "@ryco/client-runtime/connection";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { OnboardingCoordinator } from "./onboarding/OnboardingCoordinator";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { CommandPalette, preloadCommandPaletteDialog } from "./CommandPalette";
import { NewChatShortcuts } from "./NewChatShortcuts";
import {
  expectsPrimaryShellPaint,
  resolveCanonicalPrimaryEnvironmentId,
  shouldApplyBootstrapThreadRedirect,
} from "./RootAppShell.logic";
import { ContextMenuActionSheetHost } from "./shell/phone/ContextMenuActionSheetHost";
import { SshPasswordPromptDialog } from "./desktop/SshPasswordPromptDialog";
import { WorkspaceReviewDialog } from "./worktrees/WorkspaceReviewDialog";
import { useAutomationsDialogStore } from "./automations/automationsDialogStore";
import { useSessionImportDialogStore } from "./sessionImport/sessionImportDialogStore";
import { usePromoteChatDialogStore } from "./chat/promoteChatDialogStore";
import { useForkThreadDialogStore } from "./chat/forkThreadDialogStore";
import { hasStoredProjectCopyRecords } from "./projectNodes/projectCopyStorage";
import { useProjectNodesDialogStore } from "./projectNodes/projectNodesDialogStore";
import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { MissedAutomationRunsNotice } from "./automations/MissedAutomationRunsNotice";
import {
  WebSocketConnectionCoordinator,
  type ConnectionRecoveryOwner,
} from "./WebSocketConnectionSurface";
import { AnchoredToastProvider, ToastProvider } from "./ui/toast";
import { getPresentationTier } from "../lib/presentationTier";
import {
  preloadableLazy,
  type PreloadableModule,
  useLazyComponentReady,
} from "../lib/preloadableLazy";
import { pathnameMatchesRoute, preloadRouteChunk } from "../lib/routeChunkPreload";
import {
  scheduleShellIdlePreloads,
  SHELL_IDLE_PRELOAD_PRIMARY_START_CAP_MS,
} from "../lib/shellIdlePreload";
import { scheduleIdleTask } from "../lib/idleTask";
import { prewarmThreadDetailSubscription } from "../lib/threadDetailPrewarm";
import { preloadSettingsPage } from "../settingsRoute";
import { useSettings } from "../hooks/useSettings";
import { isElectron, isHostedHubMode } from "../env";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
} from "../logicalProject";
import { useServerConfig, useServerWelcomeSubscription } from "../rpc/serverState";
import { isWebPerfProfileEnabled } from "../perf/perfInstrumentation";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  ensureEnvironmentConnectionBootstrapped,
  listSavedEnvironmentRecords,
  startEnvironmentConnectionService,
  useSavedEnvironmentRegistryStore,
} from "../environments/runtime";
import { startDesktopWorkspaceBridge } from "../platform/desktopWorkspace";
import { useNodeDirectoryPublisher } from "../environments/useNodeDirectoryPublisher";
import { scheduleSettingsSharingStart } from "../settingsSharing/settingsSharingStart";
import {
  configureClientTracing,
  disableClientTracing,
  shouldExportClientTraces,
} from "../observability/clientTracing";
import {
  getPrimaryKnownEnvironment,
  updatePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../environments/primary";
import { ServerStateBootstrap } from "./ServerStateBootstrap";
import { MessageQueueDrainBridge } from "./MessageQueueDrainBridge";
import { ThreadAlertsBootstrap } from "../notifications/ThreadAlertsBootstrap";
import { getRoutedHostedNode } from "../hostedHub/nodeRoutes";

// The hosted root mounts thread alerts itself, from this chunk (`hostedRootAppShell`).
export { ThreadAlertsBootstrap };

export interface RootAppShellProps {
  readonly authGateState: {
    readonly status: "authenticated" | "hosted-static" | "hosted-hub" | "hosted-cached";
  };
}

type ShellGateStatus = RootAppShellProps["authGateState"]["status"];

/** Workspace owners a gate state can opt into beyond what its authentication already mounts. */
type ShellOwner = "serverStateBootstrap" | "messageQueueDrain";

/**
 * The owners a hosted-cached shell runs. The shell stays mounted through an
 * in-app node switch and shows last-known data read-only, so the config
 * projection and the follow-up queue keep working across it; the queue only
 * dispatches through the capability-gated send path. Every other owner stays
 * off, because a cached view owns no connection lifecycle.
 */
const HOSTED_CACHED_OWNERS: ReadonlySet<ShellOwner> = new Set([
  "serverStateBootstrap",
  "messageQueueDrain",
]);

function hostedCachedRunsOwner(status: ShellGateStatus, owner: ShellOwner): boolean {
  return status === "hosted-cached" && HOSTED_CACHED_OWNERS.has(owner);
}

/**
 * Who recovers the primary connection for a gate state, or `null` for none.
 * Hosted builds only ever use the hosted lifecycle's owner: the generic one
 * reconnects by itself and would race it.
 */
function connectionRecoveryOwner(status: ShellGateStatus): ConnectionRecoveryOwner | null {
  if (status === "hosted-hub") return "hosted-lifecycle";
  if (status === "authenticated") return isHostedHubMode() ? "hosted-lifecycle" : "generic";
  return null;
}

export function RootAppShell({ authGateState }: RootAppShellProps) {
  const primaryEnvironmentAuthenticated =
    authGateState.status === "authenticated" || authGateState.status === "hosted-hub";
  const recoveryOwner = connectionRecoveryOwner(authGateState.status);
  // Every state with chat routes can queue, including hosted-static, which sends
  // to saved environments; readiness is per environment.
  const chatAvailable = primaryEnvironmentAuthenticated || authGateState.status === "hosted-static";
  // Only where this shell is the root. The hosted root, which renders it as
  // hosted-hub or hosted-cached, mounts thread alerts above its choice of
  // surface, so its Hub pages and node switch surfaces do not stop them.
  const ownsThreadAlerts =
    authGateState.status === "authenticated" || authGateState.status === "hosted-static";
  const localTracingAllowed = authGateState.status === "authenticated";
  // Project copies: Agent Control's node directory and the copies a previous
  // session left unfinished. Both load their code on demand.
  useNodeDirectoryPublisher(chatAvailable);
  useResumeProjectCopies(chatAvailable);
  // The presentation-tier seam lives inside `AppSidebarLayout`: the provider
  // and the route subtree stay mounted identically for both tiers (a tier
  // flip must not remount the workspace); only the sidebar chrome forks.
  const appShell = (
    <CommandPalette>
      <NewChatShortcuts />
      <AppSidebarLayout>
        <Outlet />
      </AppSidebarLayout>
    </CommandPalette>
  );

  return (
    <ToastProvider>
      <AnchoredToastProvider>
        {localTracingAllowed ? <AuthenticatedTracingBootstrap /> : null}
        {authGateState.status === "authenticated" ? <OnboardingCoordinator /> : null}
        {primaryEnvironmentAuthenticated ||
        hostedCachedRunsOwner(authGateState.status, "serverStateBootstrap") ? (
          <ServerStateBootstrap />
        ) : null}
        <EnvironmentConnectionManagerBootstrap />
        {chatAvailable || hostedCachedRunsOwner(authGateState.status, "messageQueueDrain") ? (
          <MessageQueueDrainBridge />
        ) : null}
        <ChatWidthDocumentSync />
        <ContextMenuActionSheetHost />
        <SshPasswordPromptDialog />
        <WorkspaceReviewDialog />
        {chatAvailable ? <AutomationsDialogMount /> : null}
        {chatAvailable ? <PromoteChatDialogMount /> : null}
        {chatAvailable ? <ForkThreadDialogMount /> : null}
        {chatAvailable ? <ProjectNodesDialogsMount /> : null}
        {chatAvailable ? <SessionImportDialogMount /> : null}
        {chatAvailable ? <MissedAutomationRunsNotice /> : null}
        {ownsThreadAlerts ? <ThreadAlertsBootstrap /> : null}
        {authGateState.status === "hosted-static" ? <HostedStaticEnvironmentBootstrap /> : null}
        {primaryEnvironmentAuthenticated ? (
          <EventRouter hosted={authGateState.status === "hosted-hub"} />
        ) : null}
        {primaryEnvironmentAuthenticated ? <RoleAwareProviderUpdateLaunchNotification /> : null}
        {isElectron ? <DeferredDesktopUpdateNotices /> : null}
        {isElectron && primaryEnvironmentAuthenticated ? <DeferredRunningThreadKeepAlive /> : null}
        {recoveryOwner ? <WebSocketConnectionCoordinator recoveryOwner={recoveryOwner} /> : null}
        <ShellIdlePreloads authGateStatus={authGateState.status} />
        {appShell}
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

/**
 * Writes the Chat width setting to the root, where `index.css` maps it to the chat column
 * widths. Its own component, so a change re-renders nothing else.
 */
function ChatWidthDocumentSync() {
  const chatWidth = useSettings((settings) => settings.chatWidth);
  useEffect(() => {
    document.documentElement.dataset.chatWidth = chatWidth;
  }, [chatWidth]);
  return null;
}

/**
 * Whether an on-demand surface mounts: from the first time `wanted` turns true,
 * once its chunk has loaded, and then for good. It mounts once the chunk
 * resolved, so the first open never commits a Suspense fallback (and never
 * waits on React's fallback-reveal throttle).
 */
function useMountedOnceWanted(component: PreloadableModule, wanted: boolean): boolean {
  const [hasBeenWanted, setHasBeenWanted] = useState(wanted);
  if (wanted && !hasBeenWanted) setHasBeenWanted(true);
  const ready = useLazyComponentReady(component, hasBeenWanted);
  return hasBeenWanted && ready;
}

const AutomationsDialog = preloadableLazy(() =>
  import("./automations/dialog/AutomationsDialog").then((module) => module.AutomationsDialog),
);

/** The Automations dialog loads the first time something opens it, then stays mounted. */
function AutomationsDialogMount() {
  const open = useAutomationsDialogStore((state) => state.open);
  if (!useMountedOnceWanted(AutomationsDialog, open)) return null;
  return <AutomationsDialog />;
}

const PromoteChatDialog = preloadableLazy(() =>
  import("./chat/PromoteChatDialog").then((module) => module.PromoteChatDialog),
);

/** "Turn into project…" loads the first time a chat asks for it, then stays mounted. */
function PromoteChatDialogMount() {
  const open = usePromoteChatDialogStore((state) => state.open);
  if (!useMountedOnceWanted(PromoteChatDialog, open)) return null;
  return <PromoteChatDialog />;
}

const ForkThreadDialog = preloadableLazy(() =>
  import("./chat/ForkThreadDialog").then((module) => module.ForkThreadDialog),
);

/** "Fork from here" loads the first time a reply asks for it, then stays mounted. */
function ForkThreadDialogMount() {
  const open = useForkThreadDialogStore((state) => state.open);
  if (!useMountedOnceWanted(ForkThreadDialog, open)) return null;
  return <ForkThreadDialog />;
}

const ProjectNodesDialogs = preloadableLazy(() =>
  import("./projectNodes/ProjectNodesDialogs").then((module) => module.ProjectNodesDialogs),
);

/**
 * "Add project" and "Copy to another node" load the first time one opens, or
 * a copy starts (its toasts open the copied project through this surface),
 * then stay mounted.
 */
function ProjectNodesDialogsMount() {
  const wanted = useProjectNodesDialogStore(
    (state) => state.addProject.open || state.copyProject.open || state.copiesActive,
  );
  if (!useMountedOnceWanted(ProjectNodesDialogs, wanted)) return null;
  return <ProjectNodesDialogs />;
}

/**
 * Picks up the copies a previous session left unfinished, once the app is
 * idle. The copy runtime loads only when there are stored records.
 */
function useResumeProjectCopies(enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    return scheduleIdleTask(resumeStoredProjectCopies, PROJECT_COPY_RESUME_IDLE_TIMEOUT_MS);
  }, [enabled]);
}

/** Outside the hook: React Compiler does not lower `import()` expressions. */
function resumeStoredProjectCopies(): void {
  if (!hasStoredProjectCopyRecords()) return;
  void import("./projectNodes/copyRuntime/copyManager")
    .then((module) => module.resumeProjectCopies())
    .catch((error: unknown) => console.warn("Resuming project copies failed.", error));
}

const PROJECT_COPY_RESUME_IDLE_TIMEOUT_MS = 5_000;

const SessionImportDialog = preloadableLazy(() =>
  import("./sessionImport/SessionImportDialog").then((module) => module.SessionImportDialog),
);

/** "Import from Codex or Claude Code" loads the first time something opens it, then stays mounted. */
function SessionImportDialogMount() {
  const open = useSessionImportDialogStore((state) => state.open);
  if (!useMountedOnceWanted(SessionImportDialog, open)) return null;
  return <SessionImportDialog />;
}

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId";
const DRAFT_ROUTE_ID = "/_chat/draft/$draftId";

/**
 * Warms the chunks of the most likely next interactions once the shell (and,
 * on a thread boot, that thread) has painted, one download at a time, most
 * likely first: the thread and draft routes, then the command palette, then
 * the settings page. Route-level splitting makes these preloads count: a
 * warmed route commits on the first pass instead of suspending. The frozen
 * phone tier and constrained networks load them on demand instead.
 *
 * When the boot paints a primary shell (see `expectsPrimaryShellPaint`), the
 * start cap is only a safety net: on a slow link the shell snapshot lands well
 * after the default cap, and the preloads would otherwise start ahead of it.
 * A boot on a thread route that leaves it before the thread paints (the thread
 * is gone) starts them at that navigation instead of at the cap.
 */
function ShellIdlePreloads({
  authGateStatus,
}: {
  readonly authGateStatus: RootAppShellProps["authGateState"]["status"];
}) {
  // Decided once for this boot; a later node switch must not reschedule.
  const [primaryShellExpected] = useState(() =>
    expectsPrimaryShellPaint({
      status: authGateStatus,
      routedHostedNodeId: getRoutedHostedNode().nodeId,
    }),
  );
  // The router's logical pathname (hosted node prefixes stripped).
  const pathname = useLocation({ select: (location) => location.pathname });
  const pathnameRef = useRef(pathname);
  const navigationListenersRef = useRef(new Set<() => void>());
  useEffect(() => {
    pathnameRef.current = pathname;
    for (const listener of Array.from(navigationListenersRef.current)) listener();
  }, [pathname]);

  useEffect(() => {
    if (getPresentationTier() === "phone") return;
    return scheduleShellIdlePreloads(
      [
        () => Promise.all([preloadRouteChunk(THREAD_ROUTE_ID), preloadRouteChunk(DRAFT_ROUTE_ID)]),
        preloadCommandPaletteDialog,
        preloadSettingsPage,
      ],
      {
        ...(primaryShellExpected ? { startCapMs: SHELL_IDLE_PRELOAD_PRIMARY_START_CAP_MS } : {}),
        awaitsFirstThreadPaint: () => pathnameMatchesRoute(pathnameRef.current, THREAD_ROUTE_ID),
        subscribeToNavigation: (listener) => {
          const listeners = navigationListenersRef.current;
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
      },
    );
  }, [primaryShellExpected]);
  return null;
}

function RoleAwareProviderUpdateLaunchNotification() {
  // hosted-capability: routed node
  const capability = useHostedRpcCapability(WS_METHODS.serverUpdateProvider, null);
  return capability.allowed ? <ProviderUpdateLaunchNotification /> : null;
}

function HostedStaticEnvironmentBootstrap() {
  // The machines switched on: switching one off or on changes it too.
  const switchedOnEnvironmentKey = useSavedEnvironmentRegistryStore((state) =>
    Object.values(state.byId)
      .filter((record) => !isSavedEnvironmentSwitchedOff(record))
      .map((record) => record.environmentId)
      .join("\n"),
  );

  useEffect(() => {
    if (getPrimaryKnownEnvironment()) {
      return;
    }

    const currentActiveEnvironmentId = useStore.getState().activeEnvironmentId;
    if (currentActiveEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = listSavedEnvironmentRecords().find(
      (record) => !isSavedEnvironmentSwitchedOff(record),
    );
    if (!firstSavedEnvironment) {
      return;
    }

    useStore.getState().setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [switchedOnEnvironmentKey]);

  return null;
}

function AuthenticatedTracingBootstrap() {
  const observability = useServerConfig()?.observability;
  const exportTraces = shouldExportClientTraces({
    observability,
    perfProfile: isWebPerfProfileEnabled(),
  });
  useEffect(() => {
    void (exportTraces ? configureClientTracing() : disableClientTracing());
  }, [exportTraces]);

  return null;
}

// Only desktop apps update themselves or get update requests from other devices; the web build
// never loads these.
const LazyDesktopUpdateNotices = preloadableLazy(() =>
  import("../updates/DesktopUpdateNotices").then((module) => module.DesktopUpdateNotices),
);

const LazyRunningThreadKeepAlive = preloadableLazy(() =>
  import("./desktop/RunningThreadKeepAlive").then((module) => module.RunningThreadKeepAlive),
);

/** Desktop: running threads' detail streams stay subscribed; loaded off the first paint. */
function DeferredRunningThreadKeepAlive() {
  const ready = useLazyComponentReady(LazyRunningThreadKeepAlive, true, {
    onLoadError: (error) => console.warn("Running thread keep-alive failed to load.", error),
  });
  return ready ? <LazyRunningThreadKeepAlive /> : null;
}

function DeferredDesktopUpdateNotices() {
  const ready = useLazyComponentReady(LazyDesktopUpdateNotices, true, {
    onLoadError: (error) => console.warn("Desktop update notices failed to load.", error),
  });
  return ready ? <LazyDesktopUpdateNotices /> : null;
}

function EnvironmentConnectionManagerBootstrap() {
  useEffect(() => {
    const stopEnvironmentConnections = startEnvironmentConnectionService();
    const stopDesktopWorkspace = startDesktopWorkspaceBridge();
    // Follows the update state of the nodes those connections reach; it opens none. Loaded
    // off the shell's critical path, like the update pill that shows it.
    let disposed = false;
    let stopNodeUpdates: (() => void) | null = null;
    let stopInteractionReports: (() => void) | null = null;
    void import("../updates/nodeUpdateStore")
      .then(({ startNodeUpdateWiring }) => {
        if (!disposed) stopNodeUpdates = startNodeUpdateWiring();
      })
      .catch((error: unknown) => console.warn("Node update following failed to load.", error));
    // Nodes that update themselves unattended wait while someone uses this app.
    void import("../updates/clientInteractionReporting")
      .then(({ startClientInteractionReporting }) => {
        if (!disposed) stopInteractionReports = startClientInteractionReporting();
      })
      .catch((error: unknown) => console.warn("Interaction reports failed to load.", error));
    // Shared device settings catch up on devices that come back online, settings open or not.
    const stopSettingsSharing = scheduleSettingsSharingStart();
    return () => {
      disposed = true;
      stopSettingsSharing();
      stopNodeUpdates?.();
      stopInteractionReports?.();
      stopDesktopWorkspace();
      stopEnvironmentConnections();
    };
  }, []);

  return null;
}

function EventRouter({ hosted }: { readonly hosted: boolean }) {
  const setActiveEnvironmentId = useStore((store) => store.setActiveEnvironmentId);
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const hostedPrimaryEnvironmentId = hosted ? primaryEnvironmentId : null;
  const navigate = useNavigate();
  const pathname = useLocation({ select: (loc) => loc.pathname });
  const projectGroupingSettings = useSettings((settings) => ({
    sidebarProjectGroupingMode: settings.sidebarProjectGroupingMode,
    sidebarProjectGroupingOverrides: settings.sidebarProjectGroupingOverrides,
  }));
  const readPathname = useEffectEvent(() => pathname);
  const handledBootstrapThreadIdRef = useRef<string | null>(null);
  const disposedRef = useRef(false);
  const serverConfig = useServerConfig();

  const handleWelcome = useEffectEvent((payload: ServerLifecycleWelcomePayload | null) => {
    if (!payload) return;

    const environmentId = resolveCanonicalPrimaryEnvironmentId({
      hosted,
      primaryEnvironmentId: hostedPrimaryEnvironmentId,
      serverEnvironmentId: payload.environment.environmentId,
    });
    if (!environmentId) return;

    if (!hosted) {
      updatePrimaryEnvironmentDescriptor(payload.environment);
    }
    setActiveEnvironmentId(environmentId);
    if (
      payload.bootstrapThreadId &&
      shouldApplyBootstrapThreadRedirect({
        pathname: readPathname(),
        tier: getPresentationTier(),
        hostedHome: hosted && getRoutedHostedNode().nodeId === null,
      })
    ) {
      // The redirect below waits for the shell snapshot; start the thread
      // route chunk now so it downloads alongside instead of after it.
      void preloadRouteChunk(THREAD_ROUTE_ID);
      if (!hosted) prewarmThreadDetailSubscription(environmentId, payload.bootstrapThreadId);
    }
    void (async () => {
      await ensureEnvironmentConnectionBootstrapped(environmentId);
      if (disposedRef.current) {
        return;
      }

      if (!payload.bootstrapProjectId || !payload.bootstrapThreadId) {
        return;
      }
      const bootstrapEnvironmentState = useStore.getState().environmentStateById[environmentId];
      const bootstrapProject =
        bootstrapEnvironmentState?.projectById[payload.bootstrapProjectId] ?? null;
      const bootstrapProjectKey =
        (bootstrapProject
          ? deriveLogicalProjectKeyFromSettings(bootstrapProject, projectGroupingSettings)
          : null) ??
        (serverConfig?.cwd
          ? derivePhysicalProjectKeyFromPath(environmentId, serverConfig.cwd)
          : null) ??
        scopedProjectKey(scopeProjectRef(environmentId, payload.bootstrapProjectId));
      useUiStateStore.getState().setProjectExpanded(bootstrapProjectKey, true);

      // Desktop keeps the last-thread redirect; the phone tier lands on Home.
      if (
        !shouldApplyBootstrapThreadRedirect({
          pathname: readPathname(),
          tier: getPresentationTier(),
          hostedHome: hosted && getRoutedHostedNode().nodeId === null,
        })
      ) {
        return;
      }
      if (handledBootstrapThreadIdRef.current === payload.bootstrapThreadId) {
        return;
      }
      await navigate({
        to: "/$environmentId/$threadId",
        params: {
          environmentId,
          threadId: payload.bootstrapThreadId,
        },
        replace: true,
      });
      handledBootstrapThreadIdRef.current = payload.bootstrapThreadId;
    })().catch(() => undefined);
  });

  useEffect(() => {
    if (!serverConfig) {
      return;
    }

    const environmentId = resolveCanonicalPrimaryEnvironmentId({
      hosted,
      primaryEnvironmentId: hostedPrimaryEnvironmentId,
      serverEnvironmentId: serverConfig.environment.environmentId,
    });
    if (!environmentId) return;

    if (!hosted) {
      updatePrimaryEnvironmentDescriptor(serverConfig.environment);
    }
    setActiveEnvironmentId(environmentId);
  }, [hosted, hostedPrimaryEnvironmentId, serverConfig, setActiveEnvironmentId]);

  useEffect(() => {
    disposedRef.current = false;
    return () => {
      disposedRef.current = true;
    };
  }, []);

  useServerWelcomeSubscription(handleWelcome);

  return null;
}
