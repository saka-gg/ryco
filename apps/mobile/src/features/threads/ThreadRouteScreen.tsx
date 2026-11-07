import { useFocusEffect, type StaticScreenProps } from "@react-navigation/native";
import { useCallback } from "react";

import { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts/base-schemas";

import { markThreadVisible } from "../../notifications/visibleThread";
import { selectSidebarThreadSummaryByRef, useStore } from "../../state/threadsRuntime";
import { recordRecentThreadShortcut } from "../shortcuts/appShortcutsRuntime";
import { ThreadDetailScreen } from "./ThreadDetailScreen";

/**
 * `messageId` is an optional query param: the thread opens scrolled to that message (a fork's
 * link back to the reply it was forked from).
 */
type ThreadRouteScreenProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly messageId?: string;
}>;

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

export function ThreadRouteScreen(props: ThreadRouteScreenProps) {
  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const threadIdRaw = firstParam(props.route.params.threadId);
  const messageIdRaw = firstParam(props.route.params.messageId)?.trim() ?? null;

  // The thread on screen raises no alert of its own while the app is in front.
  useFocusEffect(
    useCallback(() => {
      if (!environmentIdRaw || !threadIdRaw) return undefined;
      const ref = {
        environmentId: EnvironmentId.make(environmentIdRaw),
        threadId: ThreadId.make(threadIdRaw),
      };
      // The thread leads the recent threads on the app icon's quick actions.
      recordRecentThreadShortcut({
        environmentId: environmentIdRaw,
        threadId: threadIdRaw,
        title: selectSidebarThreadSummaryByRef(useStore.getState(), ref)?.title ?? "",
      });
      return markThreadVisible(ref);
    }, [environmentIdRaw, threadIdRaw]),
  );

  if (!environmentIdRaw || !threadIdRaw) return null;

  return (
    <ThreadDetailScreen
      environmentId={EnvironmentId.make(environmentIdRaw)}
      threadId={ThreadId.make(threadIdRaw)}
      targetMessageId={messageIdRaw ? MessageId.make(messageIdRaw) : null}
    />
  );
}
