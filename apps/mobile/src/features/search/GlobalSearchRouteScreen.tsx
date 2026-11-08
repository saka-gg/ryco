import { useNavigation } from "@react-navigation/native";
import { useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ChipBar } from "../../components/ChipBar";
import { EmptyState } from "../../components/EmptyState";
import { HighlightedText } from "../../components/HighlightedText";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  buildSearchSections,
  SEARCH_SCOPE_CHIP_LABELS,
  searchEmptyState,
  searchQueryOf,
  searchScopeChips,
  scopesForFilter,
  type SearchResult,
  type SearchScopeFilter,
} from "./searchModel";
import { AVAILABLE_SEARCH_SCOPES, useSearchSources } from "./searchSources";

const SEARCH_FIELD_HEIGHT = 40;

/**
 * One search across chats, message text, pull requests and tasks: a field,
 * scope chips, and results grouped by scope with the query's words
 * highlighted. Each scope comes from a search source (`searchSources.ts`).
 */
export function GlobalSearchRouteScreen() {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const [text, setText] = useState("");
  const [filter, setFilter] = useState<SearchScopeFilter>("everything");
  const query = searchQueryOf(text);
  const groups = useSearchSources({
    query,
    scopes: scopesForFilter(filter, AVAILABLE_SEARCH_SCOPES),
  });
  const sections = buildSearchSections(groups, filter);
  const empty = searchEmptyState({ query, sections });
  const placeholderColor = useThemeColor("--color-foreground-muted");
  const textColor = useThemeColor("--color-foreground");
  const close = () => {
    if (navigation.canGoBack()) navigation.goBack();
  };

  return (
    <View className="flex-1 bg-screen" style={{ paddingTop: insets.top + 6 }}>
      <View className="flex-row items-center gap-3 px-4 pb-3">
        <View
          className="flex-1 flex-row items-center gap-2 rounded-xl bg-subtle-strong px-3"
          style={{ height: SEARCH_FIELD_HEIGHT }}
        >
          <SymbolView
            name="magnifyingglass"
            size={16}
            tintColor={placeholderColor}
            type="monochrome"
          />
          <TextInput
            autoFocus
            accessibilityLabel="Search chats, messages, pull requests and tasks"
            placeholder="Search"
            placeholderTextColor={placeholderColor as string}
            value={text}
            onChangeText={setText}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            clearButtonMode="while-editing"
            className="min-w-0 flex-1 font-sans text-[17px]"
            style={{ height: SEARCH_FIELD_HEIGHT, color: textColor as string }}
          />
        </View>
        <Pressable accessibilityRole="button" hitSlop={8} onPress={close}>
          <Text className="font-ryco-medium text-[17px] text-accent-strong">Cancel</Text>
        </Pressable>
      </View>
      <View className="pb-2">
        <ChipBar
          accessibilityLabel="Search in"
          items={searchScopeChips(AVAILABLE_SEARCH_SCOPES).map((scope) => ({
            key: scope,
            label: SEARCH_SCOPE_CHIP_LABELS[scope],
            selected: scope === filter,
          }))}
          onSelect={(key) => setFilter(key as SearchScopeFilter)}
        />
      </View>
      <ScrollView
        className="flex-1"
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{ paddingBottom: insets.bottom + 24 }}
      >
        {sections.map((section) => (
          <View key={section.scope} className="pt-3">
            <View className="flex-row items-center gap-2 px-5 pb-2">
              <Text className="text-xs font-ryco-medium uppercase tracking-wide text-foreground-tertiary">
                {section.title}
              </Text>
              {section.loading ? <ActivityIndicator size="small" /> : null}
            </View>
            {section.results.length > 0 ? (
              <View className="mx-4 overflow-hidden rounded-2xl bg-card">
                {section.results.map((result, index) => (
                  <SearchResultRow
                    key={result.key}
                    result={result}
                    query={query ?? ""}
                    first={index === 0}
                  />
                ))}
              </View>
            ) : null}
            {section.hiddenCount > 0 ? (
              <Pressable
                accessibilityRole="button"
                className="mx-4 mt-1 min-h-10 justify-center px-1 active:opacity-60"
                onPress={() => setFilter(section.scope)}
              >
                <Text className="text-sm font-ryco-medium text-accent-strong">
                  Show all {section.results.length + section.hiddenCount}
                </Text>
              </Pressable>
            ) : null}
          </View>
        ))}
        {empty === "prompt" ? (
          <View className="px-4 pt-16">
            <EmptyState
              variant="plain"
              title="Search Ryco"
              detail="Find chats, words inside their messages, pull requests and tasks."
            />
          </View>
        ) : empty === "searching" ? (
          <View className="items-center pt-16">
            <ActivityIndicator accessibilityLabel="Searching" />
          </View>
        ) : empty === "no-results" ? (
          <View className="px-4 pt-16">
            <EmptyState
              variant="plain"
              title="No results"
              detail={`Nothing matches “${query}”${
                filter === "everything" ? "" : ` in ${SEARCH_SCOPE_CHIP_LABELS[filter]}`
              }.`}
            />
          </View>
        ) : null}
      </ScrollView>
    </View>
  );
}

function SearchResultRow(props: {
  readonly result: SearchResult;
  readonly query: string;
  readonly first: boolean;
}) {
  const { result } = props;
  const iconColor = useThemeColor("--color-icon-muted");
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={result.accessibilityLabel}
      onPress={result.open}
      className={`flex-row items-start gap-3 px-3.5 py-3 active:bg-card-alt ${
        props.first ? "" : "border-t border-border-subtle"
      }`}
    >
      <View className="h-5 w-5 items-center justify-center pt-0.5">
        <SymbolView name={result.icon} size={15} tintColor={iconColor} type="monochrome" />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <HighlightedText
          text={result.title}
          query={props.query}
          numberOfLines={1}
          className="font-ryco-medium text-[15px] text-foreground"
          highlightClassName="font-ryco-bold text-[15px] text-foreground"
        />
        {result.snippet ? (
          <HighlightedText
            text={`“${result.snippet}”`}
            query={props.query}
            numberOfLines={2}
            className="text-[13px] leading-[18px] text-foreground-muted"
            highlightClassName="font-ryco-bold text-[13px] leading-[18px] text-foreground"
          />
        ) : null}
        {result.detail ? (
          <Text className="text-xs text-foreground-tertiary" numberOfLines={1}>
            {result.detail}
          </Text>
        ) : null}
      </View>
      {result.trailing ? (
        <Text className="pt-0.5 text-2xs text-foreground-tertiary">{result.trailing}</Text>
      ) : null}
    </Pressable>
  );
}
