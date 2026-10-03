import {
  CopyIcon,
  ExternalLinkIcon,
  FileDiffIcon,
  MoreHorizontalIcon,
  RefreshCwIcon,
} from "lucide-react";
import { memo } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { openExternalLink } from "../../../lib/openExternalLink";
import { cn } from "../../../lib/utils";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../../ui/menu";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { ActorAvatar, CHECKS_OVERALL_LABEL, CheckStateGlyph, RelativeTime } from "../primitives";
import { ROW_HOVER_REVEAL_CLASS, ROW_ICON_BUTTON_CLASS } from "../checks/checksUi";
import type { CommitListCommit, CommitListForcePush } from "./commitsModel";

/**
 * One commit: checks glyph, headline, author, short sha (click copies), time.
 * The row itself scopes Files to the commit; a force-push sits in sequence as
 * a muted line between the commits it replaced and the ones it brought.
 */

const TIME_CLASS = "w-9 shrink-0 text-right text-xs text-muted-foreground";

function useCopySha() {
  const { copyToClipboard } = useCopyToClipboard<void>({
    onCopy: () =>
      toastManager.add(stackedThreadToast({ type: "success", title: "Copied SHA", timeout: 1600 })),
  });
  return copyToClipboard;
}

function isoOrNull(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

export const CommitRow = memo(function CommitRow(props: {
  readonly commit: CommitListCommit;
  /** Files is currently scoped to this commit. */
  readonly scoped: boolean;
  /** Pull request URL on the host; commit links hang off it. */
  readonly pullRequestUrl: string | null;
  readonly onScope: (oid: string) => void;
}) {
  const { commit } = props;
  const copySha = useCopySha();
  const overall = commit.checks ?? "none";
  const commitUrl = props.pullRequestUrl ? `${props.pullRequestUrl}/commits/${commit.oid}` : null;
  return (
    <li data-commit-oid={commit.oid} className="border-b border-border/60">
      <div
        className={cn(
          "group/row relative flex h-10 items-center gap-2.5 rounded-md pr-1 pl-1 transition-colors duration-(--app-motion-duration-chip)",
          props.scoped ? "bg-accent/70" : "hover:bg-foreground/[0.025]",
        )}
      >
        <button
          type="button"
          aria-current={props.scoped || undefined}
          title={`Show the changes in ${commit.shortOid}`}
          onClick={() => props.onScope(commit.oid)}
          className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch text-left outline-hidden before:absolute before:inset-0 before:rounded-md focus-visible:before:ring-2 focus-visible:before:ring-ring focus-visible:before:ring-inset"
        >
          <CheckStateGlyph
            overall={overall}
            label={commit.checks ? CHECKS_OVERALL_LABEL[commit.checks] : "No checks reported"}
          />
          <span className="min-w-0 truncate text-[13px] text-foreground">
            {commit.headline || "(no message)"}
          </span>
        </button>
        {commit.author ? (
          <span className="relative flex min-w-0 shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
            <ActorAvatar
              login={commit.author}
              avatarUrl={commit.avatarUrl ?? undefined}
              size={16}
            />
            <span className="max-w-32 truncate @max-[36rem]/reader:hidden">{commit.author}</span>
          </span>
        ) : null}
        <button
          type="button"
          title="Copy SHA"
          aria-label={`Copy SHA ${commit.shortOid}`}
          onClick={() => copySha(commit.oid)}
          className="relative shrink-0 rounded-[4px] px-1 font-mono text-[11px] text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          {commit.shortOid}
        </button>
        <RelativeTime value={isoOrNull(commit.atMs)} className={TIME_CLASS} />
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                aria-label={`${commit.shortOid} actions`}
                className={cn(ROW_ICON_BUTTON_CLASS, ROW_HOVER_REVEAL_CLASS)}
              >
                <MoreHorizontalIcon className="size-3.5" />
              </button>
            }
          />
          <MenuPopup align="end" className="min-w-48">
            <MenuItem onClick={() => props.onScope(commit.oid)}>
              <FileDiffIcon aria-hidden />
              Show changes
            </MenuItem>
            <MenuItem onClick={() => copySha(commit.oid)}>
              <CopyIcon aria-hidden />
              Copy SHA
            </MenuItem>
            {commitUrl ? (
              <MenuItem onClick={() => openExternalLink(commitUrl, "Couldn't open the commit")}>
                <ExternalLinkIcon aria-hidden />
                Open on GitHub
              </MenuItem>
            ) : null}
          </MenuPopup>
        </Menu>
      </div>
    </li>
  );
});

function Sha(props: { readonly oid: string | null }) {
  return (
    <code className="font-mono text-[11px] text-foreground/75">
      {props.oid ? props.oid.slice(0, 7) : "unknown"}
    </code>
  );
}

/** "sak0a force-pushed e8d2c47 → 19be4f7": history was rewritten here. */
export const ForcePushMarker = memo(function ForcePushMarker(props: {
  readonly push: CommitListForcePush;
}) {
  const { push } = props;
  return (
    <li className="border-b border-border/60">
      <div className="flex h-9 items-center gap-2.5 pr-1 pl-1 text-xs text-muted-foreground">
        <RefreshCwIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground/70" />
        <span className="min-w-0 flex-1 truncate">
          {push.actor ? <span className="text-foreground/80">{push.actor}</span> : "Someone"}{" "}
          force-pushed <Sha oid={push.beforeOid} /> <span aria-hidden>→</span>
          <span className="sr-only">to</span> <Sha oid={push.afterOid} />
        </span>
        <RelativeTime value={isoOrNull(push.atMs)} className={TIME_CLASS} />
        <span aria-hidden className="size-6 shrink-0" />
      </div>
    </li>
  );
});
