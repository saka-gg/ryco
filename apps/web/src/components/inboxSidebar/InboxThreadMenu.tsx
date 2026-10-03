import { scopeThreadRef } from "@ryco/client-runtime/scoped";
import {
  AlarmClockOffIcon,
  ArchiveIcon,
  CheckIcon,
  CircleDotIcon,
  ClockIcon,
  Columns2Icon,
  CopyIcon,
  ExternalLinkIcon,
  GitPullRequestIcon,
  FolderIcon,
  GitForkIcon,
  HashIcon,
  type LucideIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  Settings2Icon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import type { ThreadMenuActionId } from "../sidebar/hooks/useThreadMenuActions";
import {
  MenuItem,
  MenuSeparator,
  MenuShortcut,
  MenuSub,
  MenuSubPopup,
  MenuSubTrigger,
} from "../ui/menu";
import type { InboxPullRequest } from "./inboxPullRequests";
import { formatInboxDayTime } from "./inboxRowPresentation";
import type { InboxSidebarRow } from "./inboxSidebarModel";
import type { InboxThreadActions } from "./InboxThreadRow";

/**
 * Presentation for the shared thread action inventory: an icon and a group
 * per action. The inventory itself (labels, availability, handlers) stays in
 * useThreadMenuActions, shared with the phone sheet and the project sidebar.
 */
const ACTION_PRESENTATION: Record<
  ThreadMenuActionId,
  { readonly icon: LucideIcon; readonly group: "organize" | "copy" | "remove" }
> = {
  "open-in-split": { icon: Columns2Icon, group: "organize" },
  pin: { icon: PinIcon, group: "organize" },
  unpin: { icon: PinOffIcon, group: "organize" },
  rename: { icon: PencilIcon, group: "organize" },
  "mark-unread": { icon: CircleDotIcon, group: "organize" },
  "project-settings": { icon: Settings2Icon, group: "copy" },
  "copy-project-path": { icon: FolderIcon, group: "copy" },
  "copy-worktree-path": { icon: GitForkIcon, group: "copy" },
  "copy-path": { icon: CopyIcon, group: "copy" },
  "copy-thread-id": { icon: HashIcon, group: "copy" },
  archive: { icon: ArchiveIcon, group: "remove" },
  close: { icon: Trash2Icon, group: "remove" },
};

const MUTATING_ACTIONS: ReadonlySet<ThreadMenuActionId> = new Set(["rename", "archive", "close"]);

export interface InboxSnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly snoozedUntil: string;
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
  readonly onSettle: () => void;
  readonly onSnooze: (snoozedUntil: string | null) => void;
  readonly onOpenPullRequest: (url: string) => void;
  /** Opens the change request on the pull requests page. */
  readonly onReviewPullRequest?: (() => void) | undefined;
}) {
  const { row } = props;
  const actions = props.threadActions?.listThreadMenuActions(row.key) ?? [];
  const actionItem = (item: (typeof actions)[number]) => {
    const presentation = ACTION_PRESENTATION[item.id];
    // "close" ends a session ("Close session") or deletes a plain thread.
    const Icon = item.id === "close" && item.label.startsWith("Close") ? XIcon : presentation.icon;
    return (
      <MenuItem
        key={item.id}
        variant={item.destructive ? "destructive" : "default"}
        disabled={!row.mutationEnabled && MUTATING_ACTIONS.has(item.id)}
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
  const inGroup = (group: "organize" | "copy" | "remove") =>
    actions.filter((item) => ACTION_PRESENTATION[item.id].group === group).map(actionItem);
  const pullRequestUrl = props.pullRequest?.url;

  const groups: ReadonlyArray<readonly [key: string, items: ReactNode[]]> = [
    ["organize", inGroup("organize")],
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
              {props.snoozePresets.map((preset) => (
                <MenuItem key={preset.id} onClick={() => props.onSnooze(preset.snoozedUntil)}>
                  {preset.label}
                  <MenuShortcut className="tracking-normal">
                    {formatInboxDayTime(preset.snoozedUntil)}
                  </MenuShortcut>
                </MenuItem>
              ))}
            </MenuSubPopup>
          </MenuSub>
        ),
        <MenuItem key="settle" disabled={!props.settleEnabled} onClick={props.onSettle}>
          {row.settled ? <Undo2Icon aria-hidden /> : <CheckIcon aria-hidden />}
          {props.settleLabel}
        </MenuItem>,
      ],
    ],
    ["copy", inGroup("copy")],
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
