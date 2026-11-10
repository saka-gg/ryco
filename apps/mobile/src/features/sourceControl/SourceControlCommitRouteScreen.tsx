import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import type { GitRunStackedActionInput } from "@ryco/contracts";
import type { WorktreeId } from "@ryco/contracts/worktree";
import { useState } from "react";
import { Alert, ScrollView, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { errorMessageOr } from "../../lib/errorMessage";
import { ErrorBanner } from "../../components/ErrorBanner";
import { OptionRow } from "../../components/OptionRow";
import { ensureEnvironmentApi } from "../../connection/environmentApi";
import { uuidv4 } from "../../lib/uuid";
import { confirmDefaultBranchAction } from "./defaultBranchPrompt";
import { commitChoices, type CommitChoice } from "./gitToolsModel";
import { PillButton, SectionTitle, ToolTextField } from "./gitToolsParts";
import {
  useSourceControlTarget,
  useVcsStatus,
  type SourceControlRouteParams,
} from "./useSourceControlTarget";

type CommitRouteProps = StaticScreenProps<SourceControlRouteParams>;

const CHOICE_DETAIL: Readonly<Record<CommitChoice["action"], string>> = {
  commit: "Record every change in this checkout",
  commit_push: "Then push the branch to its remote",
  commit_push_pr: "Then open a pull request for the branch",
};

/** The stacked action a commit sends; built outside the try so the compiler keeps the screen. */
function commitActionInput(input: {
  readonly cwd: string;
  readonly action: CommitChoice["action"];
  readonly message: string;
  readonly worktreeId: WorktreeId | null;
  /** Move the work to a new branch first (chosen when on the default branch). */
  readonly featureBranch: boolean;
}): GitRunStackedActionInput {
  const commitMessage = input.message.trim();
  return {
    actionId: uuidv4(),
    cwd: input.cwd,
    action: input.action,
    ...(commitMessage.length > 0 ? { commitMessage } : {}),
    ...(input.worktreeId ? { worktreeId: input.worktreeId } : {}),
    ...(input.featureBranch ? { featureBranch: true } : {}),
  };
}

/**
 * Commit every change of the checkout with the user's own message (blank: the
 * node writes one), optionally pushing and opening a pull request after.
 */
export function SourceControlCommitRouteScreen(props: CommitRouteProps) {
  const navigation = useNavigation();
  const target = useSourceControlTarget(props.route.params);
  const { environmentId, cwd, mutable } = target;
  const { status, live } = useVcsStatus(target);
  const [message, setMessage] = useState("");
  const [action, setAction] = useState<CommitChoice["action"]>("commit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // A saved status shows what was true: committing waits for the node's own.
  const choices = commitChoices(status, mutable && live);
  const chosen = choices.find((choice) => choice.action === action);
  const fileCount = status ? status.workingTree.files.length : 0;

  const commit = async () => {
    if (!environmentId || !cwd) return;
    const choice = await confirmDefaultBranchAction({ action, status, includesCommit: true });
    if (choice === "cancel") return;
    const input = commitActionInput({
      cwd,
      action,
      message,
      worktreeId: target.worktreeId,
      featureBranch: choice === "feature",
    });
    setBusy(true);
    setError(null);
    try {
      const result = await ensureEnvironmentApi(environmentId).git.runStackedAction(input);
      navigation.goBack();
      Alert.alert(result.toast.title, result.toast.description);
    } catch (cause) {
      setError(errorMessageOr(cause, "Commit failed."));
      setBusy(false);
    }
  };

  return (
    <ScrollView
      className="flex-1 bg-sheet"
      keyboardShouldPersistTaps="handled"
      contentContainerStyle={{ padding: 16, gap: 12, paddingBottom: 48 }}
    >
      <Text className="px-1 text-[13px] text-foreground-muted">
        {status?.refName ?? "This checkout"} · {fileCount} changed file{fileCount === 1 ? "" : "s"}
      </Text>
      <ToolTextField
        multiline
        autoCapitalize="sentences"
        autoCorrect
        value={message}
        onChangeText={setMessage}
        placeholder="Commit message (leave blank to generate one)"
        accessibilityLabel="Commit message"
        className="min-h-[120px]"
        style={{ textAlignVertical: "top" }}
      />
      {error ? <ErrorBanner message={error} /> : null}
      <SectionTitle>After committing</SectionTitle>
      <View className="gap-2">
        {choices.map((choice) => (
          <OptionRow
            key={choice.action}
            label={choice.label}
            detail={CHOICE_DETAIL[choice.action]}
            selected={choice.action === action}
            disabled={!choice.enabled}
            onPress={() => setAction(choice.action)}
          />
        ))}
      </View>
      <PillButton
        label={chosen?.label ?? "Commit"}
        busy={busy}
        disabled={!chosen?.enabled}
        onPress={() => void commit()}
        className="mt-2"
      />
    </ScrollView>
  );
}
