import { type ServerLifecycleWelcomePayload, WS_METHODS } from "@ryco/contracts";
import { scopedProjectKey, scopeProjectRef } from "@ryco/client-runtime/scoped";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { OnboardingCoordinator } from "./onboarding/OnboardingCoordinator";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { CommandPalette, preloadCommandPaletteDialog } from "./CommandPalette";
import {
  resolveCanonicalPrimaryEnvironmentId,
  shouldApplyBootstrapThreadRedirect,
} from "./RootAppShell.logic";
import { ContextMenuActionSheetHost } from "./shell/phone/ContextMenuActionSheetHost";
import { SshPasswordPromptDialog } from "./desktop/SshPasswordPromptDialog";
import { WorkspaceReviewDialog } from "./worktrees/WorkspaceReviewDialog";
import { useAutomationsDialogStore } from "./automations/automationsDialogStore";
import { usePromoteChatDialogStore } from "./chat/promoteChatDialogStore";
import { useForkThreadDialogStore } from "./chat/forkThreadDialogStore";
import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import { MissedAutomationRunsNotice } from "./automations/MissedAutomationRunsNotice";
import { WebSocketConnectionCoordinator } from "./WebSocketConnectionSurface";
import { AnchoredToastProvider, ToastProvider } from "./ui/toast";
import { getPresentationTier } from "../lib/presentationTier";
import { preloadableLazy, useLazyComponentReady } from "../lib/preloadableLazy";
import { preloadRouteChunk } from "../lib/routeChunkPreload";
import { scheduleShellIdlePreloads } from "../lib/shellIdlePreload";
import { prewarmThreadDetailSubscription } from "../lib/threadDetailPrewarm";
import { preloadSettingsPage } from "../settingsRoute";
import { useSettings } from "../hooks/useSettings";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
} from "../logicalProject";
import { useServerConfig, useServerWelcomeSubscription } from "../rpc/serverState";
import { useStore } from "../store";
import { useUiStateStore } from "../uiStateStore";
import {
  ensureEnvironmentConnectionBootstrapped,
  listSavedEnvironmentRecords,
  startEnvironmentConnectionService,
  useSavedEnvironmentRegistryStore,
} from "../environments/runtime";
import { startDesktopWorkspaceBridge } from "../platform/desktopWorkspace";
import { configureClientTracing } from "../observability/clientTracing";
import {
  getPrimaryKnownEnvironment,
  updatePrimaryEnvironmentDescriptor,
  usePrimaryEnvironmentId,
} from "../environments/primary";
import { ServerStateBootstrap } from "./ServerStateBootstrap";
import { ThreadPriorityRefreshBridge } from "./ThreadPriorityRefreshBridge";
import { MessageQueueDrainBridge } from "./MessageQueueDrainBridge";
import { getRoutedHostedNode } from "../hostedHub/nodeRoutes";

export interface RootAppShellProps {
  readonly authGateState: {
    readonly status: "authenticated" | "hosted-static" | "hosted-hub" | "hosted-cached";
  };
}

export function RootAppShell({ authGateState }: RootAppShellProps) {
  const primaryEnvironmentAuthenticated =
    authGateState.status === "authenticated" || authGateState.status === "hosted-hub";
  // Every state with chat routes can queue, including hosted-static, which sends
  // to saved environments; readiness is per environment.
  const chatAvailable = primaryEnvironmentAuthenticated || authGateState.status === "hosted-static";
  const localTracingAllowed = authGateState.status === "authenticated";
  // The presentation-tier seam lives inside `AppSidebarLayout`: the provider
  // and the route subtree stay mounted identically for both tiers (a tier
  // flip must not remount the workspace); only the sidebar chrome forks.
  const appShell = (
    <CommandPalette>
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
        {primaryEnvironmentAuthenticated ? <ServerStateBootstrap /> : null}
        <EnvironmentConnectionManagerBootstrap />
        {primaryEnvironmentAuthenticated ? <ThreadPriorityRefreshBridge /> : null}
        {chatAvailable ? <MessageQueueDrainBridge /> : null}
        <ContextMenuActionSheetHost />
        <SshPasswordPromptDialog />
        <WorkspaceReviewDialog />
        {chatAvailable ? <AutomationsDialogMount /> : null}
        {chatAvailable ? <PromoteChatDialogMount /> : null}
        {chatAvailable ? <ForkThreadDialogMount /> : null}
        {chatAvailable ? <MissedAutomationRunsNotice /> : null}
        {authGateState.status === "hosted-static" ? <HostedStaticEnvironmentBootstrap /> : null}
        {primaryEnvironmentAuthenticated ? (
          <EventRouter hosted={authGateState.status === "hosted-hub"} />
        ) : null}
        {primaryEnvironmentAuthenticated ? <RoleAwareProviderUpdateLaunchNotification /> : null}
        {primaryEnvironmentAuthenticated ? (
          <WebSocketConnectionCoordinator
            recoveryOwner={authGateState.status === "hosted-hub" ? "hosted-lifecycle" : "generic"}
          />
        ) : null}
        <ShellIdlePreloads />
        {appShell}
      </AnchoredToastProvider>
    </ToastProvider>
  );
}

const AutomationsDialog = preloadableLazy(() =>
  import("./automations/dialog/AutomationsDialog").then((module) => module.AutomationsDialog),
);

/**
 * The Automations dialog loads the first time something opens it, then stays
 * mounted. It mounts once its chunk resolved, so the open never commits a
 * Suspense fallback (and never waits on React's fallback-reveal throttle).
 */
function AutomationsDialogMount() {
  const open = useAutomationsDialogStore((state) => state.open);
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);
  const ready = useLazyComponentReady(AutomationsDialog, hasOpened);
  if (!hasOpened || !ready) return null;
  return <AutomationsDialog />;
}

const PromoteChatDialog = preloadableLazy(() =>
  import("./chat/PromoteChatDialog").then((module) => module.PromoteChatDialog),
);

/** "Turn into project…" loads the first time a chat asks for it, then stays mounted. */
function PromoteChatDialogMount() {
  const open = usePromoteChatDialogStore((state) => state.open);
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);
  const ready = useLazyComponentReady(PromoteChatDialog, hasOpened);
  if (!hasOpened || !ready) return null;
  return <PromoteChatDialog />;
}

const ForkThreadDialog = preloadableLazy(() =>
  import("./chat/ForkThreadDialog").then((module) => module.ForkThreadDialog),
);

/** "Fork from here" loads the first time a reply asks for it, then stays mounted. */
function ForkThreadDialogMount() {
  const open = useForkThreadDialogStore((state) => state.open);
  const [hasOpened, setHasOpened] = useState(open);
  if (open && !hasOpened) setHasOpened(true);
  const ready = useLazyComponentReady(ForkThreadDialog, hasOpened);
  if (!hasOpened || !ready) return null;
  return <ForkThreadDialog />;
}

const THREAD_ROUTE_ID = "/_chat/$environmentId/$threadId";
const DRAFT_ROUTE_ID = "/_chat/draft/$draftId";

/**
 * Warms the chunks of the most likely next interactions once the shell has
 * painted, one idle period each, most likely first: the thread and draft
 * routes, then the command palette, then the settings page. Route-level
 * splitting makes these preloads count: a warmed route commits on the first
 * pass instead of suspending. The frozen phone tier and constrained networks
 * load them on demand instead.
 */
function ShellIdlePreloads() {
  useEffect(() => {
    if (getPresentationTier() === "phone") return;
    return scheduleShellIdlePreloads([
      () => {
        void preloadRouteChunk(THREAD_ROUTE_ID);
        void preloadRouteChunk(DRAFT_ROUTE_ID);
      },
      preloadCommandPaletteDialog,
      preloadSettingsPage,
    ]);
  }, []);
  return null;
}

function RoleAwareProviderUpdateLaunchNotification() {
  const capability = useHostedRpcCapability(WS_METHODS.serverUpdateProvider);
  return capability.allowed ? <ProviderUpdateLaunchNotification /> : null;
}

function HostedStaticEnvironmentBootstrap() {
  const savedEnvironmentCount = useSavedEnvironmentRegistryStore(
    (state) => Object.keys(state.byId).length,
  );

  useEffect(() => {
    if (getPrimaryKnownEnvironment()) {
      return;
    }

    const currentActiveEnvironmentId = useStore.getState().activeEnvironmentId;
    if (currentActiveEnvironmentId) {
      return;
    }

    const firstSavedEnvironment = listSavedEnvironmentRecords()[0];
    if (!firstSavedEnvironment) {
      return;
    }

    useStore.getState().setActiveEnvironmentId(firstSavedEnvironment.environmentId);
  }, [savedEnvironmentCount]);

  return null;
}

function AuthenticatedTracingBootstrap() {
  useEffect(() => {
    void configureClientTracing();
  }, []);

  return null;
}

function EnvironmentConnectionManagerBootstrap() {
  useEffect(() => {
    const stopEnvironmentConnections = startEnvironmentConnectionService();
    const stopDesktopWorkspace = startDesktopWorkspaceBridge();
    return () => {
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
