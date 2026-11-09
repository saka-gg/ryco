// FILE: CopyProjectForm.tsx
// Purpose: The form of "Copy <project> to another node": From (the project's
//          checkouts; one line when there is one), To (node cards, and an
//          "Already on" line for the nodes that have it), How (clone from origin
//          or send the files; a plain folder only sends its files), the folder on the destination with its picker,
//          the options (unpushed commits, uncommitted changes and ignored files,
//          settings, the setup command, a setup agent; folded into the footer's
//          one-line summary until Edit) and the footer that starts the copy.
//          What is possible comes from the coordinator's plan; the destination
//          last used from this checkout is preselected.
// Layer: Web UI inside `CopyProjectDialog`; its reads live in
//        `useCopyProjectPlanning.ts`, its wording in `copyProjectDialog.logic.ts`.

import {
  buildProjectCopyRunPlan,
  formatCopyMegabytes,
  projectCopyFolderSupportOf,
  projectCopyFollowUpDefaults,
  type ProjectCopyOptionsPlan,
  type ProjectCopyTargetFacts,
} from "@ryco/client-runtime/projectCopy";
import { catalogPlatformOs, type NodeCatalogEntry } from "@ryco/client-runtime/state/nodes";
import { UNIFIED_WORKSPACE_MAX_CONNECTIONS } from "@ryco/client-runtime/state/workspace";
import {
  DEFAULT_UNIFIED_SETTINGS,
  type EnvironmentId,
  type ModelSelection,
  type ProjectId,
  type ServerConfig,
} from "@ryco/contracts";
import {
  PROJECT_COPY_SETUP_COMMAND_MAX_CHARS,
  type ProjectExportFolder,
} from "@ryco/contracts/project-copy";
import { displayRemoteUrl } from "@ryco/shared/gitRemoteUrl";
import { createModelSelection } from "@ryco/shared/model";
import {
  ArrowRightLeftIcon,
  CopyIcon,
  FolderIcon,
  GitCommitHorizontalIcon,
  LinkIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useId, useMemo, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";

import { getGitStatusSnapshot } from "../../lib/gitStatusState";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import { useSettingsDialogStore } from "../../settingsDialogStore";
import {
  deriveProviderInstanceEntries,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import type { Project } from "../../types";
import { updateEverythingRunner, useNodeUpdateState } from "../../updates/useUpdateEverything";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { DialogTitle } from "../ui/dialog";
import { rovingRadioGroup } from "../ui/roving-radio-group";
import { Textarea } from "../ui/textarea";
import {
  discardProjectCopy,
  readProjectCopyRecord,
  type ProjectCopyEntry,
} from "./copyRuntime/copyManager";
import {
  readRememberedCopyDestination,
  rememberCopyDestination,
  type RememberedCopyDestination,
} from "./copyDestinationMemory";
import {
  copyAlreadyOn,
  copyCheckoutMeta,
  copyConnectionCapReason,
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
  nodesHeldByCopy,
  parentOfNodePath,
  type CopyCheckoutMeta,
  type CopyProgressContext,
  type CopySourceRow,
  type CopyTargetCard,
} from "@ryco/client-runtime/projectCopy/dialog";
import {
  CopyCheckoutMetaLine,
  CopyField,
  CopyRadioDot,
  CopyRingSpinner,
  CopySegments,
} from "./copyProjectDialogParts";
import { FolderPicker } from "./FolderPicker";
import { displayProjectPath } from "@ryco/shared/projectPaths";
import { NodeBadge } from "./NodePicker";
import { NODE_LABEL_CELL, NodePathText, useNodeLabelColumn } from "./NodePathText";
import type { CopyProjectDialogRequest } from "./projectNodesDialogStore";
import {
  copyDestinationUsable,
  copyFormBlockedReason,
  copyProgressContextOf,
  copyResumeMismatch,
  copyResumeNotice,
  copyResumePin,
  resumableCopyRecord,
} from "@ryco/client-runtime/projectCopy/form";
import { copyParentFolderOf } from "@ryco/client-runtime/projectCopy/destinationMemory";
import {
  DEFAULT_COPY_USER_CHOICES,
  planCopyOptions,
  useCopyDestination,
  useCopyRemoteAccess,
  useCopySource,
  useCopyTargetConfig,
  useHeldNode,
  type CopyDialogServices,
  type CopyUserChoices,
} from "./useCopyProjectPlanning";

/** A copy the form started, with what its progress view needs to word it. */
export interface StartedProjectCopy {
  readonly copyId: string;
  readonly title: string;
  readonly targetEnvironmentId: EnvironmentId;
  readonly targetLabel: string;
  readonly context: CopyProgressContext;
}

export interface CopyProjectFormProps {
  readonly request: CopyProjectDialogRequest;
  readonly nodes: ReadonlyArray<NodeCatalogEntry>;
  /** Every checkout of the logical project, the requested one included. */
  readonly members: ReadonlyArray<Project>;
  readonly services: CopyDialogServices;
  /** This session's copies; the running ones count against the connection cap (A22). */
  readonly copies: ReadonlyArray<ProjectCopyEntry>;
  /** Shown above the form, e.g. after a copy was stopped. */
  readonly notice?: string | null | undefined;
  readonly onStarted: (copy: StartedProjectCopy) => void;
  readonly onClose: () => void;
}

/** Status the client already has for a checkout (never starts a watch, A36(1)). */
function loadedCheckoutMeta(project: Project): CopyCheckoutMeta {
  const target = { environmentId: project.environmentId, cwd: project.cwd };
  const full = getGitStatusSnapshot(target);
  if (full.data) return copyCheckoutMeta(full.data, { remotePending: full.remotePending === true });
  const summary = getGitStatusSnapshot(target, "summary");
  return copyCheckoutMeta(summary.data, { summaryOnly: true });
}

function nodeLabelOf(nodes: ReadonlyArray<NodeCatalogEntry>) {
  return (environmentId: EnvironmentId) =>
    nodes.find((node) => node.environmentId === environmentId)?.label ?? "Device";
}

/* ───────── Sections ───────── */

function SourceList(props: {
  readonly rows: ReadonlyArray<CopySourceRow>;
  readonly metaByKey: ReadonlyMap<string, CopyCheckoutMeta>;
  readonly value: string | null;
  readonly onChange: (key: string) => void;
  readonly labelledBy: string;
}) {
  const listRef = useRef<HTMLDivElement | null>(null);
  useNodeLabelColumn(listRef, props.rows);
  const only = props.rows.length === 1 ? props.rows[0] : undefined;
  if (only) {
    // One checkout: nothing to choose, so a line instead of a one-option radio.
    return (
      <div
        data-testid="copy-source-line"
        title={only.reason ?? only.path}
        className="flex min-w-0 items-center gap-2 rounded-[10px] border border-border px-2.5 py-2 text-[12.5px]"
      >
        {only.node ? <NodeBadge node={only.node} size="sm" /> : null}
        <span className="max-w-[45%] shrink-0 truncate">{only.label}</span>
        <NodePathText
          path={only.displayPath}
          title={only.reason ?? only.path}
          className="flex-1 font-mono text-[11.5px] opacity-75"
        />
        <CopyCheckoutMetaLine
          meta={props.metaByKey.get(only.key) ?? { branch: null, changed: 0, behind: 0 }}
          offline={only.offline}
        />
      </div>
    );
  }
  const group = rovingRadioGroup<string>({
    options: props.rows.map((row) => ({ value: row.key, disabled: !row.selectable })),
    value: props.value,
    onChange: props.onChange,
  });
  return (
    <div
      ref={listRef}
      role="radiogroup"
      aria-labelledby={props.labelledBy}
      onKeyDown={group.onKeyDown}
      className="flex flex-col overflow-hidden rounded-[10px] border border-border"
    >
      {props.rows.map((row) => (
        <button
          key={row.key}
          {...group.radio(row.key)}
          title={row.reason ?? row.path}
          className={cn(
            "group/radio flex w-full min-w-0 items-center gap-2 px-2.5 py-2 text-left text-[12.5px] outline-none",
            "border-border not-first:border-t transition-colors duration-(--app-motion-duration-chip)",
            "hover:not-disabled:bg-accent/60 focus-visible:bg-accent/60",
            "data-checked:bg-primary/10 dark:data-checked:bg-primary/16",
            "disabled:cursor-not-allowed disabled:opacity-50",
          )}
        >
          <CopyRadioDot />
          {row.node ? <NodeBadge node={row.node} size="sm" /> : null}
          <span className="w-(--node-label-column,96px) shrink-0 truncate" {...NODE_LABEL_CELL}>
            {row.label}
          </span>
          <NodePathText
            path={row.displayPath}
            title={row.reason ?? row.path}
            className="flex-1 font-mono text-[11.5px] opacity-75"
          />
          <CopyCheckoutMetaLine
            meta={props.metaByKey.get(row.key) ?? { branch: null, changed: 0, behind: 0 }}
            offline={row.offline}
          />
        </button>
      ))}
    </div>
  );
}

function TargetCards(props: {
  readonly cards: ReadonlyArray<CopyTargetCard>;
  readonly value: EnvironmentId | null;
  readonly checkingLabel: string | null;
  readonly onChange: (environmentId: EnvironmentId) => void;
  readonly labelledBy: string;
}) {
  const group = rovingRadioGroup<string>({
    options: props.cards.map((card) => ({
      value: card.node.environmentId,
      disabled: !card.selectable,
    })),
    value: props.value,
    onChange: (value) => props.onChange(value as EnvironmentId),
  });
  return (
    <div
      role="radiogroup"
      aria-labelledby={props.labelledBy}
      onKeyDown={group.onKeyDown}
      className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
    >
      {props.cards.map((card) => {
        const checked = props.value === card.node.environmentId;
        const sub = checked && props.checkingLabel ? props.checkingLabel : card.sub;
        return (
          <button
            key={card.node.environmentId}
            {...group.radio(card.node.environmentId)}
            title={card.reason ?? sub}
            data-state={card.state}
            className={cn(
              "flex min-w-0 flex-col items-start gap-1 rounded-[9px] border border-border p-[9px] text-left text-[12px] outline-none",
              "transition-[border-color,background-color,box-shadow,opacity] duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
              "hover:not-disabled:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
              "data-checked:border-primary data-checked:shadow-[0_0_0_1px_var(--primary)]",
              "disabled:cursor-not-allowed disabled:opacity-45",
            )}
          >
            <NodeBadge node={card.node} size="md" />
            <span className="max-w-full truncate font-medium">{card.node.label}</span>
            <span className="max-w-full truncate text-[10.5px] text-muted-foreground">{sub}</span>
          </button>
        );
      })}
    </div>
  );
}

/** The nodes that already have the project: named, with their path on hover, instead of a card each. */
function AlreadyOnLine(props: { readonly cards: ReadonlyArray<CopyTargetCard> }) {
  if (props.cards.length === 0) return null;
  return (
    <span
      className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-0.5 text-[11.5px] text-muted-foreground"
      data-testid="copy-already-on"
    >
      <span>Already on</span>
      {props.cards.map((card, index) => (
        <span
          key={card.node.environmentId}
          className="inline-flex min-w-0 items-center gap-1"
          title={card.sub}
        >
          <NodeBadge node={card.node} size="sm" />
          <span className="truncate text-foreground/80">{card.node.label}</span>
          <span className="sr-only">({card.sub})</span>
          {index < props.cards.length - 1 ? <span aria-hidden>·</span> : null}
        </span>
      ))}
    </span>
  );
}

/** "Update Ryco on X" with the node's own update when it can install one (A23). */
function NodeUpdateOffer(props: { readonly node: NodeCatalogEntry }) {
  const update = useNodeUpdateState(props.node.environmentId);
  const [started, setStarted] = useState(false);
  if (!update?.canUpdate || update.availability !== "behind_latest") return null;
  return (
    <div className="flex items-center gap-2 text-[12px] text-muted-foreground">
      <span className="min-w-0 flex-1">
        {props.node.label} runs an older Ryco. Update it to copy projects there.
      </span>
      <Button
        size="xs"
        variant="outline"
        disabled={started}
        onClick={() => {
          setStarted(true);
          updateEverythingRunner.start({ environmentIds: [props.node.environmentId] });
        }}
      >
        {started ? "Updating…" : `Update ${props.node.label}`}
      </Button>
    </div>
  );
}

function MethodCard(props: {
  readonly selected: boolean;
  readonly disabled: boolean;
  readonly icon: ReactNode;
  readonly title: string;
  readonly recommended?: boolean;
  readonly radio: ReturnType<ReturnType<typeof rovingRadioGroup<string>>["radio"]>;
  readonly children: ReactNode;
}) {
  return (
    <button
      {...props.radio}
      className={cn(
        "group/radio flex min-w-0 items-start gap-[9px] rounded-[9px] border border-border p-2.5 text-left text-[12px] outline-none",
        "transition-[border-color,background-color,box-shadow,opacity] duration-(--app-motion-duration-chip) ease-(--app-motion-ease)",
        "hover:not-disabled:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring",
        "data-checked:border-primary data-checked:shadow-[0_0_0_1px_var(--primary)]",
        "disabled:cursor-not-allowed disabled:opacity-45",
      )}
    >
      <CopyRadioDot className="mt-0.5" />
      <span className="min-w-0">
        <span className="mb-0.5 flex flex-wrap items-center gap-1.5 font-medium text-[12.5px]">
          {props.icon}
          {props.title}
          {props.recommended ? (
            <span className="whitespace-nowrap rounded-full bg-primary/12 px-1.5 py-px font-medium text-[10.5px] dark:bg-primary/20">
              Recommended
            </span>
          ) : null}
        </span>
        <span className="block text-[11.5px] text-muted-foreground">{props.children}</span>
      </span>
    </button>
  );
}

function CheckRow(props: {
  readonly checked: boolean;
  readonly disabled?: boolean;
  readonly onChange?: (checked: boolean) => void;
  readonly children: ReactNode;
  readonly hint?: ReactNode;
  readonly testId?: string;
}) {
  const id = useId();
  return (
    <div className="flex flex-col py-[5px]" data-testid={props.testId}>
      <label
        htmlFor={id}
        className={cn(
          "flex cursor-pointer items-center gap-[9px] px-0.5 text-[12.5px]",
          props.disabled && "cursor-default text-muted-foreground",
        )}
      >
        <Checkbox
          id={id}
          checked={props.checked}
          disabled={props.disabled}
          onCheckedChange={(next) => props.onChange?.(next === true)}
        />
        <span className="min-w-0">{props.children}</span>
      </label>
      {props.hint ? (
        <span className="ps-[27px] pt-0.5 text-[11.5px] text-muted-foreground">{props.hint}</span>
      ) : null}
    </div>
  );
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.ceil(bytes / 1024)} KB`;
  return formatCopyMegabytes(bytes);
}

/** Where this checkout was copied to last time, read once per source. */
function useRememberedDestination(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
): RememberedCopyDestination | null {
  return useMemo(
    () =>
      environmentId !== null && projectId !== null
        ? readRememberedCopyDestination({ environmentId, projectId })
        : null,
    [environmentId, projectId],
  );
}

/* ───────── The form ───────── */

export function CopyProjectForm(props: CopyProjectFormProps) {
  const { request, nodes, members, services } = props;
  const openSettings = useSettingsDialogStore((state) => state.openSettings);
  const ids = {
    from: useId(),
    to: useId(),
    how: useId(),
    folder: useId(),
    options: useId(),
    optionsPanel: useId(),
  };

  /* ── From ── */
  const sourceRows = useMemo(
    () => copySourceRows({ members, nodes, labelOf: nodeLabelOf(nodes) }),
    [members, nodes],
  );
  const metaByKey = useMemo(
    () =>
      new Map(
        members.map((member) => [
          `${member.environmentId}\u0000${member.id}`,
          loadedCheckoutMeta(member),
        ]),
      ),
    [members],
  );
  const [pickedSourceKey, setPickedSourceKey] = useState<string | null>(null);
  const sourceRow =
    sourceRows.find((row) => row.key === pickedSourceKey && row.selectable) ??
    initialCopySource(sourceRows, request.source);
  const sourceProject =
    (sourceRow &&
      members.find(
        (member) =>
          member.environmentId === sourceRow.ref.environmentId &&
          member.id === sourceRow.ref.projectId,
      )) ??
    null;
  const sourceHold = useHeldNode(
    services,
    sourceRow?.selectable ? sourceRow.ref.environmentId : null,
  );
  const source = useCopySource({
    project: sourceProject,
    node: sourceRow?.node ?? null,
    hold: sourceHold,
  });
  const title = sourceProject?.name ?? members[0]?.name ?? "Project";
  const sourceLabel = sourceRow?.label ?? "the source";
  // Where this checkout was copied to last time; read once per source.
  const remembered = useRememberedDestination(
    sourceRow?.ref.environmentId ?? null,
    sourceRow?.ref.projectId ?? null,
  );
  // A copy whose upload stopped when Ryco closed, picked up again from here
  // (until the user discards it to start over).
  const [resumeRecord, setResumeRecord] = useState(() =>
    request.resumeCopyId ? readProjectCopyRecord(request.resumeCopyId) : null,
  );

  /* ── To ── */
  const [nowMs] = useState(() => Date.now());
  const cards = useMemo(() => copyTargetCards({ nodes, members, nowMs }), [members, nodes, nowMs]);
  const [pickedTargetId, setPickedTargetId] = useState<EnvironmentId | null>(null);
  const pickedCard = cards.find((card) => card.node.environmentId === pickedTargetId);
  // A stopped copy goes on only to its own node, waiting for it if it is not back yet.
  const resumeLabel = resumeRecord ? nodeLabelOf(nodes)(resumeRecord.targetEnvironmentId) : "";
  const pin = copyResumePin({ record: resumeRecord, cards, targetLabel: resumeLabel });
  const targetId =
    pin !== null
      ? pin.targetEnvironmentId
      : pickedCard?.selectable
        ? pickedCard.node.environmentId
        : initialCopyTarget(
            cards,
            request.targetEnvironmentId,
            remembered?.targetEnvironmentId ?? null,
          );
  const targetCard = cards.find((card) => card.node.environmentId === targetId) ?? null;
  const targetNode = targetCard?.node ?? null;
  const targetLabel = targetNode?.label ?? "the destination";
  const targetHold = useHeldNode(services, targetId);
  const targetSupport = targetNode?.projectCopySupport ?? "unknown";

  /* ── Folder ── */
  const [manualParent, setManualParent] = useState<{
    readonly targetId: EnvironmentId | null;
    readonly path: string;
  } | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // The parent picked last time on this destination, until the user picks one now.
  // A stopped copy goes on into its own folder.
  const parentFolder =
    pin === null
      ? copyParentFolderOf({ targetId, picked: manualParent, remembered })
      : { path: null, remembered: false };
  const manualPath = parentFolder.path;
  const exactPath = pin?.destinationPath ?? null;
  const destination = useCopyDestination({
    environmentId: targetId,
    supported: targetSupport === "yes",
    source,
    manualParent: manualPath,
    exactPath,
  });

  // The target's config: its agents for the setup agent, and whether it unpacks plain folders.
  const target = useCopyTargetConfig(services, targetId, targetHold.status === "held");
  const targetConfig = target.config;

  /* ── Options ── */
  const [choices, setChoices] = useState<CopyUserChoices>(DEFAULT_COPY_USER_CHOICES);
  // Folded into the footer's summary until Edit, so the form fits a short window.
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsRef = useRef<HTMLDivElement | null>(null);
  const targetFactsBase: ProjectCopyTargetFacts = {
    label: targetLabel,
    platformOs: catalogPlatformOs(targetNode?.platformOs ?? null),
    projectCopySupport: targetHold.status === "failed" ? "unknown" : targetSupport,
    folderCopySupport: projectCopyFolderSupportOf(targetConfig),
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
  const plainFolder = inspection !== null && !inspection.repository.isGitRepository;

  /* ── Setup ── */
  const prefill = options?.setup.command ?? null;
  const [setupEnabled, setSetupEnabled] = useState<boolean | null>(null);
  const [setupCommand, setSetupCommand] = useState<string | null>(null);
  const runSetup = setupEnabled ?? prefill !== null;
  const command = setupCommand ?? prefill ?? "";

  /* ── Setup agent ── */
  const followUpDefaults = projectCopyFollowUpDefaults({
    title,
    targetLabel,
    targetConfig,
  });
  const [followUpEnabled, setFollowUpEnabled] = useState(false);
  const [followUpPrompt, setFollowUpPrompt] = useState<string | null>(null);
  const [followUpModel, setFollowUpModel] = useState<{
    readonly targetId: EnvironmentId | null;
    readonly selection: ModelSelection;
  } | null>(null);
  const modelSelection =
    followUpModel && followUpModel.targetId === targetId
      ? followUpModel.selection
      : followUpDefaults.modelSelection;
  const prompt = followUpPrompt ?? followUpDefaults.prompt;

  /* ── Starting ── */
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);
  const capReason = copyConnectionCapReason({
    copyNodes: [
      ...(targetId
        ? [{ environmentId: targetId, relayed: targetFacts.transport === "relay" }]
        : []),
      ...(source.facts?.kind === "inspected"
        ? [
            {
              environmentId: source.facts.environmentId,
              relayed: source.facts.transport === "relay",
            },
          ]
        : []),
    ],
    heldByRunningCopies: props.copies.flatMap((entry) =>
      nodesHeldByCopy(entry).map((environmentId) => ({
        environmentId,
        relayed: nodes.find((node) => node.environmentId === environmentId)?.transport === "relay",
      })),
    ),
    maxConnections: UNIFIED_WORKSPACE_MAX_CONNECTIONS,
  });

  const suggestion = destination.suggestion;
  const destinationUsable = copyDestinationUsable(suggestion);
  const setupInvalid = runSetup && command.trim().length === 0;
  const followUpInvalid =
    followUpEnabled && (modelSelection === null || prompt.trim().length === 0);
  // A node not connected yet is checked once held (A23); a known one reads right away.
  const checking =
    targetNode !== null && targetHold.status !== "failed" && targetSupport === "unknown";
  const formBlockedReason = copyFormBlockedReason({
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
    capReason,
    setupInvalid,
    followUpProblem: followUpInvalid
      ? (followUpDefaults.unavailableReason ?? "Write what the agent should do.")
      : null,
  });
  const blockedReason = pin?.waitingReason ?? formBlockedReason;
  const canStart =
    options !== null &&
    blockedReason === null &&
    destinationUsable &&
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
    const resume = resumableCopyRecord(resumeRecord, {
      sourceRef: sourceRow?.ref ?? null,
      targetEnvironmentId: targetId,
      destinationPath: built.plan.destinationPath,
    });
    // Never a new copy in place of the stopped one: that takes discarding it first.
    const mismatch = copyResumeMismatch(pin, resume);
    if (mismatch !== null) {
      setStartError(mismatch);
      return;
    }
    setStarting(true);
    setStartError(null);
    try {
      const started = await services.startCopy(built.plan, sourceRow?.ref ?? null, resume);
      if (sourceRow) {
        rememberCopyDestination(sourceRow.ref, {
          targetEnvironmentId: targetId,
          parentPath: manualPath,
        });
      }
      const plan = built.plan;
      props.onStarted({
        copyId: started.copyId,
        title,
        targetEnvironmentId: targetId,
        targetLabel,
        context: copyProgressContextOf({
          plan,
          options,
          inspection,
          targetLabel,
          targetHome: destination.hints.homeDirectory,
        }),
      });
    } catch (cause) {
      setStartError(cause instanceof Error ? cause.message : "The copy did not start.");
      setStarting(false);
    }
  };

  const noTarget = pin === null && cards.every((card) => !card.selectable);
  // "Update Ryco on X", with the node's own update, wherever an outdated node shows (A23).
  const updateOffers = cards
    .filter((card) => card.state === "outdated")
    .map((card) => <NodeUpdateOffer key={card.node.environmentId} node={card.node} />);
  const header = (
    <div className="flex items-center gap-2.5 ps-5 pe-12 pt-4 pb-3">
      <DialogTitle className="flex min-w-0 flex-1 items-center gap-2 font-semibold text-[15px] leading-tight">
        <CopyIcon aria-hidden className="size-[15px] shrink-0" />
        <span>Copy</span>
        {sourceProject ? (
          <ProjectFavicon
            environmentId={sourceProject.environmentId}
            cwd={sourceProject.cwd}
            projectId={sourceProject.id}
            customAvatarContentHash={sourceProject.customAvatarContentHash ?? null}
            fallbackName={sourceProject.name}
            className="size-4 rounded-[5px]"
          />
        ) : null}
        <span className="min-w-0 truncate">
          {title}
          {noTarget ? null : " to another node"}
        </span>
      </DialogTitle>
    </div>
  );

  if (noTarget) {
    const blockedCards = copyDestinationCards(cards);
    return (
      <>
        {header}
        <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pt-1 pb-4">
          {/* Only the nodes that can't take it for another reason keep a card (with why). */}
          {blockedCards.length > 0 ? (
            <TargetCards
              cards={blockedCards}
              value={null}
              checkingLabel={null}
              onChange={() => undefined}
              labelledBy={ids.to}
            />
          ) : null}
          <AlreadyOnLine cards={copyAlreadyOn(cards)} />
          {updateOffers}
          <p className="m-0 text-[13px] text-muted-foreground" data-testid="copy-no-target">
            {copyNoTargetMessage(title, cards)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2 border-border border-t bg-muted/30 px-5 py-3">
          <span className="min-w-0 flex-1" />
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              props.onClose();
              openSettings("devices");
            }}
          >
            Add a node
          </Button>
          <Button size="sm" variant="outline" onClick={props.onClose}>
            Close
          </Button>
        </div>
      </>
    );
  }

  const destinationCards =
    pin === null
      ? copyDestinationCards(cards)
      : cards.filter((card) => card.node.environmentId === pin.targetEnvironmentId);
  const alreadyOn = copyAlreadyOn(cards);
  const unpushedCount = options?.bringCommits.unpushedCommitCount ?? 0;
  const changeCount = inspection
    ? inspection.workingTree.trackedChangeCount + inspection.workingTree.untrackedCount
    : 0;
  const optionsSummary =
    options === null
      ? null
      : copyOptionsSummary({
          mode,
          changes: mode !== "link" && options.choices.bringChanges ? changeCount : 0,
          commits:
            mode === "send-files"
              ? unpushedCount
              : mode === "clone" && options.choices.bringCommits
                ? unpushedCount
                : 0,
          ignoredFiles:
            options.choices.bringChanges || plainFolder ? options.choices.ignoredPaths.length : 0,
          ...(plainFolder ? { ignoredFileNoun: ".env file" } : {}),
          copySettings: options.choices.copySettings,
          setupCommand: runSetup ? command : null,
          followUp: followUpEnabled,
        });
  const toggleOptions = () => {
    const next = !optionsOpen;
    setOptionsOpen(next);
    if (next) {
      // Brings the unfolded options into view once they rendered.
      globalThis.requestAnimationFrame(() =>
        optionsRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      );
    }
  };
  const tag = copyFolderTag(suggestion);
  const shownPath =
    suggestion !== null
      ? displayProjectPath(suggestion.path, destination.hints?.homeDirectory)
      : null;
  const note = copyFolderNote({
    suggestion: checking ? null : suggestion,
    manual: manualPath !== null || exactPath !== null,
    remembered: parentFolder.remembered,
    sourceLabel,
    targetLabel,
    targetHome: destination.hints?.homeDirectory ?? null,
    projectTitle: title,
  });
  return (
    <>
      {header}
      <div
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-5 pt-1 pb-4"
        data-testid="copy-project-form"
      >
        {props.notice ? (
          <p className="m-0 rounded-lg bg-muted px-2.5 py-2 text-[12px] text-muted-foreground">
            {props.notice}
          </p>
        ) : null}
        {pin !== null && !props.notice ? (
          <div
            className="flex items-start gap-2 rounded-lg bg-muted px-2.5 py-2 text-[12px] text-muted-foreground"
            data-testid="copy-resume-notice"
          >
            <p className="m-0 min-w-0 flex-1">{copyResumeNotice(resumeLabel)}</p>
            <Button
              size="xs"
              variant="ghost"
              disabled={starting}
              data-testid="copy-resume-discard"
              onClick={() => {
                discardProjectCopy(pin.record.copyId);
                setResumeRecord(null);
                setStartError(null);
              }}
            >
              Discard and start over
            </Button>
          </div>
        ) : null}
        <CopyField label="From" labelId={ids.from}>
          <SourceList
            rows={sourceRows}
            metaByKey={metaByKey}
            value={sourceRow?.key ?? null}
            onChange={(key) => {
              setPickedSourceKey(key);
              setChoices(DEFAULT_COPY_USER_CHOICES);
            }}
            labelledBy={ids.from}
          />
        </CopyField>
        <CopyField label="To" labelId={ids.to}>
          <TargetCards
            cards={destinationCards}
            value={targetId}
            checkingLabel={checking ? `Checking ${targetLabel}…` : null}
            onChange={(next) => {
              setPickedTargetId(next);
              setPickerOpen(false);
            }}
            labelledBy={ids.to}
          />
          <AlreadyOnLine cards={alreadyOn} />
          {updateOffers}
        </CopyField>
        <CopyField label="How" labelId={ids.how}>
          <MethodChoice
            options={options}
            folder={inspection?.folder ?? null}
            plainFolder={plainFolder}
            mode={mode}
            sourceLabel={sourceLabel}
            targetLabel={targetLabel}
            remoteUrl={remoteUrl ?? options?.modes.clone.remoteUrl ?? null}
            remoteCheck={
              remoteUrl === null
                ? null
                : remoteAccess.isFetching
                  ? "checking"
                  : remoteAccess.data === null
                    ? null
                    : remoteAccess.data
            }
            linkPath={suggestion?.status === "link" ? (shownPath ?? "") : null}
            title={title}
            labelledBy={ids.how}
            onChange={(next) => setChoices((current) => ({ ...current, mode: next }))}
          />
        </CopyField>
        <CopyField label={`Folder on ${targetLabel}`} labelId={ids.folder}>
          <div className="flex items-center gap-2 rounded-[9px] border border-border bg-foreground/[0.03] py-1.5 ps-2.5 pe-1.5">
            <FolderIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
            <span
              className="min-w-0 flex-1 truncate font-mono text-[12px]"
              data-testid="copy-destination-path"
              title={suggestion?.path}
            >
              {checking || shownPath === null ? (
                <span className="inline-flex items-center gap-1.5 font-sans text-muted-foreground">
                  <CopyRingSpinner className="size-3" />
                  Checking {targetLabel}…
                </span>
              ) : (
                shownPath
              )}
            </span>
            {tag && !checking ? (
              <span
                data-testid="copy-destination-tag"
                className={cn(
                  "whitespace-nowrap rounded-full bg-muted px-1.5 py-px font-medium text-[10.5px] text-muted-foreground",
                  tag.tone === "warning" && "text-warning",
                  tag.tone === "info" && "bg-primary/12 text-foreground dark:bg-primary/20",
                )}
              >
                {tag.text}
              </span>
            ) : null}
            <Button
              size="xs"
              variant="outline"
              disabled={targetSupport !== "yes" || destination.hints === null || exactPath !== null}
              aria-expanded={pickerOpen}
              onClick={() => setPickerOpen((open) => !open)}
            >
              {pickerOpen ? "Done" : "Change…"}
            </Button>
          </div>
          {pickerOpen && targetId && targetNode && destination.leaf ? (
            <FolderPicker
              environmentId={targetId}
              nodeLabel={targetLabel}
              platformOs={targetNode.platformOs}
              supportsProjectCopy={targetSupport === "yes"}
              mode="parent"
              childName={destination.leaf}
              value={
                manualPath ??
                (suggestion ? parentOfNodePath(suggestion.takenPath ?? suggestion.path) : null)
              }
              initialDirectory={
                manualPath ??
                (suggestion ? parentOfNodePath(suggestion.takenPath ?? suggestion.path) : null)
              }
              expectedRepositoryCanonicalKey={inspection?.repository.canonicalKey ?? null}
              onValueChange={(path) => setManualParent({ targetId, path })}
              onSubmit={() => setPickerOpen(false)}
            />
          ) : (
            <span
              data-testid="copy-folder-note"
              className={cn(
                "text-[11.5px] text-muted-foreground",
                note.tone === "negative" && "text-destructive-foreground",
              )}
            >
              <CopySegments segments={note.segments} />
            </span>
          )}
        </CopyField>
        {optionsOpen ? (
          <CopyField label="Options" labelId={ids.options}>
            <div
              ref={optionsRef}
              id={ids.optionsPanel}
              className="flex flex-col"
              role="group"
              aria-labelledby={ids.options}
            >
              <CopyOptions
                options={options}
                mode={mode}
                inspection={inspection}
                plainFolder={plainFolder}
                relayedLabels={[
                  ...(source.facts?.kind === "inspected" && source.facts.transport === "relay"
                    ? [sourceLabel]
                    : []),
                  ...(targetFacts.transport === "relay" ? [targetLabel] : []),
                ]}
                choices={choices}
                onChoices={setChoices}
              />
              <CheckRow
                testId="copy-option-setup"
                checked={runSetup}
                onChange={setSetupEnabled}
                hint={
                  runSetup ? (
                    <span className="flex flex-col gap-1 pt-1">
                      <Textarea
                        aria-label="Setup command"
                        size="sm"
                        spellCheck={false}
                        maxLength={PROJECT_COPY_SETUP_COMMAND_MAX_CHARS}
                        value={command}
                        placeholder="e.g. bun install --frozen-lockfile"
                        onChange={(event) => setSetupCommand(event.target.value)}
                        className="font-mono text-[12px] sm:text-[12px]"
                      />
                      {options?.setup.osNote ? (
                        <span className="flex items-center gap-1.5 text-warning">
                          <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
                          {options.setup.osNote}
                        </span>
                      ) : null}
                    </span>
                  ) : null
                }
              >
                Run setup afterwards
                {!runSetup && prefill ? (
                  <>
                    :{" "}
                    <code className="rounded bg-muted px-1 font-mono text-[11.5px]">{prefill}</code>
                  </>
                ) : null}
              </CheckRow>
              <CheckRow
                testId="copy-option-agent"
                checked={followUpEnabled}
                onChange={setFollowUpEnabled}
                disabled={followUpDefaults.modelSelection === null && !followUpEnabled}
                hint={
                  followUpEnabled ? (
                    <FollowUpFields
                      config={targetConfig}
                      targetLabel={targetLabel}
                      prompt={prompt}
                      modelSelection={modelSelection}
                      unavailableReason={followUpDefaults.unavailableReason}
                      onPrompt={setFollowUpPrompt}
                      onModel={(selection) => setFollowUpModel({ targetId, selection })}
                    />
                  ) : followUpDefaults.modelSelection === null ? (
                    target.loading ? (
                      `Checking the agents on ${targetLabel}…`
                    ) : (
                      followUpDefaults.unavailableReason
                    )
                  ) : null
                }
              >
                Ask an agent to finish setup
              </CheckRow>
            </div>
          </CopyField>
        ) : null}
        {!optionsOpen && runSetup && options?.setup.osNote ? (
          // The setup runs code on the destination: its warning stays in sight while folded.
          <span
            className="flex items-center gap-1.5 text-[11.5px] text-warning"
            data-testid="copy-setup-os-note"
          >
            <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
            {options.setup.osNote}
          </span>
        ) : null}
        {options?.notes.map((line) => (
          <span key={line} className="text-[11.5px] text-muted-foreground">
            {line}
          </span>
        ))}
      </div>
      <div className="flex shrink-0 items-center gap-2 border-border border-t bg-muted/30 px-5 py-3">
        <span className="flex min-w-0 flex-1 items-center gap-1">
          <span
            className={cn(
              // Two lines before it cuts: the summary is what the copy brings.
              "line-clamp-2 min-w-0 text-[12px] text-muted-foreground leading-[1.35]",
              (startError ?? blockedReason) && !checking && "text-warning",
            )}
            data-testid="copy-footer-summary"
            title={
              startError ??
              blockedReason ??
              (optionsSummary ? copySegmentsText(optionsSummary) : undefined)
            }
          >
            {startError ??
              blockedReason ??
              (optionsSummary ? <CopySegments segments={optionsSummary} /> : null)}
          </span>
          {options !== null ? (
            <Button
              size="xs"
              variant="ghost"
              className="shrink-0 px-1.5 text-[12px]"
              aria-expanded={optionsOpen}
              aria-controls={optionsOpen ? ids.optionsPanel : undefined}
              aria-label={optionsOpen ? "Hide the options" : "Edit the options"}
              data-testid="copy-options-toggle"
              onClick={toggleOptions}
            >
              {optionsOpen ? "Hide" : "Edit"}
            </Button>
          ) : null}
        </span>
        <Button size="sm" variant="outline" onClick={props.onClose}>
          Cancel
        </Button>
        <Button size="sm" disabled={!canStart} onClick={() => void start()}>
          {mode === "link" ? (
            <>
              <LinkIcon aria-hidden className="size-3.5" />
              Link existing checkout
            </>
          ) : (
            <>
              <CopyIcon aria-hidden className="size-3.5" />
              Copy to {targetLabel}
            </>
          )}
        </Button>
      </div>
    </>
  );
}

/* ───────── How ───────── */

function MethodChoice(props: {
  readonly options: ProjectCopyOptionsPlan | null;
  /** The source is not a git repository: its files are all a copy can send. */
  readonly plainFolder: boolean;
  readonly folder: ProjectExportFolder | null;
  readonly mode: "clone" | "send-files" | "link";
  readonly sourceLabel: string;
  readonly targetLabel: string;
  readonly remoteUrl: string | null;
  readonly remoteCheck:
    | "checking"
    | { readonly reachable: boolean; readonly detail: string | null }
    | null;
  readonly linkPath: string | null;
  readonly title: string;
  readonly labelledBy: string;
  readonly onChange: (mode: "clone" | "send-files") => void;
}) {
  const { options } = props;
  const clone = options?.modes.clone;
  const sendFiles = options?.modes.sendFiles;
  const group = rovingRadioGroup<string>({
    options: [
      { value: "clone", disabled: !clone?.available },
      { value: "send-files", disabled: !sendFiles?.available },
    ],
    value: props.mode === "link" ? null : props.mode,
    onChange: (value) => props.onChange(value as "clone" | "send-files"),
  });
  if (props.plainFolder) {
    return (
      <PlainFolderMethod
        available={sendFiles?.available === true}
        reason={sendFiles?.reason ?? null}
        folder={props.folder}
        sourceLabel={props.sourceLabel}
        title={props.title}
      />
    );
  }
  if (props.mode === "link") {
    return (
      <div
        className="flex items-start gap-[9px] rounded-[9px] border border-primary p-2.5 text-[12px] shadow-[0_0_0_1px_var(--primary)]"
        data-testid="copy-method-link"
      >
        <LinkIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <span className="min-w-0">
          <span className="mb-0.5 block font-medium text-[12.5px]">
            Link the checkout that’s there
          </span>
          <span className="block text-[11.5px] text-muted-foreground">
            <span className="font-mono">{props.linkPath}</span> is already a checkout of{" "}
            {props.title}; Ryco adds it as a project without copying.
          </span>
        </span>
      </div>
    );
  }
  const noRemote = clone !== undefined && clone.remoteUrl === null;
  const sizeBytes = (sendFiles?.estimatedBytes ?? 0) + (options?.bringChanges.estimatedBytes ?? 0);
  return (
    <div
      role="radiogroup"
      aria-labelledby={props.labelledBy}
      onKeyDown={group.onKeyDown}
      className="grid grid-cols-1 gap-1.5 sm:grid-cols-2"
    >
      <MethodCard
        radio={group.radio("clone")}
        selected={props.mode === "clone"}
        disabled={!clone?.available}
        icon={<GitCommitHorizontalIcon aria-hidden className="size-[13px]" />}
        title="Clone from origin"
        recommended={clone?.available === true && options?.defaultMode === "clone"}
      >
        {noRemote ? (
          "No remote set up for this project."
        ) : clone && !clone.available ? (
          clone.reason
        ) : (
          <>
            {props.remoteUrl ? displayRemoteUrl(props.remoteUrl) : "The project's remote"} · full
            history. {props.targetLabel} needs Git access.
            {props.remoteCheck === "checking" ? (
              <span className="mt-1 flex items-center gap-1.5" data-testid="copy-remote-check">
                <CopyRingSpinner className="size-3" />
                Checking access from {props.targetLabel}…
              </span>
            ) : props.remoteCheck?.reachable === true ? (
              <span className="mt-1 block text-success" data-testid="copy-remote-check">
                {props.targetLabel} can reach it.
              </span>
            ) : props.remoteCheck?.reachable === false ? (
              <span className="mt-1 block text-warning" data-testid="copy-remote-check">
                {props.targetLabel} can’t reach it
                {props.remoteCheck.detail ? `: ${props.remoteCheck.detail}` : "."}
              </span>
            ) : null}
          </>
        )}
      </MethodCard>
      <MethodCard
        radio={group.radio("send-files")}
        selected={props.mode === "send-files"}
        disabled={!sendFiles?.available}
        icon={<ArrowRightLeftIcon aria-hidden className="size-[13px]" />}
        title={`Send files from ${props.sourceLabel}`}
        recommended={sendFiles?.available === true && options?.defaultMode === "send-files"}
      >
        {sendFiles && !sendFiles.available
          ? sendFiles.reason
          : `Node to node, including uncommitted work · ${formatCopyMegabytes(sizeBytes)}, skips ignored files like node_modules.`}
      </MethodCard>
    </div>
  );
}

/** The one way a plain folder travels: its files, node to node. */
function PlainFolderMethod(props: {
  readonly available: boolean;
  readonly reason: string | null;
  readonly folder: ProjectExportFolder | null;
  readonly sourceLabel: string;
  readonly title: string;
}) {
  const { folder } = props;
  const leftOut = folder ? folderLeftOutText(folder.leftOut) : null;
  return (
    <div
      className={cn(
        "flex items-start gap-[9px] rounded-[9px] border p-2.5 text-[12px]",
        props.available
          ? "border-primary shadow-[0_0_0_1px_var(--primary)]"
          : "border-border text-muted-foreground",
      )}
      data-testid="copy-method-folder"
    >
      <FolderIcon aria-hidden className="mt-0.5 size-3.5 shrink-0" />
      <span className="min-w-0">
        <span className="mb-0.5 block font-medium text-[12.5px]">
          Send the files from {props.sourceLabel}
        </span>
        <span className="block text-[11.5px] text-muted-foreground">
          {props.title} is a plain folder, not a git repository, so its files are sent node to node
          {folder && props.available
            ? ` · ${plural(folder.fileCount, "file")}, ${formatCopyMegabytes(folder.totalBytes)}.`
            : "."}
          {leftOut ? ` ${leftOut}` : null}
        </span>
        {!props.available && props.reason ? (
          <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-warning">
            <TriangleAlertIcon aria-hidden className="size-3 shrink-0" />
            {props.reason}
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** "Leaves out node_modules and .venv: …" for the left-out folders a walk found. */
function folderLeftOutText(leftOut: ReadonlyArray<string>): string | null {
  const names = [...new Set(leftOut.map((entry) => entry.slice(entry.lastIndexOf("/") + 1)))];
  if (names.length === 0) return null;
  const shown = names.slice(0, 3);
  const more = names.length - shown.length;
  return `Leaves out ${shown.join(", ")}${more > 0 ? ` and ${more} more` : ""}: setup recreates them.`;
}

/* ───────── Options ───────── */

function CopyOptions(props: {
  readonly options: ProjectCopyOptionsPlan | null;
  readonly mode: "clone" | "send-files" | "link";
  readonly inspection:
    | Extract<
        NonNullable<ReturnType<typeof useCopySource>["facts"]>,
        { kind: "inspected" }
      >["inspection"]
    | null;
  readonly plainFolder: boolean;
  /** The copy's nodes reached through the Hub: either one leaves ignored files out (A33). */
  readonly relayedLabels: ReadonlyArray<string>;
  readonly choices: CopyUserChoices;
  readonly onChoices: (update: (current: CopyUserChoices) => CopyUserChoices) => void;
}) {
  const { options, inspection, mode } = props;
  if (options === null) return null;
  const set = (patch: Partial<CopyUserChoices>) =>
    props.onChoices((current) => ({ ...current, ...patch }));
  const rows: ReactNode[] = [];
  const optInPicker = (lead: string) => (
    <OptInFiles
      key="ignored"
      lead={lead}
      nested={!props.plainFolder}
      options={options}
      relayedLabels={props.relayedLabels}
      onChoices={props.onChoices}
    />
  );
  if (props.plainFolder) {
    // A plain folder has no commits or changes: only the files named like secrets to pick.
    if (options.ignoredCandidates.length > 0) {
      rows.push(optInPicker("Also send these files (they're never copied unless you pick them):"));
    }
  } else if (mode !== "link") {
    const unpushed = options.bringCommits.unpushedCommitCount;
    const changeCount = inspection
      ? inspection.workingTree.trackedChangeCount + inspection.workingTree.untrackedCount
      : 0;
    if (inspection === null) {
      // A source without project copy (A23): only a clone from origin.
      rows.push(
        <CheckRow key="commits" checked={false} disabled hint={options.bringCommits.reason}>
          Bring unpushed commits
        </CheckRow>,
        <CheckRow key="changes" checked={false} disabled hint={options.bringChanges.reason}>
          Bring uncommitted changes
        </CheckRow>,
      );
    } else {
      if (unpushed > 0) {
        rows.push(
          mode === "send-files" ? (
            <CheckRow key="commits" testId="copy-option-commits" checked disabled>
              {plural(unpushed, "unpushed commit")} come with the files
            </CheckRow>
          ) : (
            <CheckRow
              key="commits"
              testId="copy-option-commits"
              checked={options.choices.bringCommits}
              disabled={!options.bringCommits.available || options.bringCommits.forced}
              onChange={(next) => set({ bringCommits: next })}
              hint={
                options.bringCommits.forced
                  ? "The uncommitted changes need them: the remote doesn't have the commit they're on."
                  : options.bringCommits.available
                    ? null
                    : options.bringCommits.reason
              }
            >
              Bring the {plural(unpushed, "unpushed commit")} along
            </CheckRow>
          ),
        );
      }
      if (changeCount > 0) {
        const changesLabel = plural(changeCount, "uncommitted change");
        rows.push(
          mode === "send-files" && options.bringChanges.available ? (
            <CheckRow key="changes" testId="copy-option-changes" checked disabled>
              {changesLabel} come with the files
            </CheckRow>
          ) : (
            <CheckRow
              key="changes"
              testId="copy-option-changes"
              checked={options.choices.bringChanges}
              disabled={!options.bringChanges.available}
              onChange={(next) => set({ bringChanges: next })}
              hint={options.bringChanges.available ? null : options.bringChanges.reason}
            >
              Bring the {changesLabel} along
            </CheckRow>
          ),
        );
        if (options.choices.bringChanges && options.ignoredCandidates.length > 0) {
          rows.push(
            optInPicker("Also bring ignored files (they're never copied unless you pick them):"),
          );
        }
      }
    }
  }
  rows.push(
    <CheckRow
      key="settings"
      testId="copy-option-settings"
      checked={options.choices.copySettings}
      disabled={!options.copySettings.available}
      onChange={(next) => set({ copySettings: next })}
      hint={
        options.choices.copySettings && options.copyAvatar.reason ? options.copyAvatar.reason : null
      }
    >
      Copy project settings: scripts, avatar, system prompt, overrides
    </CheckRow>,
  );
  return <>{rows}</>;
}

/** The opt-in files (`.env`, …): picked one by one, sent only over an encrypted connection. */
function OptInFiles(props: {
  readonly lead: string;
  /** Under the "Bring the changes" row it belongs to, indented like its hint. */
  readonly nested: boolean;
  readonly options: ProjectCopyOptionsPlan;
  readonly relayedLabels: ReadonlyArray<string>;
  readonly onChoices: (update: (current: CopyUserChoices) => CopyUserChoices) => void;
}) {
  const { options } = props;
  return (
    <div
      className={cn(
        "flex flex-col rounded-lg border border-border px-2 py-1",
        props.nested && "ms-[27px]",
      )}
      data-testid="copy-ignored-files"
    >
      <span className="py-1 text-[11.5px] text-muted-foreground">{props.lead}</span>
      {options.ignoredCandidates.map((candidate) => (
        <CheckRow
          key={candidate.path}
          checked={options.choices.ignoredPaths.includes(candidate.path)}
          onChange={(next) =>
            props.onChoices((current) => ({
              ...current,
              ignoredPaths: next
                ? [...current.ignoredPaths, candidate.path]
                : current.ignoredPaths.filter((path) => path !== candidate.path),
            }))
          }
        >
          <span className="font-mono text-[11.5px]">{candidate.path}</span>{" "}
          <span className="text-muted-foreground">({formatFileSize(candidate.byteLength)})</span>
        </CheckRow>
      ))}
      {props.relayedLabels.length > 0 ? (
        <span className="py-1 text-[11.5px] text-warning" data-testid="copy-insecure-note">
          {props.relayedLabels.length === 1
            ? `${props.relayedLabels[0]} is reached through the Hub. If that connection isn't`
            : `${props.relayedLabels.join(" and ")} are reached through the Hub. If those connections aren't`}{" "}
          end-to-end encrypted, these files are left out: they are only sent over an encrypted
          connection.
        </span>
      ) : (
        <span
          className="py-1 text-[11.5px] text-muted-foreground"
          data-testid="copy-encryption-note"
        >
          These files are only sent over an encrypted connection (HTTPS, Tailscale or this
          computer). Over an unencrypted one they are left out.
        </span>
      )}
    </div>
  );
}

/* ───────── Setup agent ───────── */

function FollowUpFields(props: {
  readonly config: ServerConfig | null;
  readonly targetLabel: string;
  readonly prompt: string;
  readonly modelSelection: ModelSelection | null;
  readonly unavailableReason: string | null;
  readonly onPrompt: (prompt: string) => void;
  readonly onModel: (selection: ModelSelection) => void;
}) {
  const { config, modelSelection } = props;
  const entries = useMemo(
    () => sortProviderInstanceEntries(deriveProviderInstanceEntries(config?.providers ?? [])),
    [config?.providers],
  );
  const modelOptionsByInstance = useMemo(
    () =>
      config
        ? getCustomModelOptionsByInstance(
            { ...DEFAULT_UNIFIED_SETTINGS, ...config.settings },
            config.providers,
          )
        : new Map(),
    [config],
  );
  return (
    <span className="flex flex-col gap-1.5 pt-1">
      <Textarea
        aria-label="What the agent should do"
        size="sm"
        value={props.prompt}
        onChange={(event) => props.onPrompt(event.target.value)}
        className="text-[12px] sm:text-[12px]"
      />
      <span className="flex flex-wrap items-center gap-2">
        <span>Model on {props.targetLabel}</span>
        {config && modelSelection ? (
          <ProviderModelPicker
            activeInstanceId={modelSelection.instanceId}
            model={modelSelection.model}
            modelOptions={modelSelection.options}
            lockedProvider={null}
            instanceEntries={entries}
            modelOptionsByInstance={modelOptionsByInstance}
            triggerVariant="outline"
            triggerSize="xs"
            onInstanceModelChange={(instanceId, model, modelOptions) =>
              props.onModel(createModelSelection(instanceId, model, modelOptions))
            }
          />
        ) : (
          <span className="text-warning">{props.unavailableReason ?? "Loading…"}</span>
        )}
      </span>
    </span>
  );
}
