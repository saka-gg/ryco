import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  AlarmClockOffIcon,
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  CircleDotIcon,
  CircleStopIcon,
  ClockIcon,
  Columns2Icon,
  CopyIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  FolderGit2Icon,
  FolderIcon,
  FolderInputIcon,
  FolderOpenIcon,
  GitForkIcon,
  HashIcon,
  type LucideIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PowerOffIcon,
  Settings2Icon,
  SquareArrowOutUpRightIcon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { useProjectGroupingSettings } from "../../hooks/useProjectGroupingSettings";
import { deriveLogicalProjectKeyFromSettings } from "../../logicalProject";
import { DeviceIcon } from "../DeviceIcon";
import type {
  ThreadMenuActionId,
  ThreadMenuActionItem,
} from "../sidebar/hooks/useThreadMenuActions";
import {
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import { useInboxFilterStore } from "./inboxFilterStore";
import type { InboxPullRequest } from "./inboxPullRequests";
import { inboxRowFilterActions } from "./inboxRowFilters";
import { formatInboxDayTime } from "./inboxRowPresentation";
import type { InboxSidebarRow } from "./inboxSidebarModel";
import type { InboxThreadActions } from "./InboxThreadRow";
import type { InboxBulkRequest, InboxMenuSelection } from "./useInboxRowSelection";

/**
 * Presentation for the shared thread action inventory: an icon and a group
 * per action. The inventory itself (labels, availability, handlers) stays in
 * useThreadMenuActions, shared with the phone sheet and the project sidebar.
 */
type ActionGroup = "organize" | "session" | "copy" | "workspace" | "remove";

type ActionPresentation = { readonly icon: LucideIcon; readonly group: ActionGroup };

const ACTION_PRESENTATION: Record<
  Exclude<ThreadMenuActionId, `chat-extension:${string}`>,
  ActionPresentation
> = {
  "open-in-split": { icon: Columns2Icon, group: "organize" },
  pin: { icon: PinIcon, group: "organize" },
  unpin: { icon: PinOffIcon, group: "organize" },
  rename: { icon: PencilIcon, group: "organize" },
  "mark-unread": { icon: CircleDotIcon, group: "organize" },
  "interrupt-turn": { icon: CircleStopIcon, group: "session" },
  "stop-session": { icon: PowerOffIcon, group: "session" },
  "project-settings": { icon: Settings2Icon, group: "copy" },
  "copy-project-path": { icon: FolderIcon, group: "copy" },
  "copy-worktree-path": { icon: GitForkIcon, group: "copy" },
  "copy-path": { icon: CopyIcon, group: "copy" },
  "copy-thread-id": { icon: HashIcon, group: "copy" },
  workspace: { icon: FolderGit2Icon, group: "workspace" },
  "workspace:archive": { icon: ArchiveIcon, group: "workspace" },
  "workspace:restore": { icon: ArchiveRestoreIcon, group: "workspace" },
  "workspace:delete-workspace": { icon: Trash2Icon, group: "workspace" },
  "workspace:manage": { icon: Settings2Icon, group: "workspace" },
  archive: { icon: ArchiveIcon, group: "remove" },
  unarchive: { icon: ArchiveRestoreIcon, group: "remove" },
  delete: { icon: Trash2Icon, group: "remove" },
  "discard-draft": { icon: XIcon, group: "remove" },
  "chat-reveal-folder": { icon: FolderOpenIcon, group: "copy" },
  "chat-open-folder-in-editor": { icon: SquareArrowOutUpRightIcon, group: "copy" },
  "chat-copy-folder-path": { icon: FolderIcon, group: "copy" },
};

/** Chat menu extensions ("Turn into project…") sit with the folder actions. */
const CHAT_EXTENSION_PRESENTATION: ActionPresentation = { icon: FolderInputIcon, group: "copy" };

function actionPresentation(id: ThreadMenuActionId): ActionPresentation {
  return id.startsWith("chat-extension:")
    ? CHAT_EXTENSION_PRESENTATION
    : ACTION_PRESENTATION[id as keyof typeof ACTION_PRESENTATION];
}

/** Actions that change server state; disabled when this connection cannot mutate. */
const READ_ONLY_ACTIONS: ReadonlySet<ThreadMenuActionId> = new Set([
  "open-in-split",
  "pin",
  "unpin",
  "mark-unread",
  "project-settings",
  "copy-project-path",
  "copy-worktree-path",
  "copy-path",
  "copy-thread-id",
  "workspace",
  "workspace:manage",
  "discard-draft",
  "chat-reveal-folder",
  "chat-open-folder-in-editor",
  "chat-copy-folder-path",
]);

export interface InboxSnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly snoozedUntil: string;
}

function snoozePresetItems(
  presets: ReadonlyArray<InboxSnoozePreset>,
  onSnooze: (snoozedUntil: string) => void,
): ReactNode[] {
  return presets.map((preset) => (
    <MenuItem key={preset.id} onClick={() => onSnooze(preset.snoozedUntil)}>
      {preset.label}
      <MenuShortcut className="tracking-normal">
        {formatInboxDayTime(preset.snoozedUntil)}
      </MenuShortcut>
    </MenuItem>
  ));
}

/**
 * The menu of a multiple selection. Each count is the rows that action
 * changes, at most 100; an action no selected row allows is disabled.
 */
export function InboxSelectionMenuItems(props: {
  readonly selection: InboxMenuSelection;
  readonly snoozePresets: ReadonlyArray<InboxSnoozePreset>;
  readonly onRun: (request: InboxBulkRequest) => void;
}) {
  // It renders only in an open menu, fresh on each open, so memoizing it would
  // only add code to the shell.
  "use no memo";
  const { rows, actions, deleteThreads } = props.selection;
  const item = (
    action: Exclude<InboxBulkRequest["action"], "snooze">,
    Icon: LucideIcon,
    label: string,
  ) => (
    <MenuItem
      key={action}
      variant={action === "delete" ? "destructive" : "default"}
      disabled={actions[action].length === 0}
      onClick={() => props.onRun({ action })}
    >
      <Icon aria-hidden />
      {`${label} (${actions[action].length})`}
    </MenuItem>
  );
  return [
    item("settle", CheckIcon, "Settle"),
    rows.some((row) => row.settled) ? item("unsettle", Undo2Icon, "Move to Active") : null,
    <MenuSub key="snooze">
      <MenuSubTrigger
        className="[&>svg:first-child]:-mx-0.5 [&>svg]:opacity-80"
        disabled={actions.snooze.length === 0}
      >
        <ClockIcon aria-hidden />
        {`Snooze (${actions.snooze.length})`}
      </MenuSubTrigger>
      <MenuSubPopup className="min-w-52" data-thread-selection-safe>
        {snoozePresetItems(props.snoozePresets, (snoozedUntil) =>
          props.onRun({ action: "snooze", snoozedUntil }),
        )}
      </MenuSubPopup>
    </MenuSub>,
    rows.some((row) => row.snoozedUntil !== null)
      ? item("unsnooze", AlarmClockOffIcon, "Unsnooze")
      : null,
    <MenuSeparator key="separator-unread" />,
    item("markUnread", CircleDotIcon, "Mark unread"),
    ...(deleteThreads
      ? [<MenuSeparator key="separator-delete" />, item("delete", Trash2Icon, "Delete")]
      : []),
  ];
}

export function InboxThreadMenuItems(props: {
  readonly row: InboxSidebarRow;
  readonly threadActions?: InboxThreadActions | undefined;
  readonly pullRequest: InboxPullRequest | null;
  readonly changeRequestShortName: string;
  readonly providerName: string;
  readonly pending: boolean;
  readonly settleLabel: string;
  readonly settleEnabled: boolean;
  readonly snoozePresets: ReadonlyArray<InboxSnoozePreset>;
  /** Off on the frozen phone tier (AGENTS.md). */
  readonly showFilters: boolean;
  readonly onSettle: () => void;
  readonly onSnooze: (snoozedUntil: string | null) => void;
  readonly onOpenPullRequest: (url: string) => void;
  /** Opens the change request on the pull requests page. */
  readonly onReviewPullRequest?: (() => void) | undefined;
}) {
  const { row } = props;
  const projectFilter = useInboxFilterStore((store) => store.project);
  const environmentFilter = useInboxFilterStore((store) => store.environmentId);
  const setProjectFilter = useInboxFilterStore((store) => store.setProject);
  const setEnvironmentFilter = useInboxFilterStore((store) => store.setEnvironmentId);
  const projectGroupingSettings = useProjectGroupingSettings();
  const actions = props.threadActions?.listThreadMenuActions(row.key) ?? [];
  const actionItem = (item: ThreadMenuActionItem): ReactNode => {
    const Icon = actionPresentation(item.id).icon;
    if (item.children) {
      return (
        <MenuSub key={item.id}>
          <MenuSubTrigger className="[&>svg:first-child]:-mx-0.5 [&>svg]:opacity-80">
            <Icon aria-hidden />
            {item.label}
          </MenuSubTrigger>
          <MenuSubPopup className="min-w-52">{item.children.map(actionItem)}</MenuSubPopup>
        </MenuSub>
      );
    }
    return (
      <MenuItem
        key={item.id}
        variant={item.destructive ? "destructive" : "default"}
        disabled={!row.mutationEnabled && !READ_ONLY_ACTIONS.has(item.id)}
        onClick={() =>
          void props.threadActions?.performThreadMenuAction(
            scopeThreadRef(row.environmentId, row.threadId),
            item.id,
          )
        }
      >
        <Icon aria-hidden />
        {item.label}
      </MenuItem>
    );
  };
  const inGroup = (group: ActionGroup) =>
    actions.filter((item) => actionPresentation(item.id).group === group).map(actionItem);
  const pullRequestUrl = props.pullRequest?.url;
  // Logical, so a repository grouped across machines narrows as one project.
  const projectKey = row.project
    ? deriveLogicalProjectKeyFromSettings(row.project, projectGroupingSettings)
    : null;
  const filterActions = props.showFilters
    ? inboxRowFilterActions(row, projectKey, {
        projectKey: projectFilter?.logicalKey ?? null,
        environmentId: environmentFilter,
      })
    : [];

  const groups: ReadonlyArray<readonly [key: string, items: ReactNode[]]> = [
    ["organize", inGroup("organize")],
    [
      "filter",
      filterActions.map((action) => (
        <MenuItem
          key={`filter-${action.kind}`}
          onClick={() =>
            action.kind === "project"
              ? setProjectFilter(action.active ? null : action.project)
              : setEnvironmentFilter(action.active ? null : action.environmentId)
          }
        >
          {action.active ? (
            <XIcon aria-hidden />
          ) : action.kind === "project" ? (
            <FolderIcon aria-hidden />
          ) : (
            <DeviceIcon environmentId={row.environmentId} label={row.machineLabel} />
          )}
          {action.label}
        </MenuItem>
      )),
    ],
    [
      "pull-request",
      [
        ...(props.pullRequest && props.onReviewPullRequest
          ? [
              <MenuItem key="review-pr" onClick={props.onReviewPullRequest}>
                <GitPullRequestIcon aria-hidden />
                {`Review ${props.changeRequestShortName} #${props.pullRequest.number}`}
              </MenuItem>,
            ]
          : []),
        ...(pullRequestUrl
          ? [
              <MenuItem key="open-pr" onClick={() => props.onOpenPullRequest(pullRequestUrl)}>
                <ExternalLinkIcon aria-hidden />
                {`Open ${props.changeRequestShortName} #${props.pullRequest!.number}`}
                <MenuShortcut className="tracking-normal">{props.providerName}</MenuShortcut>
              </MenuItem>,
            ]
          : []),
      ],
    ],
    [
      "lifecycle",
      [
        row.snoozedUntil ? (
          <MenuItem
            key="unsnooze"
            disabled={!row.canUnsnooze || props.pending}
            onClick={() => props.onSnooze(null)}
          >
            <AlarmClockOffIcon aria-hidden />
            Unsnooze
          </MenuItem>
        ) : (
          <MenuSub key="snooze">
            <MenuSubTrigger
              className="[&>svg:first-child]:-mx-0.5 [&>svg]:opacity-80"
              disabled={!row.canSnooze || props.pending}
            >
              <ClockIcon aria-hidden />
              Snooze
            </MenuSubTrigger>
            <MenuSubPopup className="min-w-52">
              {snoozePresetItems(props.snoozePresets, props.onSnooze)}
            </MenuSubPopup>
          </MenuSub>
        ),
        <MenuItem key="settle" disabled={!props.settleEnabled} onClick={props.onSettle}>
          {row.settled ? <Undo2Icon aria-hidden /> : <CheckIcon aria-hidden />}
          {props.settleLabel}
        </MenuItem>,
      ],
    ],
    ["session", inGroup("session")],
    ["copy", inGroup("copy")],
    ["workspace", inGroup("workspace")],
    ["remove", inGroup("remove")],
  ];
  const rendered: ReactNode[] = [];
  for (const [key, items] of groups) {
    if (items.length === 0) continue;
    if (rendered.length > 0) rendered.push(<MenuSeparator key={`separator-${key}`} />);
    rendered.push(...items);
  }
  return rendered;
}
