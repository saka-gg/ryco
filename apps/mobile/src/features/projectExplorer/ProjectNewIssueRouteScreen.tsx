import { type StaticScreenProps } from "@react-navigation/native";
import { WS_METHODS } from "@ryco/contracts/rpc";
import { useState } from "react";
import { ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { useThemeColor } from "../../lib/useThemeColor";
import { refreshProjectExplorerReads } from "../../rpc/projectExplorerAtoms";
import { FilterChip } from "../pullRequests/PullRequestParts";
import { usePullRequestCheckout } from "../pullRequests/usePullRequestData";
import {
  applyPolishedIssueContent,
  assigneeOptions,
  buildCreateIssueInput,
  buildPolishIssueInput,
  EMPTY_NEW_ISSUE_DRAFT,
  toggleValue,
  type NewIssueDraft,
} from "./issuesModel";
import { explorerScopeFromParams } from "./projectExplorerModel";
import { CardButton } from "./ProjectExplorerParts";
import { useExplorerChange } from "./useExplorerChange";
import { useExplorerNavigation } from "./useExplorerNavigation";
import { useIssueMeta } from "./useProjectExplorerData";

type ProjectNewIssueRouteProps = StaticScreenProps<{
  readonly environmentId: string;
  readonly projectId: string;
}>;

function FieldLabel(props: { readonly children: string }) {
  return (
    <Text className="px-1 text-sm font-ryco-medium text-foreground-muted">{props.children}</Text>
  );
}

/** A new issue on the project's host: title, description, and labels or assignees it offers. */
export function ProjectNewIssueRouteScreen(props: ProjectNewIssueRouteProps) {
  const { environmentId, projectId } = explorerScopeFromParams(props.route.params);
  const checkout = usePullRequestCheckout(environmentId, projectId);
  const cwd = checkout.cwd;
  const meta = useIssueMeta({ environmentId, cwd });
  const explorer = useExplorerNavigation(environmentId, projectId);
  const { navigation } = explorer;
  const change = useExplorerChange(environmentId);
  const createOffer = change.offer(WS_METHODS.sourceControlCreateIssue);
  const polishOffer = change.offer(WS_METHODS.textGenerationGenerateIssueContent);
  const [draft, setDraft] = useState<NewIssueDraft>(EMPTY_NEW_ISSUE_DRAFT);
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");

  if (environmentId === null || projectId === null || cwd === null) {
    return (
      <View className="flex-1 bg-screen px-5 py-16">
        <EmptyState
          variant="plain"
          title="Project unavailable"
          detail="The selected node has not published this project yet."
        />
      </View>
    );
  }

  const labels = meta.labels ?? [];
  const assignees = assigneeOptions(meta.assignees);
  const busy = change.pending !== null;
  const built = buildCreateIssueInput(cwd, draft);
  const polishInput = buildPolishIssueInput(cwd, draft);

  const create = () => {
    if (!built.ok) return;
    change.run({
      kind: "create",
      failure: "The issue was not created. Try again.",
      perform: (client) => client.sourceControl.createIssue(built.input),
      onDone: (result) => {
        refreshProjectExplorerReads({ environmentId, scope: cwd, family: "issues" });
        navigation.goBack();
        explorer.openIssue(result.issue.number);
      },
    });
  };

  const polish = () => {
    if (polishInput === null) return;
    change.run({
      kind: "polish",
      failure: "The description could not be polished.",
      perform: (client) => client.textGeneration.generateIssueContent(polishInput),
      onDone: (result) => setDraft((current) => applyPolishedIssueContent(current, result)),
    });
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 18, paddingBottom: 44 }}
    >
      {createOffer.blockedReason ? (
        <Text className="text-sm text-foreground-muted">{createOffer.blockedReason}</Text>
      ) : null}
      {change.error ? <ErrorBanner message={change.error} /> : null}

      <View className="gap-2">
        <FieldLabel>Title</FieldLabel>
        <TextInput
          value={draft.title}
          onChangeText={(title) => setDraft((current) => ({ ...current, title }))}
          editable={!busy}
          autoFocus
          placeholder="What is it about?"
          placeholderTextColor={placeholderColor as string}
          returnKeyType="next"
          className="min-h-14 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
          style={{ color: textColor as string }}
        />
      </View>

      <View className="gap-2">
        <FieldLabel>Description</FieldLabel>
        <TextInput
          value={draft.body}
          onChangeText={(body) => setDraft((current) => ({ ...current, body }))}
          editable={!busy}
          multiline
          placeholder="Steps, logs, context. Markdown works."
          placeholderTextColor={placeholderColor as string}
          textAlignVertical="top"
          className="min-h-40 rounded-2xl border border-border bg-card px-4 py-3 font-sans text-base"
          style={{ color: textColor as string }}
        />
        {polishOffer.offered ? (
          <View className="flex-row">
            <CardButton
              label={change.pending === "polish" ? "Polishing…" : "Polish with AI"}
              symbol="sparkles"
              disabled={busy || polishInput === null || polishOffer.blockedReason !== null}
              onPress={polish}
            />
          </View>
        ) : null}
      </View>

      {labels.length > 0 ? (
        <View className="gap-2">
          <FieldLabel>Labels</FieldLabel>
          <View className="flex-row flex-wrap gap-2">
            {labels.map((label) => (
              <FilterChip
                key={label.name}
                label={label.name}
                selected={draft.labels.includes(label.name)}
                onPress={() =>
                  setDraft((current) => ({
                    ...current,
                    labels: toggleValue(current.labels, label.name),
                  }))
                }
              />
            ))}
          </View>
        </View>
      ) : null}

      {assignees.length > 0 ? (
        <View className="gap-2">
          <FieldLabel>Assignees</FieldLabel>
          <View className="flex-row flex-wrap gap-2">
            {assignees.map((option) => (
              <FilterChip
                key={option.login}
                label={option.label}
                selected={draft.assignees.includes(option.login)}
                onPress={() =>
                  setDraft((current) => ({
                    ...current,
                    assignees: toggleValue(current.assignees, option.login),
                  }))
                }
              />
            ))}
          </View>
        </View>
      ) : null}

      <View className="flex-row">
        <CardButton
          label={change.pending === "create" ? "Creating…" : "Create issue"}
          primary
          disabled={busy || !built.ok || createOffer.blockedReason !== null}
          onPress={create}
        />
      </View>
    </ScrollView>
  );
}
