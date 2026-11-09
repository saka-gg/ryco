import type { GitStackedAction, VcsStatusResult } from "@ryco/contracts";
import {
  requiresDefaultBranchConfirmation,
  resolveDefaultBranchActionDialogCopy,
  type DefaultBranchConfirmableAction,
} from "@ryco/shared/gitDefaultBranch";
import { getChangeRequestTerminology } from "@ryco/shared/sourceControl";
import { Alert } from "react-native";

/** How an action on the default ref should run: there, on a new feature branch, or not at all. */
export type DefaultBranchChoice = "continue" | "feature" | "cancel";

/**
 * Asks before pushing to the checkout's default ref, with the desktop's
 * wording and its two ways forward. Resolves "continue" at once off the
 * default ref.
 */
export function confirmDefaultBranchAction(input: {
  readonly action: GitStackedAction;
  readonly status: VcsStatusResult | null;
  readonly includesCommit: boolean;
}): Promise<DefaultBranchChoice> {
  const { action, status } = input;
  if (!status || !requiresDefaultBranchConfirmation(action, status.isDefaultRef)) {
    return Promise.resolve("continue");
  }
  const copy = resolveDefaultBranchActionDialogCopy({
    action: action as DefaultBranchConfirmableAction,
    branchName: status.refName ?? "the default branch",
    includesCommit: input.includesCommit,
    terminology: getChangeRequestTerminology(status.sourceControlProvider),
  });
  return new Promise((resolve) => {
    Alert.alert(copy.title, copy.description, [
      { text: "Cancel", style: "cancel", onPress: () => resolve("cancel") },
      { text: "Create feature branch", onPress: () => resolve("feature") },
      { text: copy.continueLabel, style: "destructive", onPress: () => resolve("continue") },
    ]);
  });
}
