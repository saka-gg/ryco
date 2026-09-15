import { useEffect, useRef, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { ORCHESTRATION_WS_METHODS, type ScopedThreadRef } from "@ryco/contracts";
import { useHostedRpcCapability } from "../hostedHub/capabilities";
import { exportThreadMarkdown } from "../lib/threadExport";
import { toastManager } from "../components/ui/toast";
import { ITEM_ICON_CLASS, type CommandPaletteActionItem } from "../components/CommandPalette.logic";

export function useThreadExportAction(thread: ScopedThreadRef | null): CommandPaletteActionItem {
  const controllerRef = useRef<AbortController | null>(null);
  const [exporting, setExporting] = useState(false);
  useEffect(() => () => controllerRef.current?.abort(), []);
  const capability = useHostedRpcCapability(ORCHESTRATION_WS_METHODS.getThreadWindow);
  return {
    kind: "action",
    // The palette owns this hook; closing it aborts the in-flight read.
    keepOpen: true,
    value: "action:export-thread-markdown",
    title: exporting ? "Cancel thread export" : "Export thread as Markdown",
    searchTerms: ["export", "markdown", "download", "conversation"],
    icon: <DownloadIcon className={ITEM_ICON_CLASS} />,
    disabled: !exporting && (!thread || !capability.allowed),
    run: async () => {
      if (controllerRef.current) {
        controllerRef.current.abort();
        return;
      }
      if (!thread || !capability.allowed) return;
      const controller = new AbortController();
      controllerRef.current = controller;
      setExporting(true);
      const toastId = toastManager.add({
        title: "Loading retained conversation…",
        timeout: 0,
        actionProps: { children: "Cancel", onClick: () => controller.abort() },
      });
      try {
        const result = await exportThreadMarkdown(thread, controller.signal);
        if (result !== "cancelled")
          toastManager.add({
            type: "success",
            title: result === "saved" ? "Conversation saved" : "Conversation download started",
          });
      } catch (error) {
        if (!controller.signal.aborted)
          toastManager.add({
            type: "error",
            title: "Export failed",
            description:
              error instanceof Error ? error.message : "No file was saved. Retry the export.",
          });
      } finally {
        toastManager.close(toastId);
        controllerRef.current = null;
        setExporting(false);
      }
    },
  };
}
