import type { SidebarActionCommand } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ThreadId } from "@ryco/contracts";
import { Alert } from "react-native";

import { sidebarUndo } from "../../state/sidebarUndo";
import { withThreadDismissal } from "./threadDismissal";

/**
 * Sends one thread-list command (Inbox, Archived) through the shared Undo
 * history. A command that takes the row out of where it is listed lets the row
 * animate out first and brings it back when the command fails; a failure is
 * reported under `failureTitle`.
 */
export function dispatchThreadListCommand(
  row: {
    readonly key: string;
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  },
  command: SidebarActionCommand,
  options: { readonly dismiss: boolean; readonly failureTitle: string },
): void {
  const target = { environmentId: row.environmentId, threadId: row.threadId };
  const send = async () => {
    await sidebarUndo.dispatch(target, command);
    return true;
  };
  void (options.dismiss ? withThreadDismissal(row.key, send, Boolean) : send()).catch(
    (error: unknown) =>
      Alert.alert(
        options.failureTitle,
        error instanceof Error ? error.message : "The request failed.",
      ),
  );
}
