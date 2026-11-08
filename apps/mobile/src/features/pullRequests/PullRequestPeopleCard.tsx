import type { SourceControlLabel } from "@ryco/contracts";
import { Pressable, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { useThemeColor } from "../../lib/useThemeColor";
import type { PullRequestReviewerRow, PullRequestReviewerState } from "./pullRequestPeopleModel";
import { PullRequestLabelChip } from "./PullRequestPresentation";

const STATE_SYMBOL: Readonly<Record<PullRequestReviewerState, string>> = {
  approved: "checkmark.circle.fill",
  "changes-requested": "exclamationmark.bubble.fill",
  commented: "bubble.left.fill",
  pending: "clock",
};

const STATE_WORD: Readonly<Record<PullRequestReviewerState, string>> = {
  approved: "approved",
  "changes-requested": "requested changes",
  commented: "commented",
  pending: "review requested",
};

function Reviewer(props: { readonly reviewer: PullRequestReviewerRow }) {
  const success = useThemeColor("--color-success") as string;
  const warning = useThemeColor("--color-warning") as string;
  const muted = useThemeColor("--color-icon-muted") as string;
  const { state } = props.reviewer;
  const color = state === "approved" ? success : state === "changes-requested" ? warning : muted;
  return (
    <View
      accessible
      accessibilityLabel={`${props.reviewer.login}, ${STATE_WORD[state]}`}
      className="flex-row items-center gap-1 rounded-full bg-subtle px-2 py-1"
    >
      <SymbolView name={STATE_SYMBOL[state] as never} size={11} tintColor={color} />
      <Text className="text-xs text-foreground-secondary">{props.reviewer.login}</Text>
    </View>
  );
}

function Row(props: {
  readonly title: string;
  readonly editable: boolean;
  readonly first: boolean;
  readonly onPress: () => void;
  readonly empty: string;
  readonly children: React.ReactNode | null;
}) {
  const chevron = useThemeColor("--color-icon-subtle") as string;
  return (
    <Pressable
      accessibilityRole={props.editable ? "button" : undefined}
      accessibilityHint={props.editable ? `Change ${props.title.toLowerCase()}.` : undefined}
      disabled={!props.editable}
      onPress={props.onPress}
      className={cn(
        "flex-row items-center gap-3 px-4 py-3 active:bg-card-alt",
        !props.first && "border-t border-border-subtle",
      )}
    >
      <Text className="w-20 text-xs font-ryco-bold text-foreground-muted">{props.title}</Text>
      <View className="min-w-0 flex-1 flex-row flex-wrap gap-1.5">
        {props.children ?? <Text className="text-xs text-foreground-tertiary">{props.empty}</Text>}
      </View>
      {props.editable ? <SymbolView name="chevron.right" size={12} tintColor={chevron} /> : null}
    </Pressable>
  );
}

/** Reviewers and labels, each opening its picker where the viewer may change it. */
export function PullRequestPeopleCard(props: {
  readonly reviewers: ReadonlyArray<PullRequestReviewerRow>;
  readonly labels: ReadonlyArray<SourceControlLabel>;
  readonly canEditReviewers: boolean;
  readonly canEditLabels: boolean;
  readonly onEditReviewers: () => void;
  readonly onEditLabels: () => void;
}) {
  if (
    props.reviewers.length === 0 &&
    props.labels.length === 0 &&
    !props.canEditReviewers &&
    !props.canEditLabels
  ) {
    return null;
  }
  return (
    <View className="mx-4 overflow-hidden rounded-2xl bg-card">
      <Row
        title="Reviewers"
        first
        editable={props.canEditReviewers}
        onPress={props.onEditReviewers}
        empty="None yet"
      >
        {props.reviewers.length > 0
          ? props.reviewers.map((reviewer) => <Reviewer key={reviewer.login} reviewer={reviewer} />)
          : null}
      </Row>
      <Row
        title="Labels"
        first={false}
        editable={props.canEditLabels}
        onPress={props.onEditLabels}
        empty="None"
      >
        {props.labels.length > 0
          ? props.labels.map((label) => <PullRequestLabelChip key={label.name} label={label} />)
          : null}
      </Row>
    </View>
  );
}
