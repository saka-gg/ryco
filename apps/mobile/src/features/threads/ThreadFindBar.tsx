import { moveThreadMessageSearchIndex } from "@ryco/client-runtime/state/session/threadMessageSearch";
import type { EnvironmentId, MessageId, ThreadId } from "@ryco/contracts";
import { useEffect, useState } from "react";
import { Pressable, TextInput, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { GlassSurface } from "../../components/GlassSurface";
import { readEnvironmentApi } from "../../connection/environmentApi";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  findLoadedMessages,
  mergeThreadFindHits,
  THREAD_FIND_SERVER_MIN_CHARS,
  threadFindStatus,
  type ThreadFindHit,
  type ThreadFindMessage,
} from "./threadFindModel";

const SEARCH_DELAY_MS = 300;
const SERVER_LIMIT = 50;

/** The node's hits for `query` in this chat; none when it can't search. */
async function searchChatOnNode(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  query: string,
): Promise<ThreadFindHit[]> {
  const api = readEnvironmentApi(environmentId);
  if (!api) return [];
  const results = await api.orchestration.searchThreadMessages({
    query,
    threadId,
    limit: SERVER_LIMIT,
  });
  return results
    .filter((result) => result.threadId === threadId)
    .map((result) => ({ messageId: result.messageId, createdAt: result.timestamp }));
}

/**
 * Find in this chat: a glass bar under the header with the query, "3 / 12" and up/down. Each
 * step anchors the chat at the matching message (loading older history when it has to).
 */
export function ThreadFindBar(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly messages: ReadonlyArray<ThreadFindMessage>;
  readonly onGoTo: (messageId: MessageId) => void;
  readonly onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [server, setServer] = useState<{
    readonly query: string;
    readonly hits: ReadonlyArray<ThreadFindHit>;
  } | null>(null);
  const textColor = useThemeColor("--color-foreground") as string;
  const placeholderColor = useThemeColor("--color-placeholder") as string;
  const iconColor = useThemeColor("--color-icon") as string;

  const trimmed = query.trim();
  useEffect(() => {
    if (trimmed.length < THREAD_FIND_SERVER_MIN_CHARS) return;
    let current = true;
    const timer = setTimeout(() => {
      void searchChatOnNode(props.environmentId, props.threadId, trimmed)
        .catch(() => [] as ThreadFindHit[])
        .then((hits) => {
          if (current) setServer({ query: trimmed, hits });
        });
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [props.environmentId, props.threadId, trimmed]);

  const serverHits = server !== null && server.query === trimmed ? server.hits : [];
  const searching =
    trimmed.length >= THREAD_FIND_SERVER_MIN_CHARS && (server === null || server.query !== trimmed);
  const hits = mergeThreadFindHits(findLoadedMessages(props.messages, query), serverHits);
  const position = Math.min(index, Math.max(0, hits.length - 1));
  const status = threadFindStatus({ query, hits: hits.length, index: position, searching });

  // The first match shows as soon as there is one (web's find bar does the same); stepping
  // goes on from there.
  const firstHit = hits[0]?.messageId ?? null;
  const goTo = props.onGoTo;
  useEffect(() => {
    if (firstHit === null) return;
    setIndex(0);
    goTo(firstHit);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- re-runs only when the first match or the query changes.
  }, [firstHit, trimmed]);

  const step = (direction: "next" | "previous") => {
    if (hits.length === 0) return;
    const next = moveThreadMessageSearchIndex({
      currentIndex: position,
      matchCount: hits.length,
      direction,
    });
    setIndex(next);
    props.onGoTo(hits[next]!.messageId);
  };

  return (
    <View className="mx-3">
      <GlassSurface radius={20}>
        <View className="h-11 flex-row items-center gap-1 pl-3.5 pr-1">
          <SymbolView name="magnifyingglass" size={14} tintColor={iconColor} type="monochrome" />
          <TextInput
            accessibilityLabel="Find in chat"
            autoFocus
            value={query}
            onChangeText={(value) => {
              setQuery(value);
              setIndex(0);
            }}
            onSubmitEditing={() => step("next")}
            returnKeyType="search"
            submitBehavior="submit"
            placeholder="Find in chat"
            placeholderTextColor={placeholderColor}
            autoCapitalize="none"
            autoCorrect={false}
            className="min-w-0 flex-1 px-1.5 font-sans text-[15px]"
            style={{ color: textColor }}
          />
          <Text
            className="text-xs text-foreground-muted"
            style={{ fontVariant: ["tabular-nums"] }}
            accessibilityLiveRegion="polite"
          >
            {status}
          </Text>
          <FindButton
            icon="chevron.up"
            label="Previous match"
            disabled={hits.length === 0}
            onPress={() => step("previous")}
          />
          <FindButton
            icon="chevron.down"
            label="Next match"
            disabled={hits.length === 0}
            onPress={() => step("next")}
          />
          <FindButton icon="xmark" label="Close find" disabled={false} onPress={props.onClose} />
        </View>
      </GlassSurface>
    </View>
  );
}

function FindButton(props: {
  readonly icon: string;
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  const iconColor = useThemeColor("--color-icon") as string;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      className="h-9 w-9 items-center justify-center rounded-full active:bg-subtle disabled:opacity-35"
    >
      <SymbolView name={props.icon as never} size={14} tintColor={iconColor} type="monochrome" />
    </Pressable>
  );
}
