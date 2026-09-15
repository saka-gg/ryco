import type { ScopedThreadRef } from "@ryco/contracts";
import { loadThreadForExport, THREAD_EXPORT_RETRY } from "@ryco/client-runtime/connection";
import { getWsConnectionStatusForEnvironment } from "@ryco/client-runtime/rpc";
import { serializeThreadMarkdown, threadExportFilename } from "@ryco/shared/threadExport";
import { readEnvironmentApi } from "../environmentApi";
import { readEnvironmentConnection } from "../environments/runtime";
import { isElectron, isHostedHubMode } from "../env";
import { resolveHostedRpcCapability } from "../hostedHub/capabilities";
import { useHostedHubStore } from "../hostedHub/state";
import { ORCHESTRATION_WS_METHODS } from "@ryco/contracts";
import { downloadPlanAsTextFile } from "../proposedPlan";

export async function exportThreadMarkdown(
  ref: ScopedThreadRef,
  signal: AbortSignal,
): Promise<"saved" | "downloaded" | "cancelled"> {
  const api = readEnvironmentApi(ref.environmentId);
  const connection = readEnvironmentConnection(ref.environmentId);
  const initial = { ...getWsConnectionStatusForEnvironment(ref.environmentId) };
  const isCurrent = () => {
    const status = getWsConnectionStatusForEnvironment(ref.environmentId);
    const hosted = useHostedHubStore.getState();
    return (
      readEnvironmentConnection(ref.environmentId) === connection &&
      status.phase === "connected" &&
      status.connectedAt === initial.connectedAt &&
      status.disconnectedAt === initial.disconnectedAt &&
      resolveHostedRpcCapability({
        hosted: isHostedHubMode(),
        role: hosted.effectiveRole,
        fresh: hosted.directoryStatus === "ready" && hosted.transportStatus === "online",
        browserCurrent: hosted.browserStatus === "current",
        sessionReady: hosted.sessionStatus === "ready",
        method: ORCHESTRATION_WS_METHODS.getThreadWindow,
      }).allowed
    );
  };
  if (!api || !isCurrent()) throw new Error(THREAD_EXPORT_RETRY);
  const thread = await loadThreadForExport({ api, threadId: ref.threadId, signal, isCurrent });
  const contents = serializeThreadMarkdown(thread);
  const filename = threadExportFilename(thread.title);
  signal.throwIfAborted();
  if (!isCurrent()) throw new Error(THREAD_EXPORT_RETRY);
  if (new TextEncoder().encode(contents).length > 32 * 1024 * 1024)
    throw new Error("Conversation exceeds the 32 MiB export limit. No partial file was saved.");
  if (isElectron) {
    if (!window.desktopBridge?.saveThreadExport)
      throw new Error("Update the desktop app to save conversation exports.");
    return (await window.desktopBridge.saveThreadExport({ filename, contents })).status;
  }
  downloadPlanAsTextFile(filename, contents);
  return "downloaded";
}
