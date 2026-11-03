import { createDesktopQuitGuardResponder } from "./desktopQuitGuard.logic";
import { readPrimaryEnvironmentDescriptor } from "./environments/primary";
import { ensureLocalApi } from "./localApi";
import { applySettingsUpdated, getServerConfig } from "./rpc/serverState";
import {
  selectBootstrapCompleteForEnvironment,
  selectSidebarThreadsAcrossEnvironments,
  useStore,
} from "./store";

/**
 * Lets Desktop main ask this window, before a quit, which chats on its own backend quitting
 * would stop, and save "Continue after restart" on that backend. Returns the unregister.
 */
export function startDesktopQuitGuardResponder(): () => void {
  const quitGuard = window.desktopBridge?.quitGuard;
  if (typeof quitGuard?.register !== "function") return () => undefined;
  return quitGuard.register(
    createDesktopQuitGuardResponder({
      readThreads: () => selectSidebarThreadsAcrossEnvironments(useStore.getState()),
      readLocalEnvironment: () => {
        const id = readPrimaryEnvironmentDescriptor()?.environmentId ?? null;
        return { id, live: selectBootstrapCompleteForEnvironment(useStore.getState(), id) };
      },
      // A desktop's global server config is its own backend's (it never follows the active
      // environment), and `ensureLocalApi().server` writes to that backend.
      readContinueSetting: () => getServerConfig()?.settings.continueThreadsAfterRestart ?? null,
      writeContinueSetting: async (enabled) => {
        applySettingsUpdated(
          await ensureLocalApi().server.updateSettings({ continueThreadsAfterRestart: enabled }),
        );
      },
    }),
  );
}
