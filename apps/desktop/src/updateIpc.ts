import type {
  DesktopUpdateActionResult,
  DesktopUpdateCheckResult,
  DesktopUpdateState,
} from "@ryco/contracts";

import { handleAppInvoke } from "./appInvoke.ts";
import { parseRemoteInstallResponse, type RemoteInstallResponse } from "./remoteAppInstall.ts";
import {
  UPDATE_GET_STATE_CHANNEL,
  UPDATE_CHECK_CHANNEL,
  UPDATE_DOWNLOAD_CHANNEL,
  UPDATE_INSTALL_CHANNEL,
  UPDATE_REMOTE_INSTALL_RESPONSE_CHANNEL,
} from "./desktopIpcChannels.ts";

interface UpdateActionOutcome {
  readonly accepted: boolean;
  readonly completed: boolean;
}

/** What the update channels need from main's updater. */
export interface UpdateIpcDeps {
  readonly updateState: () => DesktopUpdateState;
  readonly isQuitting: () => boolean;
  readonly updaterConfigured: () => boolean;
  readonly ensureAutoUpdaterConfigured: () => Promise<unknown>;
  readonly checkForUpdates: (reason: string) => Promise<boolean>;
  readonly downloadAvailableUpdate: () => Promise<UpdateActionOutcome>;
  readonly installDownloadedUpdate: () => Promise<UpdateActionOutcome>;
  readonly remoteAppInstaller: () => { respond(action: RemoteInstallResponse): void };
}

/** Update state, check, download, install and the answer to a remote install request. */
export function registerUpdateIpc(deps: UpdateIpcDeps): void {
  handleAppInvoke(UPDATE_GET_STATE_CHANNEL, async () => deps.updateState(), {
    requireMainFrame: false,
  });

  handleAppInvoke(
    UPDATE_DOWNLOAD_CHANNEL,
    async () => {
      const result = await deps.downloadAvailableUpdate();
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: deps.updateState(),
      } satisfies DesktopUpdateActionResult;
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    UPDATE_INSTALL_CHANNEL,
    async () => {
      if (deps.isQuitting()) {
        return {
          accepted: false,
          completed: false,
          state: deps.updateState(),
        } satisfies DesktopUpdateActionResult;
      }
      const result = await deps.installDownloadedUpdate();
      return {
        accepted: result.accepted,
        completed: result.completed,
        state: deps.updateState(),
      } satisfies DesktopUpdateActionResult;
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    UPDATE_CHECK_CHANNEL,
    async () => {
      await deps.ensureAutoUpdaterConfigured().catch(() => undefined);
      if (!deps.updaterConfigured()) {
        return {
          checked: false,
          state: deps.updateState(),
        } satisfies DesktopUpdateCheckResult;
      }
      const checked = await deps.checkForUpdates("web-ui");
      return {
        checked,
        state: deps.updateState(),
      } satisfies DesktopUpdateCheckResult;
    },
    { requireMainFrame: false },
  );

  handleAppInvoke(
    UPDATE_REMOTE_INSTALL_RESPONSE_CHANNEL,
    async (_event, rawAction: unknown) => {
      const action = parseRemoteInstallResponse(rawAction);
      if (action === null) {
        throw new Error("Invalid remote install response.");
      }
      deps.remoteAppInstaller().respond(action);
      return deps.updateState();
    },
    { requireMainFrame: false },
  );
}
