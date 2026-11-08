import type { EnvironmentId } from "@ryco/contracts";
import * as Haptics from "expo-haptics";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { applyCompletion, completionTokenAt } from "./pullRequestCompletionModel";
import { usePullRequestCompletions } from "./usePullRequestCompletions";

/**
 * A pull request text field that completes `@people` from the repository and
 * `#references` from the host's issues and pull requests, with the
 * suggestions in a strip above the field.
 */
export function PullRequestCompletingInput(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly environmentId: EnvironmentId | null;
  readonly cwd: string | null;
  readonly placeholder: string;
  readonly minHeight?: number;
  readonly autoFocus?: boolean;
  readonly editable?: boolean;
}) {
  const [cursor, setCursor] = useState(props.value.length);
  const [selection, setSelection] = useState<{ start: number; end: number } | undefined>(undefined);
  const placeholder = useThemeColor("--color-placeholder") as string;
  const text = useThemeColor("--color-foreground") as string;
  const token = completionTokenAt(props.value, cursor);
  const suggestions = usePullRequestCompletions({
    environmentId: props.environmentId,
    cwd: props.cwd,
    token,
  });
  const pick = (insert: string) => {
    if (token === null) return;
    const next = applyCompletion(props.value, token, { insert });
    void Haptics.selectionAsync();
    props.onChangeText(next.text);
    setCursor(next.cursor);
    setSelection({ start: next.cursor, end: next.cursor });
  };
  return (
    <View className="gap-2">
      {suggestions.length > 0 ? (
        <ScrollView
          horizontal
          keyboardShouldPersistTaps="always"
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: 6 }}
        >
          {suggestions.map((suggestion) => (
            <Pressable
              key={suggestion.key}
              accessibilityRole="button"
              accessibilityLabel={`Insert ${suggestion.insert}, ${suggestion.title}`}
              onPress={() => pick(suggestion.insert)}
              className="max-w-64 rounded-xl bg-subtle px-3 py-1.5 active:bg-subtle-strong"
            >
              <Text className="text-xs font-ryco-bold text-foreground" numberOfLines={1}>
                {suggestion.title}
              </Text>
              {suggestion.detail ? (
                <Text className="text-2xs text-foreground-muted" numberOfLines={1}>
                  {suggestion.detail}
                </Text>
              ) : null}
            </Pressable>
          ))}
        </ScrollView>
      ) : null}
      <TextInput
        value={props.value}
        onChangeText={(value) => {
          setSelection(undefined);
          props.onChangeText(value);
        }}
        onSelectionChange={(event) => {
          setCursor(event.nativeEvent.selection.end);
          setSelection(undefined);
        }}
        selection={selection}
        autoFocus={props.autoFocus}
        editable={props.editable !== false}
        multiline
        placeholder={props.placeholder}
        placeholderTextColor={placeholder}
        textAlignVertical="top"
        className="rounded-2xl bg-card px-4 py-3 font-sans text-base"
        style={{ color: text, minHeight: props.minHeight ?? 140 }}
      />
    </View>
  );
}
