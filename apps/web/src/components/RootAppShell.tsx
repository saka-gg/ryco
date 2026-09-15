import { type ServerLifecycleWelcomePayload, WS_METHODS } from "@ryco/contracts";
import { scopedProjectKey, scopeProjectRef } from "@ryco/client-runtime/scoped";
import { Outlet, useLocation, useNavigate } from "@tanstack/react-router";
import { useEffect, useEffectEvent, useRef } from "react";

import { OnboardingCoordinator } from "./onboarding/OnboardingCoordinator";
import { AppSidebarLayout } from "./AppSidebarLayout";
import { CommandPalette } from "./CommandPalette";
import {
  resolveCanonicalPrimaryEnvironmentId,
  shouldApplyBootstrapThreadRedirect,
} from "./RootAppShell.logic";
import { ContextMenuActionSheetHost } from "./shell/phone/ContextMenuActionSheetHost";
import { SshPasswordPromptDialog } from "./desktop/SshPasswordPromptDialog";
import { ProviderUpdateLaunchNotification } from "./ProviderUpdateLaunchNotification";
import {
  SlowRpcAckToastCoordinator,
  WebSocketConnectionCoordinator,
  WebSocketConnectionSurface,
} from "./WebSocketConnectionSurface";
import { AnchoredToastProvider, stackedThreadToast, ToastProvider, toastManager } from "./ui/toast";
import { resolveAndPersistPreferredEditor } from "../editorPreferences";
import { readLocalApi } from "../localApi";
import { getPresentationTier } from "../lib/presentationTier";
import { useSettings } from "../hooks/useSettings";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import {
  deriveLogicalProjectKeyFromSettings,
  derivePhysicalProjectKeyFromPath,
} from "../logicalProject";
import {
  getServerConfigUpdatedNotification,
  ServerConfigUpdatedNotification,
  useServerConfig,
  useServerConfigUpdatedSubscription,
  useServerWelcomeSubscription,
} from "../rpc/serverState";
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

export interface RootAppShellProps {
  readonly authGateState: {
    readonly status: "authenticated" | "hosted-static" | "hosted-hub" | "hosted-cached";
  };
}

export function RootAppShell({ authGateState }: RootAppShellProps) {
  const primaryEnvironmentAuthenticated =
    authGateState.status === "authenticated" || authGateState.status === "hosted-hub";
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
        <ContextMenuActionSheetHost />
        <SshPasswordPromptDialog />
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
        {primaryEnvironmentAuthenticated ? <SlowRpcAckToastCoordinator /> : null}
        {primaryEnvironmentAuthenticated ? (
          <WebSocketConnectionSurface>{appShell}</WebSocketConnectionSurface>
        ) : (
          appShell
        )}
      </AnchoredToastProvider>
    </ToastProvider>
  );
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
  const seenServerConfigUpdateIdRef = useRef(getServerConfigUpdatedNotification()?.id ?? 0);
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

  const handleServerConfigUpdated = useEffectEvent(
    (notification: ServerConfigUpdatedNotification | null) => {
      if (!notification) return;

      const { id, payload, source } = notification;
      if (id <= seenServerConfigUpdateIdRef.current) {
        return;
      }
      seenServerConfigUpdateIdRef.current = id;
      if (source !== "keybindingsUpdated") {
        return;
      }

      const issue = payload.issues.find((entry) => entry.kind.startsWith("keybindings."));
      if (!issue) {
        toastManager.add({
          type: "success",
          title: "Keybindings updated",
          description: "Keybindings configuration reloaded successfully.",
        });
        return;
      }

      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Invalid keybindings configuration",
          description: issue.message,
          actionVariant: "outline",
          actionProps: {
            children: "Open keybindings.json",
            onClick: () => {
              const api = readLocalApi();
              if (!api) {
                return;
              }

              void Promise.resolve(serverConfig ?? api.server.getConfig())
                .then((config) => {
                  const editor = resolveAndPersistPreferredEditor(config.availableEditors);
                  if (!editor) {
                    throw new Error("No available editors found.");
                  }
                  return api.shell.openInEditor(config.keybindingsConfigPath, editor);
                })
                .catch((error) => {
                  toastManager.add(
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to open keybindings file",
                      description:
                        error instanceof Error ? error.message : "Unknown error opening file.",
                    }),
                  );
                });
            },
          },
        }),
      );
    },
  );

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
  useServerConfigUpdatedSubscription(handleServerConfigUpdated);

  return null;
}
