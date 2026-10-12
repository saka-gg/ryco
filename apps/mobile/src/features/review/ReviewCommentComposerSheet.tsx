import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";

import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import { useComposerDraftStore } from "../../state/composerDraftStore";

function firstParam(value: string | string[] | undefined): string | null {
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

type ReviewCommentProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
}>;

// Comment composer appends to the thread draft (spec) via B1's composer draft
// store — the comment lands in the thread's prompt for the next turn.
export function ReviewCommentComposerSheet(props: ReviewCommentProps) {
  const navigation = useNavigation();
  const [comment, setComment] = useState("");
  const placeholderColor = useThemeColor("--color-icon-subtle");
  const textColor = useThemeColor("--color-foreground");

  const environmentIdRaw = firstParam(props.route.params.environmentId);
  const threadIdRaw = firstParam(props.route.params.threadId);

  const dismiss = () => {
    if (navigation.canGoBack()) {
      navigation.goBack();
      return;
    }
    if (environmentIdRaw && threadIdRaw) {
      navigation.dispatch(
        StackActions.replace("Thread", {
          environmentId: environmentIdRaw,
          threadId: threadIdRaw,
        }),
      );
      return;
    }
    navigation.dispatch(StackActions.replace("Home"));
  };

  const submit = () => {
    const value = comment.trim();
    if (!value || !environmentIdRaw || !threadIdRaw) return;
    const target = scopeThreadRef(EnvironmentId.make(environmentIdRaw), ThreadId.make(threadIdRaw));
    const store = useComposerDraftStore.getState();
    const current = store.getComposerDraft(target)?.prompt ?? "";
    store.setPrompt(target, current.trim().length > 0 ? `${current}\n\n${value}` : value);
    dismiss();
  };

  return (
    <ScrollView className="flex-1 bg-screen" contentContainerStyle={{ padding: 16, gap: 12 }}>
      <View className="flex-row items-center gap-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel review comment"
          onPress={dismiss}
          className="h-11 min-w-16 items-center justify-center rounded-full active:bg-subtle"
        >
          <Text className="text-base font-ryco-medium text-foreground">Cancel</Text>
        </Pressable>
        <Text className="flex-1 text-center text-lg font-ryco-bold text-foreground">
          Review comment
        </Text>
        <View className="h-11 min-w-16" />
      </View>
      <Text className="font-sans text-base text-foreground-muted">
        Your comment is appended to the thread draft for the next turn.
      </Text>
      <TextInput
        value={comment}
        onChangeText={setComment}
        placeholder="Add a review comment"
        placeholderTextColor={placeholderColor as string}
        multiline
        autoFocus
        className="min-h-32 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
        style={{ color: textColor as string }}
      />
      <Pressable
        disabled={comment.trim().length === 0}
        onPress={submit}
        className="items-center rounded-full bg-primary px-4 py-3 active:opacity-70 disabled:opacity-40"
      >
        <Text className="text-sm font-ryco-bold text-primary-foreground">Add to draft</Text>
      </Pressable>
    </ScrollView>
  );
}
