import {
  buildProjectCopyRunPlan,
  projectCopyFolderSupportOf,
  projectCopyFollowUpDefaults,
  type ProjectCopyOptionsPlan,
  type ProjectCopyTargetFacts,
} from "@ryco/client-runtime/projectCopy";
import {
  copyAlreadyOn,
  copyDestinationCards,
  copyFolderNote,
  copyFolderTag,
  copyNoTargetMessage,
  copyOptionsSummary,
  copySegmentsText,
  copySourceRows,
  copyTargetCards,
  initialCopySource,
  initialCopyTarget,
  type CopyProgressContext,
  type CopyTextSegment,
} from "@ryco/client-runtime/projectCopy/dialog";
import {
  copyDestinationUsable,
  copyFormBlockedReason,
  copyProgressContextOf,
  copyResumeNotice,
  DEFAULT_COPY_USER_CHOICES,
  planCopyOptions,
  requestedCopyTarget,
  resumableCopyRecord,
  type CopyUserChoices,
} from "@ryco/client-runtime/projectCopy/form";
import { catalogPlatformOs } from "@ryco/client-runtime/state/nodes";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { displayProjectPath } from "@ryco/shared/projectPaths";
import { useNavigation } from "@react-navigation/native";
import { useLayoutEffect, useMemo, useState } from "react";
import { Pressable, ScrollView, TextInput, View } from "react-native";

import { AppText as Text } from "../../components/AppText";
import { EmptyState } from "../../components/EmptyState";
import { ErrorBanner } from "../../components/ErrorBanner";
import { OptionRow } from "../../components/OptionRow";
import { useThemeColor } from "../../lib/useThemeColor";
import { useHomeWorkspaceData } from "../../state/homeData";
import { SettingsSection } from "../settings/components/SettingsSection";
import { SettingsSwitchRow } from "../settings/components/SettingsSwitchRow";
import { CopyProgressView, type StartedCopy } from "./CopyProgressView";
import {
  changedFilesLabel,
  copyMembersOf,
  copyModeRows,
  copyStartLabel,
} from "./copyProjectScreenModel";
import {
  discardProjectCopy,
  readProjectCopyRecord,
  startManagedProjectCopy,
  useProjectCopyEntry,
} from "./mobileCopyManager";
import { useMobileNodeCatalog } from "./mobileNodeCatalog";
import {
  useCopyDestination,
  useCopyRemoteAccess,
  useCopySource,
  useCopyTargetConfig,
  useHeldNode,
} from "./useCopyPlanning";

/**
 * "Copy <project> to another machine" on the phone: the web dialog's flow as
 * one sheet (From, To, Folder, How, what comes along, setup), then the copy's
 * progress and how it ended in the same sheet. Closing never cancels a copy:
 * it goes on and a notice follows it. Copies run through the shared copy
 * manager (`mobileCopyManager`).
 */
export function CopyProjectScreen(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetEnvironmentId: EnvironmentId | null;
  /** Shows a copy already running (the notice's Show). */
  readonly copyId: string | null;
  /** A copy whose upload stopped when the app closed, started again with its ids. */
  readonly resumeCopyId: string | null;
}) {
  const [started, setStarted] = useState<StartedCopy | null>(null);
  const copyId = started?.copyId ?? props.copyId;
  const entry = useProjectCopyEntry(copyId);
  // A stopped copy goes back to the form.
  const stopped = entry !== null && !entry.running && entry.progress.phase === "cancelled";
  if (copyId !== null && !stopped && (started !== null || entry !== null)) {
    return <CopyProgressView copyId={copyId} started={started} />;
  }
  return (
    <CopyProjectForm
      environmentId={props.environmentId}
      projectId={props.projectId}
      targetEnvironmentId={props.targetEnvironmentId}
      resumeCopyId={props.resumeCopyId}
      notice={stopped ? "The copy was cancelled. Change what you need and start it again." : null}
      onStarted={setStarted}
    />
  );
}

function Segments(props: {
  readonly segments: ReadonlyArray<CopyTextSegment>;
  readonly className: string;
}) {
  return (
    <Text className={props.className}>
      {props.segments.map((segment, index) => (
        <Text
          // Segments are positional fragments of one sentence.
          // eslint-disable-next-line react/no-array-index-key
          key={index}
          className={segment.mono ? "font-mono text-xs" : undefined}
        >
          {segment.text}
        </Text>
      ))}
    </Text>
  );
}

function CopyProjectForm(props: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetEnvironmentId: EnvironmentId | null;
  readonly resumeCopyId: string | null;
  readonly notice: string | null;
  readonly onStarted: (copy: StartedCopy) => void;
}) {
  const navigation = useNavigation();
  const placeholderColor = useThemeColor("--color-placeholder");
  const textColor = useThemeColor("--color-foreground");
  const { projects } = useHomeWorkspaceData();
  const catalog = useMobileNodeCatalog();
  const nodes = catalog.nodes;
  const ref = { environmentId: props.environmentId, projectId: props.projectId };
  const members = useMemo(
    () =>
      copyMembersOf(projects, {
        environmentId: props.environmentId,
        projectId: props.projectId,
      }),
    [projects, props.environmentId, props.projectId],
  );

  /* ── From ── */
  const sourceRows = useMemo(
    () =>
      copySourceRows({
        members,
        nodes,
        labelOf: () => "Machine",
      }),
    [members, nodes],
  );
  const [pickedSourceKey, setPickedSourceKey] = useState<string | null>(null);
  const sourceRow =
    sourceRows.find((row) => row.key === pickedSourceKey && row.selectable) ??
    initialCopySource(sourceRows, ref);
  const sourceProject =
    (sourceRow &&
      members.find(
        (member) =>
          member.environmentId === sourceRow.ref.environmentId &&
          member.id === sourceRow.ref.projectId,
      )) ??
    null;
  const sourceHold = useHeldNode(sourceRow?.selectable ? sourceRow.ref.environmentId : null);
  const source = useCopySource({
    project: sourceProject,
    node: sourceRow?.node ?? null,
    hold: sourceHold,
  });
  const title = sourceProject?.name ?? members[0]?.name ?? "Project";
  const sourceLabel = sourceRow?.label ?? "the source";
  const [resumeRecord] = useState(() =>
    props.resumeCopyId ? readProjectCopyRecord(props.resumeCopyId) : null,
  );

  useLayoutEffect(() => {
    navigation.setOptions({ title: `Copy ${title}` });
  }, [navigation, title]);

  /* ── To ── */
  const [nowMs] = useState(() => Date.now());
  const cards = useMemo(() => copyTargetCards({ nodes, members, nowMs }), [members, nodes, nowMs]);
  const [pickedTargetId, setPickedTargetId] = useState<EnvironmentId | null>(null);
  const pickedCard = cards.find((card) => card.node.environmentId === pickedTargetId);
  const targetId = pickedCard?.selectable
    ? pickedCard.node.environmentId
    : initialCopyTarget(cards, requestedCopyTarget(props.targetEnvironmentId, resumeRecord));
  const targetNode = cards.find((card) => card.node.environmentId === targetId)?.node ?? null;
  const targetLabel = targetNode?.label ?? "the destination";
  const targetHold = useHeldNode(targetId);
  const targetSupport = targetNode?.projectCopySupport ?? "unknown";

  /* ── Folder ── */
  const [manualParent, setManualParent] = useState<{
    readonly targetId: EnvironmentId | null;
    readonly path: string;
  } | null>(null);
  const [folderDraft, setFolderDraft] = useState<string | null>(null);
  const manualPath = manualParent && manualParent.targetId === targetId ? manualParent.path : null;
  const destination = useCopyDestination({
    environmentId: targetId,
    supported: targetSupport === "yes",
    source,
    manualParent: manualPath,
  });
  const target = useCopyTargetConfig(targetId, targetHold.status === "held");

  /* ── Options ── */
  const [choices, setChoices] = useState<CopyUserChoices>(DEFAULT_COPY_USER_CHOICES);
  const targetFactsBase: ProjectCopyTargetFacts = {
    label: targetLabel,
    platformOs: catalogPlatformOs(targetNode?.platformOs ?? null),
    projectCopySupport: targetHold.status === "failed" ? "unknown" : targetSupport,
    folderCopySupport: projectCopyFolderSupportOf(target.config),
    transport: targetNode?.transport ?? targetHold.transport,
    remoteAccess: null,
    destination: destination.suggestion,
  };
  const draftOptions =
    source.facts && targetNode ? planCopyOptions(source.facts, targetFactsBase, choices) : null;
  const remoteUrl =
    draftOptions?.modes.clone.available === true ? draftOptions.modes.clone.remoteUrl : null;
  const remoteAccess = useCopyRemoteAccess({
    environmentId: targetId,
    supported: targetSupport === "yes",
    remoteUrl,
  });
  const targetFacts: ProjectCopyTargetFacts = {
    ...targetFactsBase,
    remoteAccess: remoteAccess.data,
  };
  const options: ProjectCopyOptionsPlan | null =
    source.facts && targetNode ? planCopyOptions(source.facts, targetFacts, choices) : null;
  const mode = options?.choices.mode ?? "clone";
  const inspection = source.facts?.kind === "inspected" ? source.facts.inspection : null;

  /* ── Setup ── */
  const prefill = options?.setup.command ?? null;
  const [setupEnabled, setSetupEnabled] = useState<boolean | null>(null);
  const [setupCommand, setSetupCommand] = useState<string | null>(null);
  const runSetup = setupEnabled ?? prefill !== null;
  const command = setupCommand ?? prefill ?? "";
  const followUpDefaults = projectCopyFollowUpDefaults({
    title,
    targetLabel,
    targetConfig: target.config,
  });
  const [followUpEnabled, setFollowUpEnabled] = useState(false);
  const [followUpPrompt, setFollowUpPrompt] = useState<string | null>(null);
  const prompt = followUpPrompt ?? followUpDefaults.prompt;
  const modelSelection = followUpDefaults.modelSelection;

  /* ── Starting ── */
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const suggestion = destination.suggestion;
  const setupInvalid = runSetup && command.trim().length === 0;
  const followUpInvalid =
    followUpEnabled && (modelSelection === null || prompt.trim().length === 0);
  const blockedReason = copyFormBlockedReason({
    title,
    sourceLabel,
    targetLabel,
    hasSource: sourceRow !== null,
    sourceError: source.error,
    sourceChecked: source.facts !== null,
    targetHoldError: targetHold.status === "failed" ? targetHold.error : null,
    targetSupport,
    options,
    destination: suggestion,
    destinationError: destination.error,
    // The phone holds direct machines without slots and few Hub ones at once.
    capReason: null,
    setupInvalid,
    followUpProblem: followUpInvalid
      ? (followUpDefaults.unavailableReason ?? "Write what the agent should do.")
      : null,
  });
  const canStart =
    options !== null &&
    blockedReason === null &&
    copyDestinationUsable(suggestion) &&
    targetId !== null &&
    destination.hints !== null &&
    !starting;

  const start = async () => {
    if (!canStart || !options || !source.facts || targetId === null || !destination.hints) return;
    const built = buildProjectCopyRunPlan({
      planning: { source: source.facts, target: targetFacts },
      options,
      target: { environmentId: targetId, pathSeparator: destination.hints.pathSeparator },
      title,
      setup: runSetup ? { command: command.trim(), saveAsScript: false } : null,
      followUpThread:
        followUpEnabled && modelSelection
          ? {
              title: followUpDefaults.title,
              prompt: prompt.trim(),
              runtimeMode: followUpDefaults.runtimeMode,
              envMode: followUpDefaults.envMode,
              modelSelection,
            }
          : null,
      origin: { kind: "user", sourceLabel: sourceLabel.slice(0, 120), proposalId: null },
    });
    if (!built.ok) {
      setStartError(built.reason);
      return;
    }
    setStarting(true);
    setStartError(null);
    const resume = resumableCopyRecord(resumeRecord, {
      sourceRef: sourceRow?.ref ?? null,
      targetEnvironmentId: targetId,
    });
    const context: CopyProgressContext = copyProgressContextOf({
      plan: built.plan,
      options,
      inspection,
      targetLabel,
      targetHome: destination.hints.homeDirectory,
    });
    await startManagedProjectCopy({
      plan: built.plan,
      toast: false,
      sourceRef: sourceRow?.ref ?? null,
      resume,
    }).then(
      (copy) => {
        if (resumeRecord !== null && resume === null) discardProjectCopy(resumeRecord.copyId);
        props.onStarted({
          copyId: copy.copyId,
          title,
          targetEnvironmentId: targetId,
          targetLabel,
          context,
        });
      },
      (cause: unknown) => {
        setStartError(cause instanceof Error ? cause.message : "The copy did not start.");
        setStarting(false);
      },
    );
  };

  if (members.length === 0) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-screen"
        contentContainerStyle={{ paddingHorizontal: 20, paddingVertical: 48 }}
      >
        <EmptyState
          variant="plain"
          title="Project not found"
          detail="Waiting for the machine to publish this project."
        />
      </ScrollView>
    );
  }

  const destinationCards = copyDestinationCards(cards);
  const alreadyOn = copyAlreadyOn(cards);
  const noTarget = cards.every((card) => !card.selectable);
  const tag = copyFolderTag(suggestion);
  const note = copyFolderNote({
    suggestion,
    manual: manualPath !== null,
    sourceLabel,
    targetLabel,
    targetHome: destination.hints?.homeDirectory ?? null,
    projectTitle: title,
  });
  const summary = options
    ? copySegmentsText(
        copyOptionsSummary({
          mode,
          changes:
            options.choices.bringChanges && inspection
              ? inspection.workingTree.trackedChangeCount + inspection.workingTree.untrackedCount
              : 0,
          commits: options.choices.bringCommits ? options.bringCommits.unpushedCommitCount : 0,
          ignoredFiles: 0,
          copySettings: options.choices.copySettings,
          setupCommand: runSetup ? command : null,
          followUp: followUpEnabled,
        }),
      )
    : null;
  const shownError = startError ?? (noTarget ? null : blockedReason);

  return (
    <ScrollView
      contentInsetAdjustmentBehavior="automatic"
      keyboardShouldPersistTaps="handled"
      className="flex-1 bg-screen"
      contentContainerStyle={{ paddingBottom: 48 }}
    >
      {props.notice ? (
        <View className="mx-5 mt-4">
          <ErrorBanner message={props.notice} />
        </View>
      ) : resumeRecord !== null ? (
        <View className="mx-5 mt-4 rounded-xl bg-subtle p-3">
          <Text className="font-sans text-sm text-foreground-muted">
            {copyResumeNotice(
              nodes.find((node) => node.environmentId === resumeRecord.targetEnvironmentId)
                ?.label ?? "the destination",
            )}
          </Text>
        </View>
      ) : null}

      {sourceRows.length > 1 ? (
        <View className="mt-4 gap-2 px-5">
          <Text className="pb-0.5 text-sm font-ryco-medium text-foreground-muted">From</Text>
          {sourceRows.map((row) => (
            <OptionRow
              key={row.key}
              label={row.label}
              detail={row.reason ?? row.displayPath}
              selected={row.key === sourceRow?.key}
              disabled={!row.selectable}
              onPress={() => setPickedSourceKey(row.key)}
            />
          ))}
        </View>
      ) : (
        <View className="mx-5 mt-4 gap-0.5">
          <Text className="text-sm font-ryco-medium text-foreground-muted">From {sourceLabel}</Text>
          <Text className="font-mono text-xs text-foreground-tertiary" numberOfLines={1}>
            {sourceRow?.displayPath ?? ""}
          </Text>
        </View>
      )}

      <View className="mt-6 gap-2 px-5">
        <Text className="pb-0.5 text-sm font-ryco-medium text-foreground-muted">To</Text>
        {noTarget ? (
          <Text className="font-sans text-sm leading-5 text-foreground-muted">
            {copyNoTargetMessage(title, cards)}
          </Text>
        ) : (
          destinationCards.map((card) => (
            <OptionRow
              key={card.node.environmentId}
              label={card.node.label}
              detail={card.reason ?? card.sub}
              selected={card.node.environmentId === targetId}
              disabled={!card.selectable}
              onPress={() => setPickedTargetId(card.node.environmentId)}
            />
          ))
        )}
        {alreadyOn.length > 0 ? (
          <Text className="px-1 font-sans text-xs text-foreground-tertiary">
            Already on {alreadyOn.map((card) => card.node.label).join(", ")}
          </Text>
        ) : null}
      </View>

      {noTarget ? null : (
        <>
          <SettingsSection title="Folder">
            <View className="gap-1.5 px-5 py-3.5">
              <View className="flex-row items-center gap-2">
                <Text
                  className="min-w-0 flex-1 font-mono text-sm text-foreground"
                  numberOfLines={2}
                >
                  {suggestion
                    ? displayProjectPath(suggestion.path, destination.hints?.homeDirectory)
                    : "…"}
                </Text>
                {tag ? (
                  <View className="rounded-full bg-subtle px-2.5 py-1">
                    <Text
                      className={`text-xs font-ryco-medium ${
                        tag.tone === "warning" ? "text-warning" : "text-foreground-muted"
                      }`}
                    >
                      {tag.text}
                    </Text>
                  </View>
                ) : null}
              </View>
              <Segments
                segments={note.segments}
                className={`font-sans text-xs leading-4 ${
                  note.tone === "negative" ? "text-danger-foreground" : "text-foreground-muted"
                }`}
              />
            </View>
            {folderDraft === null ? (
              <Pressable
                accessibilityRole="button"
                disabled={destination.hints === null}
                onPress={() => setFolderDraft(manualPath ?? destination.hints?.homeDirectory ?? "")}
                className="border-t border-border-subtle px-5 py-3.5 active:bg-subtle disabled:opacity-40"
              >
                <Text className="font-sans text-[17px] text-primary">
                  {manualPath === null ? "Choose another folder" : "Change folder"}
                </Text>
              </Pressable>
            ) : (
              <View className="gap-2 border-t border-border-subtle px-5 py-3.5">
                <Text className="text-xs font-ryco-medium text-foreground-muted">
                  Parent folder on {targetLabel}
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  autoFocus
                  value={folderDraft}
                  onChangeText={setFolderDraft}
                  placeholder="/Users/you/Code"
                  placeholderTextColor={placeholderColor as string}
                  className="min-h-11 rounded-xl border border-border bg-card-alt px-3 font-mono text-sm"
                  style={{ color: textColor as string }}
                />
                <View className="flex-row gap-2">
                  {manualPath !== null ? (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => {
                        setManualParent(null);
                        setFolderDraft(null);
                      }}
                      className="h-10 flex-1 items-center justify-center rounded-full bg-subtle active:opacity-70"
                    >
                      <Text className="text-sm font-ryco-bold text-foreground">Use suggestion</Text>
                    </Pressable>
                  ) : (
                    <Pressable
                      accessibilityRole="button"
                      onPress={() => setFolderDraft(null)}
                      className="h-10 flex-1 items-center justify-center rounded-full bg-subtle active:opacity-70"
                    >
                      <Text className="text-sm font-ryco-bold text-foreground">Cancel</Text>
                    </Pressable>
                  )}
                  <Pressable
                    accessibilityRole="button"
                    disabled={folderDraft.trim().length === 0}
                    onPress={() => {
                      setManualParent({ targetId, path: folderDraft.trim() });
                      setFolderDraft(null);
                    }}
                    className="h-10 flex-1 items-center justify-center rounded-full bg-primary active:opacity-80 disabled:opacity-40"
                  >
                    <Text className="text-sm font-ryco-bold text-primary-foreground">
                      Use folder
                    </Text>
                  </Pressable>
                </View>
              </View>
            )}
          </SettingsSection>

          {options ? (
            <View className="mt-6 gap-2 px-5">
              <Text className="pb-0.5 text-sm font-ryco-medium text-foreground-muted">How</Text>
              {copyModeRows(options).map((row) => (
                <OptionRow
                  key={row.mode}
                  label={row.label}
                  detail={row.detail}
                  detailLines={2}
                  selected={row.mode === mode}
                  disabled={!row.available}
                  onPress={() => setChoices((current) => ({ ...current, mode: row.mode }))}
                />
              ))}
            </View>
          ) : null}

          {options && mode !== "link" ? (
            <SettingsSection title="Bring along">
              <SettingsSwitchRow
                first
                label="Unpushed commits"
                detail={
                  options.bringCommits.reason ??
                  (options.bringCommits.unpushedCommitCount > 0
                    ? `${options.bringCommits.unpushedCommitCount} not on the remote yet`
                    : "None right now")
                }
                value={options.choices.bringCommits}
                disabled={!options.bringCommits.available || options.bringCommits.forced}
                onValueChange={(value) =>
                  setChoices((current) => ({ ...current, bringCommits: value }))
                }
              />
              <SettingsSwitchRow
                label="Uncommitted changes"
                detail={
                  options.bringChanges.reason ??
                  (inspection
                    ? changedFilesLabel(
                        inspection.workingTree.trackedChangeCount +
                          inspection.workingTree.untrackedCount,
                      )
                    : undefined)
                }
                value={options.choices.bringChanges}
                disabled={!options.bringChanges.available || mode === "send-files"}
                onValueChange={(value) =>
                  setChoices((current) => ({ ...current, bringChanges: value }))
                }
              />
              <SettingsSwitchRow
                label="Project settings"
                detail="Scripts, agent instructions and the avatar"
                value={options.choices.copySettings}
                disabled={!options.copySettings.available}
                onValueChange={(value) =>
                  setChoices((current) => ({ ...current, copySettings: value }))
                }
              />
            </SettingsSection>
          ) : null}

          {options ? (
            <SettingsSection title="After copying">
              <SettingsSwitchRow
                first
                label="Run a setup command"
                detail={options.setup.osNote ?? undefined}
                value={runSetup}
                onValueChange={setSetupEnabled}
              />
              {runSetup ? (
                <View className="border-t border-border-subtle px-5 py-3">
                  <TextInput
                    autoCapitalize="none"
                    autoCorrect={false}
                    value={command}
                    onChangeText={setSetupCommand}
                    placeholder="bun install"
                    placeholderTextColor={placeholderColor as string}
                    className="min-h-11 rounded-xl border border-border bg-card-alt px-3 font-mono text-sm"
                    style={{ color: textColor as string }}
                  />
                </View>
              ) : null}
              <SettingsSwitchRow
                label="Let an agent finish setup"
                detail={
                  followUpDefaults.unavailableReason ??
                  `Starts a chat on ${targetLabel} once the copy is ready`
                }
                value={followUpEnabled}
                disabled={modelSelection === null}
                onValueChange={setFollowUpEnabled}
              />
              {followUpEnabled ? (
                <View className="border-t border-border-subtle px-5 py-3">
                  <TextInput
                    multiline
                    value={prompt}
                    onChangeText={setFollowUpPrompt}
                    placeholderTextColor={placeholderColor as string}
                    className="min-h-20 rounded-xl border border-border bg-card-alt px-3 py-2 font-sans text-sm"
                    style={{ color: textColor as string }}
                  />
                </View>
              ) : null}
            </SettingsSection>
          ) : null}

          <View className="mt-6 gap-3 px-5">
            {shownError ? (
              <Text className="font-sans text-sm leading-5 text-foreground-muted">
                {shownError}
              </Text>
            ) : summary ? (
              <Text className="font-sans text-sm leading-5 text-foreground-muted">{summary}</Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              disabled={!canStart}
              onPress={() => void start()}
              className="h-12 items-center justify-center rounded-full bg-primary px-5 active:opacity-80 disabled:opacity-40"
            >
              <Text className="text-base font-ryco-bold text-primary-foreground">
                {starting ? "Starting…" : copyStartLabel(mode, targetLabel)}
              </Text>
            </Pressable>
          </View>
        </>
      )}
    </ScrollView>
  );
}
