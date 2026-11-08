import {
  copyOverallPercent,
  copyProgressFooter,
  copyProgressSteps,
  type CopyProgressContext,
  type CopyProgressStep,
  type CopyTextSegment,
} from "@ryco/client-runtime/projectCopy/dialog";
import { projectCopyView } from "@ryco/client-runtime/projectCopy/progressView";
import type { EnvironmentId } from "@ryco/contracts";
import { StackActions, useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, View } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { useThemeColor } from "../../lib/useThemeColor";
import {
  cancelProjectCopy,
  retryProjectCopy,
  showProjectCopyProgress,
  useProjectCopyEntry,
} from "./mobileCopyManager";

/** A copy the form started, with what its progress list needs to word its steps. */
export interface StartedCopy {
  readonly copyId: string;
  readonly title: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  readonly context: CopyProgressContext;
}

function SegmentText(props: { readonly segments: ReadonlyArray<CopyTextSegment> }) {
  return (
    <Text className="font-sans text-[15px] text-foreground" numberOfLines={2}>
      {props.segments.map((segment, index) => (
        <Text
          // Segments are positional fragments of one label.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className={segment.mono ? "font-mono text-[13px]" : undefined}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

function StepIcon(props: { readonly status: CopyProgressStep["status"] }) {
  const success = useThemeColor("--color-success");
  const danger = useThemeColor("--color-danger-foreground");
  const muted = useThemeColor("--color-icon-subtle");
  if (props.status === "running") return <ActivityIndicator size="small" />;
  if (props.status === "done") {
    return <SymbolView name="checkmark.circle.fill" size={18} tintColor={success as string} />;
  }
  if (props.status === "failed") {
    return <SymbolView name="xmark.circle.fill" size={18} tintColor={danger as string} />;
  }
  return <SymbolView name="circle" size={18} tintColor={muted as string} />;
}

/**
 * A copy's progress in the copy sheet: its steps as the shared progress list
 * words them, the overall bar, and what to do next. Closing the sheet hands
 * the copy to the notice; it never cancels it.
 */
export function CopyProgressView(props: {
  readonly copyId: string;
  /** What the form knew; null when the sheet opened on a running copy. */
  readonly started: StartedCopy | null;
}) {
  const navigation = useNavigation();
  const entry = useProjectCopyEntry(props.copyId);
  const [retrying, setRetrying] = useState(false);
  const title = props.started?.title ?? entry?.title ?? "Project";
  const targetLabel = props.started?.targetLabel ?? entry?.targetLabel ?? "the destination";

  useLayoutEffect(() => {
    navigation.setOptions({ title: `Copy ${title}` });
  }, [navigation, title]);

  // Closing (swipe or the close button) hands the copy to the notice.
  useLayoutEffect(
    () =>
      navigation.addListener("beforeRemove", () => {
        showProjectCopyProgress(props.copyId);
      }),
    [navigation, props.copyId],
  );

  if (entry === null) {
    return (
      <View className="flex-1 items-center justify-center bg-screen">
        <ActivityIndicator />
      </View>
    );
  }

  const view = projectCopyView(
    entry.progress,
    { title, sourceLabel: entry.sourceLabel, targetLabel, action: entry.action },
    entry.throughput,
  );
  const context: CopyProgressContext = props.started?.context ?? {
    sourceLabel: entry.sourceLabel,
    targetLabel,
    mode: entry.action === "link" ? "link" : "clone",
    remoteUrl: null,
    branch: null,
    destinationPath: entry.progress.importSnapshot?.destinationPath ?? "",
    targetHome: null,
    changeCount: 0,
    setupCommand: null,
    uploads: false,
    bringsCommits: false,
    bringsChanges: false,
    copiesSettings: false,
    followUp: false,
  };
  const steps = copyProgressSteps(entry.progress, context, entry.throughput);
  const percent = copyOverallPercent(steps, entry.progress);
  const running = entry.running && view.kind === "progress";
  const project = entry.project;

  const close = () => {
    if (navigation.canGoBack()) navigation.goBack();
  };

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      className="flex-1 bg-screen"
      contentContainerStyle={{ padding: 20, gap: 20, paddingBottom: 48 }}
    >
      <View className="gap-2">
        <Text className="text-xl font-ryco-bold text-foreground">{view.title}</Text>
        <Text className="font-sans text-sm leading-5 text-foreground-muted">
          {view.description}
        </Text>
        <View className="mt-1 h-1.5 overflow-hidden rounded-full bg-subtle">
          <View
            className={`h-full rounded-full ${view.kind === "failed" ? "bg-danger" : "bg-primary"}`}
            style={{ width: `${percent}%` }}
          />
        </View>
      </View>

      <View className="overflow-hidden rounded-2xl border border-border bg-card">
        {steps.map((step, index) => (
          <View
            key={step.id}
            className={`flex-row items-start gap-3 px-4 py-3 ${
              index === 0 ? "" : "border-t border-border-subtle"
            } ${step.status === "pending" ? "opacity-50" : ""}`}
          >
            <View className="h-5 w-5 items-center justify-center pt-0.5">
              <StepIcon status={step.status} />
            </View>
            <View className="min-w-0 flex-1 gap-0.5">
              <SegmentText segments={step.label} />
              {step.log ? (
                <Text
                  className={`font-mono text-xs ${
                    step.status === "failed" ? "text-danger-foreground" : "text-foreground-muted"
                  }`}
                  numberOfLines={3}
                >
                  {step.log}
                </Text>
              ) : null}
            </View>
            {step.percent !== null && step.status === "running" ? (
              <Text className="font-mono text-xs text-foreground-muted">
                {Math.round(step.percent)}%
              </Text>
            ) : null}
          </View>
        ))}
      </View>

      {running ? (
        <Text className="font-sans text-xs leading-4 text-foreground-muted">
          {copyProgressFooter(entry.progress, targetLabel, entry.throughput)}
        </Text>
      ) : null}

      <View className="gap-2">
        {running ? (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={close}
              className="h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
            >
              <Text className="text-base font-ryco-bold text-primary-foreground">
                Continue in background
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() => cancelProjectCopy(props.copyId)}
              className="h-12 items-center justify-center rounded-full bg-subtle active:opacity-70"
            >
              <Text className="text-base font-ryco-bold text-danger-foreground">Cancel copy</Text>
            </Pressable>
          </>
        ) : null}
        {view.kind === "done" && project ? (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                navigation.dispatch(
                  StackActions.replace("NewTask", {
                    environmentId: project.environmentId,
                    projectId: project.projectId,
                  }),
                )
              }
              className="h-12 items-center justify-center rounded-full bg-primary active:opacity-80"
            >
              <Text className="text-base font-ryco-bold text-primary-foreground">
                Start a task on {targetLabel}
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              onPress={() =>
                navigation.dispatch(
                  StackActions.replace("Project", {
                    environmentId: project.environmentId,
                    projectId: project.projectId,
                  }),
                )
              }
              className="h-12 items-center justify-center rounded-full bg-subtle active:opacity-70"
            >
              <Text className="text-base font-ryco-bold text-foreground">Open project</Text>
            </Pressable>
          </>
        ) : null}
        {view.kind === "failed" && view.retryLabel !== null && entry.hasPlan ? (
          <Pressable
            accessibilityRole="button"
            disabled={retrying}
            onPress={() => {
              setRetrying(true);
              void retryProjectCopy(props.copyId, { toast: false }).finally(() =>
                setRetrying(false),
              );
            }}
            className="h-12 items-center justify-center rounded-full bg-primary active:opacity-80 disabled:opacity-40"
          >
            <Text className="text-base font-ryco-bold text-primary-foreground">
              {retrying ? "Retrying…" : view.retryLabel}
            </Text>
          </Pressable>
        ) : null}
        {!running ? (
          <Pressable
            accessibilityRole="button"
            onPress={close}
            className="h-12 items-center justify-center rounded-full bg-subtle active:opacity-70"
          >
            <Text className="text-base font-ryco-bold text-foreground">Done</Text>
          </Pressable>
        ) : null}
      </View>
    </ScrollView>
  );
}
