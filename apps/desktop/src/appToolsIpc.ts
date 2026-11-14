import * as FS from "node:fs";

import type { DesktopDatabaseCompactionState } from "@ryco/contracts";
import { dialog } from "electron";

import { appSenderWindow, handleAppInvoke } from "./appInvoke.ts";
import type { DesktopCliCommandEnvironment } from "./desktopCliCommand.ts";
import type { NightlyHandoffEnvironment } from "./nightlyHandoff.ts";
import { saveThreadExport } from "./threadExportSave.ts";
import {
  DATABASE_COMPACTION_GET_STATE_CHANNEL,
  DATABASE_COMPACTION_START_CHANNEL,
  DATABASE_COMPACTION_CANCEL_CHANNEL,
  SAVE_THREAD_EXPORT_CHANNEL,
  CLI_COMMAND_STATE_CHANNEL,
  CLI_COMMAND_INSTALL_CHANNEL,
  CLI_COMMAND_UNINSTALL_CHANNEL,
  NIGHTLY_STATE_CHANNEL,
  NIGHTLY_OPEN_CHANNEL,
  NIGHTLY_SWITCH_BACK_CHANNEL,
} from "./desktopIpcChannels.ts";

/** What the database compaction, thread export, command line and Ryco Nightly channels need from main. */
export interface AppToolsIpcDeps {
  readonly databaseCompactionState: () => DesktopDatabaseCompactionState;
  readonly startDatabaseCompaction: () => Promise<DesktopDatabaseCompactionState>;
  readonly cancelDatabaseCompaction: () => void;
  readonly desktopCliCommandEnvironment: () => DesktopCliCommandEnvironment;
  /** What Ryco and Ryco Nightly read to find and open each other (`nightlyHandoff.ts`). */
  readonly nightlyHandoffEnvironment: () => Promise<NightlyHandoffEnvironment>;
}

/** One "Open Ryco Nightly" at a time: a second would write a request no launch carries. */
let nightlyOpenInFlight = false;

/** Database compaction, retained-thread export, the `ryco` command line tool and Ryco Nightly. */
export function registerAppToolsIpc(deps: AppToolsIpcDeps): void {
  handleAppInvoke(DATABASE_COMPACTION_GET_STATE_CHANNEL, () => deps.databaseCompactionState(), {
    requireMainFrame: true,
  });
  handleAppInvoke(
    DATABASE_COMPACTION_START_CHANNEL,
    () => {
      // Answers at once; progress and the result follow on the state channel.
      void deps.startDatabaseCompaction();
      return deps.databaseCompactionState();
    },
    { requireMainFrame: true },
  );
  handleAppInvoke(DATABASE_COMPACTION_CANCEL_CHANNEL, () => deps.cancelDatabaseCompaction(), {
    requireMainFrame: true,
  });
  handleAppInvoke(
    SAVE_THREAD_EXPORT_CHANNEL,
    async (event, raw: unknown) => {
      const owner = appSenderWindow(event);
      return saveThreadExport(raw, {
        choose: async (filename) => {
          const result = await dialog.showSaveDialog(owner, {
            title: "Save retained conversation",
            defaultPath: filename,
            filters: [{ name: "Markdown", extensions: ["md"] }],
          });
          return result.canceled ? null : (result.filePath ?? null);
        },
        write: (path, contents) => FS.promises.writeFile(path, contents, "utf8"),
      });
    },
    { requireMainFrame: true },
  );
  for (const [channel, action] of [
    [CLI_COMMAND_STATE_CHANNEL, "state"],
    [CLI_COMMAND_INSTALL_CHANNEL, "install"],
    [CLI_COMMAND_UNINSTALL_CHANNEL, "uninstall"],
  ] as const) {
    handleAppInvoke(
      channel,
      async () => {
        const cli = await import("./desktopCliCommand.ts");
        const environment = deps.desktopCliCommandEnvironment();
        if (action === "install") return cli.installDesktopCliCommand(environment);
        if (action === "uninstall") return cli.uninstallDesktopCliCommand(environment);
        return cli.readDesktopCliCommandState(environment);
      },
      { requireMainFrame: true },
    );
  }
  handleAppInvoke(
    NIGHTLY_STATE_CHANNEL,
    async () => {
      const handoff = await import("./nightlyHandoff.ts");
      return handoff.readNightlyState(await deps.nightlyHandoffEnvironment());
    },
    { requireMainFrame: true },
  );
  handleAppInvoke(
    NIGHTLY_OPEN_CHANNEL,
    async (_event, input: unknown) => {
      const copyData =
        typeof input === "object" && input !== null && (input as { copyData?: unknown }).copyData;
      if (typeof copyData !== "boolean") throw new Error("Invalid Ryco Nightly request.");
      if (nightlyOpenInFlight) throw new Error("Ryco Nightly is already opening.");
      nightlyOpenInFlight = true;
      try {
        const handoff = await import("./nightlyHandoff.ts");
        await handoff.openNightly(await deps.nightlyHandoffEnvironment(), { copyData });
      } finally {
        nightlyOpenInFlight = false;
      }
    },
    { requireMainFrame: true },
  );
  handleAppInvoke(
    NIGHTLY_SWITCH_BACK_CHANNEL,
    async () => {
      const handoff = await import("./nightlyHandoff.ts");
      await handoff.switchBackToRyco(await deps.nightlyHandoffEnvironment());
    },
    { requireMainFrame: true },
  );
}
