/**
 * The phone's per-machine "Import conversations" screen as plain data. The flow itself is the
 * shared controller (`@ryco/client-runtime/state/sessionImport`, `conversationImport.ts`) the
 * web's Settings panel uses; this file only adapts the machine to it: who may import, which
 * client the calls go to, the machine's projects and the button's words.
 */
import type { WsRpcClient } from "@ryco/client-runtime/rpc";
import {
  SESSION_IMPORT_RECONNECT,
  sessionImportConversationCount,
  type ConversationImportProject,
  type ConversationImportView,
  type SessionImportClient,
} from "@ryco/client-runtime/state/sessionImport";
import type { EnvironmentId, ProjectKind } from "@ryco/contracts";
import { excludeChatProjects } from "@ryco/shared/projectKind";

/**
 * The machine's import calls, read fresh for every call: its live connection's client. Throws
 * without one. The shared controller refuses every call itself once this device is no longer
 * the machine's connected owner (`SESSION_IMPORT_RECONNECT`), so an import already running
 * stops with that reason on the item it reached rather than outliving that access.
 */
export function createMachineImportClient(
  readClient: () => WsRpcClient | null,
): () => SessionImportClient {
  return () => {
    const client = readClient();
    if (!client) throw new Error(SESSION_IMPORT_RECONNECT);
    return client.sessionImport;
  };
}

/** The machine's projects that can receive imports, by name. Chats are never a destination. */
export function machineImportProjects(
  projects: ReadonlyArray<{
    readonly id: string;
    readonly name: string;
    readonly environmentId: EnvironmentId;
    readonly kind?: ProjectKind | undefined;
  }>,
  environmentId: EnvironmentId,
): ReadonlyArray<ConversationImportProject> {
  return excludeChatProjects(projects.filter((project) => project.environmentId === environmentId))
    .map((project) => ({ id: project.id, name: project.name }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
}

/** The primary button: what a tap does now. */
export function machineImportButtonLabel(view: ConversationImportView): string {
  if (view.busy) return "Working…";
  if (view.importableCount === 0) return "Select conversations";
  return `Import ${sessionImportConversationCount(view.importableCount)}`;
}

/** The primary button takes a tap: a run may start and would import something. */
export function machineImportCanRun(view: ConversationImportView): boolean {
  return view.canRun && view.importableCount > 0;
}
