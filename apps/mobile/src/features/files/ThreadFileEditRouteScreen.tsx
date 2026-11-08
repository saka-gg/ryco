import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { routeFilePathParam, workspaceFileBasename } from "@ryco/client-runtime/state/files";
import { EnvironmentId, ThreadId } from "@ryco/contracts/base-schemas";
import { useEffect, useLayoutEffect, useState } from "react";
import { Alert, Pressable, TextInput, View } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";

import { AppText as Text } from "../../components/AppText";
import { firstRouteParam } from "../../lib/routeParams";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { LoadingStrip } from "../../components/LoadingStrip";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { useThemeColor } from "../../lib/useThemeColor";
import { useProjectReadFile } from "../../rpc/useProjectFiles";
import {
  fileChangedSinceOpened,
  fileEditBase,
  fileEditProblem,
  fileEditState,
  fileSaveFailureMessage,
  fileWriteInput,
  type FileEditBase,
} from "./fileEditModel";
import { useEnvironmentMutationReady } from "../home/useEnvironmentMutationReady";
import { useThreadWorkspaceCwd } from "./useThreadWorkspaceRoot";

type ThreadFileEditRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly path: string | readonly string[];
}>;

/**
 * A plain text editor for one workspace file: monospace, no autocorrect, saved
 * with the version it was read at so a change made meanwhile on the machine is
 * never silently overwritten. Viewing (with highlighting) stays on ThreadFile.
 */
export function ThreadFileEditRouteScreen(props: ThreadFileEditRouteProps) {
  const navigation = useNavigation();
  const environmentId = EnvironmentId.make(firstRouteParam(props.route.params.environmentId) ?? "");
  const threadId = ThreadId.make(firstRouteParam(props.route.params.threadId) ?? "");
  const path = routeFilePathParam(props.route.params.path);
  const cwd = useThreadWorkspaceCwd(environmentId, threadId);
  const read = useProjectReadFile({
    environmentId,
    cwd,
    relativePath: path,
    enabled: cwd !== null && path !== null,
  });
  const [draft, setDraft] = useState<string | null>(null);
  const [base, setBase] = useState<FileEditBase | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textColor = useThemeColor("--color-foreground");
  const problem = fileEditProblem(read.data ?? null);
  const original = base ? base.contents : null;
  const state = fileEditState(original ?? "", draft ?? original ?? "");
  const changedOnMachine = fileChangedSinceOpened(base, read.data ?? null);

  // The first read seeds the editor and its save guard; later re-reads replace neither.
  const firstRead = read.data ?? null;
  useEffect(() => {
    if (base !== null || firstRead === null) return;
    setBase(fileEditBase(firstRead));
    setDraft(firstRead.contents);
  }, [base, firstRead]);

  const save = async () => {
    if (!cwd || !path || !base || draft === null) return;
    const input = fileWriteInput({ cwd, relativePath: path, contents: draft, base });
    setSaving(true);
    setError(null);
    try {
      await ensureEnvironmentApi(environmentId).projects.writeFile(input);
    } catch (cause) {
      setError(fileSaveFailureMessage(cause));
      setSaving(false);
      return;
    }
    // Saved: re-read for the viewer in the background; a failed re-read is not a failed save.
    void read.refetch().catch(() => undefined);
    navigation.goBack();
  };

  // Leaving with unsaved edits asks first.
  useEffect(
    () =>
      navigation.addListener("beforeRemove", (event) => {
        if (!state.dirty || saving) return;
        event.preventDefault();
        Alert.alert("Discard your edits?", "They have not been saved to the machine.", [
          { text: "Keep editing", style: "cancel" },
          {
            text: "Discard",
            style: "destructive",
            onPress: () => navigation.dispatch(event.data.action),
          },
        ]);
      }),
    [navigation, saving, state.dirty],
  );

  const title = path ? workspaceFileBasename(path) : "Edit";
  const mutable = useEnvironmentMutationReady(environmentId);
  const canSave = state.dirty && !saving && problem === null && mutable;
  useLayoutEffect(() => {
    navigation.setOptions({
      title,
      headerRight: () => (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save file"
          accessibilityState={{ disabled: !canSave }}
          disabled={!canSave}
          onPress={() => void save()}
          hitSlop={8}
          className="h-9 justify-center rounded-full bg-primary px-4 active:opacity-75 disabled:opacity-35"
        >
          <Text className="text-[14px] font-ryco-bold text-primary-foreground">
            {saving ? "Saving…" : "Save"}
          </Text>
        </Pressable>
      ),
    });
  });

  if (!path) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState variant="plain" title="No file" detail="Open a file to edit it." />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView behavior="padding" className="flex-1 bg-screen">
      <View className="flex-row items-center gap-2 border-b border-border-subtle px-4 py-2">
        <Text
          className="flex-1 font-mono text-2xs text-foreground-tertiary"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {path}
        </Text>
        <Text className="text-2xs font-ryco-medium text-foreground-tertiary">
          {state.lineCount} lines{state.dirty ? " · edited" : ""}
        </Text>
      </View>
      {read.isLoading && !read.data ? <LoadingStrip /> : null}
      {error || changedOnMachine ? (
        <View className="px-4 pt-3">
          <ErrorBanner
            message={
              error ??
              "The file changed on the machine since you opened it. Saving reports a conflict instead of overwriting it."
            }
          />
        </View>
      ) : null}
      {read.data && problem ? (
        <View className="px-5 py-16">
          <EmptyState variant="plain" title="Read-only here" detail={problem} />
        </View>
      ) : null}
      {read.data && !problem && draft !== null ? (
        <TextInput
          accessibilityLabel={`Contents of ${title}`}
          multiline
          scrollEnabled
          autoCapitalize="none"
          autoCorrect={false}
          autoComplete="off"
          spellCheck={false}
          smartInsertDelete={false}
          textAlignVertical="top"
          value={draft}
          onChangeText={setDraft}
          editable={!saving}
          className="flex-1 px-4 py-3 font-mono text-[13px] leading-5"
          style={{ color: textColor as string }}
        />
      ) : null}
    </KeyboardAvoidingView>
  );
}
