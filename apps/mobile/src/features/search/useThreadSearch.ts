import { useNavigation } from "@react-navigation/native";
import { pinnedThreadKeyList } from "@ryco/client-runtime/state/threads/threadPins";
import { useMemo, useState } from "react";

import { relativeTime } from "../../lib/time";
import { openThread } from "../../navigation/openThread";
import { usePreferences } from "../../state/preferencesStore";
import { markSnoozeWokeSeen } from "../../state/snoozeWokeSeen";
import { useThreadPins } from "../../state/threadPins";
import { useInboxSource } from "../home/useInboxSource";
import { buildInboxSections, type InboxThreadRow } from "../inbox/inboxModel";
import { useInboxMessageSearch } from "../inbox/useInboxMessageSearch";
import type { SearchGroup } from "./searchModel";
import type { SearchSourceHook } from "./searchSources";
import {
  chatSearchResult,
  inboxRowsOf,
  messageSearchResult,
  THREAD_SEARCH_RESULT_LIMIT,
} from "./threadSearchModel";

/**
 * Chats and Messages: the inbox's own text filter (title, project, branch) and
 * the nodes' message search round 1 added to the inbox
 * (`useInboxMessageSearch`), over the same threads Chats lists.
 */
export const useThreadSearch: SearchSourceHook = ({ query, scopes }) => {
  const navigation = useNavigation();
  // Search is short-lived: the clock that ages "last seen" needs no ticking here.
  const [nowMs] = useState(Date.now);
  const {
    environments,
    projects,
    worktrees,
    threads,
    localQueuedThreadIds,
    wokeSeenAtByThreadKey,
  } = useInboxSource(nowMs);
  const preferences = usePreferences();
  const pins = useThreadPins();
  const chatsOn = query !== null && scopes.has("chats");
  const messagesOn = query !== null && scopes.has("messages");
  const connectedIds = useMemo(
    () =>
      messagesOn
        ? environments
            .filter((environment) => environment.connectionState === "connected")
            .map((environment) => environment.environmentId)
        : [],
    [environments, messagesOn],
  );
  const { matches: messageMatches, searching: messagesSearching } = useInboxMessageSearch(
    query ?? "",
    connectedIds,
  );

  return useMemo((): ReadonlyArray<SearchGroup> => {
    if (query === null) return [];
    const open = (row: InboxThreadRow, messageId?: string) => () => {
      if (row.wokeAt) markSnoozeWokeSeen(row.key, row.wokeAt);
      openThread(navigation, {
        environmentId: row.environmentId,
        threadId: row.threadId,
        messageId,
      });
    };
    const build = (withMessages: boolean) =>
      inboxRowsOf(
        buildInboxSections({
          projects,
          worktrees,
          threads,
          environments,
          query,
          localQueuedThreadIds,
          autoSettleAfterDays: preferences.sidebarAutoSettleAfterDays,
          nowMs,
          wokeSeenAtByThreadKey,
          pinnedThreadKeys: pinnedThreadKeyList(pins),
          ...(withMessages ? { messageMatches } : {}),
        }),
      );
    const groups: SearchGroup[] = [];
    if (chatsOn) {
      groups.push({
        scope: "chats",
        loading: false,
        results: build(false)
          .slice(0, THREAD_SEARCH_RESULT_LIMIT)
          .map((row) =>
            chatSearchResult({ row, age: relativeTime(row.updatedAt), open: open(row) }),
          ),
      });
    }
    if (messagesOn) {
      const results = [];
      for (const row of messageMatches.size > 0 ? build(true) : []) {
        const match = row.messageMatch;
        if (!match) continue;
        results.push(
          messageSearchResult({
            row,
            snippet: match.snippet,
            age: relativeTime(match.timestamp),
            open: open(row, match.messageId),
          }),
        );
      }
      // Still loading while a machine has not answered: Search says so instead of "No results".
      groups.push({ scope: "messages", loading: messagesSearching, results });
    }
    return groups;
  }, [
    chatsOn,
    environments,
    localQueuedThreadIds,
    messageMatches,
    messagesOn,
    messagesSearching,
    navigation,
    nowMs,
    pins,
    preferences.sidebarAutoSettleAfterDays,
    projects,
    query,
    threads,
    wokeSeenAtByThreadKey,
    worktrees,
  ]);
};
