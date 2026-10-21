import { CheckIcon, CopyIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useCopyToClipboard } from "../../hooks/useCopyToClipboard";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { UpdateDeviceCardView, UpdateDotTone } from "./updateEverything.logic";

const DOT_CLASS: Readonly<Record<UpdateDotTone, string>> = {
  muted: "bg-muted-foreground",
  success: "bg-success",
  primary: "bg-primary",
  warning: "bg-warning",
  error: "bg-destructive",
};

const STATUS_TEXT_CLASS: Readonly<Record<UpdateDotTone, string>> = {
  muted: "text-muted-foreground",
  success: "text-success",
  primary: "text-primary",
  warning: "text-warning",
  error: "text-destructive",
};

/** `from → to`, read aloud as "from to to". */
function VersionChange({
  from,
  to,
  emphasize,
  className,
}: {
  from: string | null;
  to: string | null;
  emphasize: boolean;
  className?: string;
}) {
  return (
    <span className={cn("shrink-0 font-mono text-muted-foreground", className)}>
      {from === null ? null : (
        <>
          {from}
          <span aria-hidden> → </span>
          <span className="sr-only"> to </span>
        </>
      )}
      <span className={emphasize ? "text-success" : undefined}>{to ?? "newer release"}</span>
    </span>
  );
}

/** A command someone has to run by hand, with a copy button. */
export function CopyableCommand({ command }: { command: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({
    onError: (error) => {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not copy the command",
          description: error.message,
        }),
      );
    },
  });
  return (
    <span className="inline-flex min-w-0 max-w-full items-center gap-0.5">
      <code className="min-w-0 truncate rounded bg-muted/60 px-1.5 py-px font-mono text-[11px] text-foreground">
        {command}
      </code>
      <Tooltip>
        <TooltipTrigger
          render={
            <Button
              size="icon-xs"
              variant="ghost"
              aria-label={`Copy command ${command}`}
              className="size-5 shrink-0 rounded-sm p-0 text-muted-foreground hover:text-foreground sm:size-5"
              onClick={() => copyToClipboard(command)}
            >
              {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
            </Button>
          }
        />
        <TooltipPopup side="top">{isCopied ? "Copied" : "Copy command"}</TooltipPopup>
      </Tooltip>
    </span>
  );
}

/**
 * One device in "Update everything": its Ryco release, the providers one click
 * updates there, chats a restart affects, what needs a hand, and during a run its
 * live status. Shared by the plan dialog and Settings → Updates.
 */
export function UpdateDeviceCard({
  view,
  meta,
  action,
  className,
}: {
  view: UpdateDeviceCardView;
  /** A quiet line under the name (Settings: channel and last check). */
  meta?: string | null;
  /** A trailing control on the name row (Settings: update just this device). */
  action?: ReactNode;
  className?: string;
}) {
  const { version, status } = view;
  return (
    <div
      role="group"
      aria-label={view.label}
      data-slot="update-device-card"
      className={cn("min-w-0 rounded-lg border border-border/70 px-3 py-2.5", className)}
    >
      <div className="flex min-w-0 items-center gap-2 text-[13px]">
        <span
          aria-hidden
          data-tone={view.dot}
          className={cn(
            "inline-block size-[7px] shrink-0 rounded-full",
            DOT_CLASS[view.dot],
            view.pulse && "animate-pulse motion-reduce:animate-none",
          )}
        />
        <span className="min-w-0 truncate font-semibold text-foreground">{view.label}</span>
        {view.installationLabel ? (
          <Badge
            variant="outline"
            size="sm"
            className="rounded-full bg-transparent font-normal text-muted-foreground dark:bg-transparent"
          >
            {view.installationLabel}
          </Badge>
        ) : null}
        <span className="ml-auto" />
        {version?.kind === "change" ? (
          <VersionChange
            from={version.from}
            to={version.to}
            emphasize={version.emphasize}
            className="text-[11.5px]"
          />
        ) : version?.kind === "current" ? (
          <span className="shrink-0 font-mono text-[11.5px] text-muted-foreground">
            {version.version}
          </span>
        ) : null}
        {action}
      </div>
      {meta ? <p className="mt-0.5 pl-[15px] text-[11px] text-muted-foreground">{meta}</p> : null}
      {status ? (
        <div className="mt-1.5 text-xs" data-slot="update-device-status">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className={cn("shrink-0 font-medium", STATUS_TEXT_CLASS[status.tone])}>
              {status.label}
            </span>
            {status.message ? (
              <span className="min-w-0 text-muted-foreground">{status.message}</span>
            ) : null}
          </p>
          {status.failures.map((failure) => (
            <p key={failure} className="mt-0.5 text-[11.5px] text-destructive">
              {failure}
            </p>
          ))}
        </div>
      ) : null}
      {view.providers.length > 0 ? (
        <ul
          aria-label={`Provider updates on ${view.label}`}
          className="mt-1.5 flex flex-col text-xs text-muted-foreground"
        >
          {view.providers.map((provider) => (
            <li key={provider.key} className="flex min-w-0 items-center gap-1.5 py-0.5">
              <span className="min-w-0 truncate">{provider.name}</span>
              <VersionChange
                from={provider.from}
                to={provider.to}
                emphasize={false}
                className="ml-auto text-[11px]"
              />
            </li>
          ))}
        </ul>
      ) : null}
      {view.chatWarning ? (
        <p className="mt-1.5 text-[11.5px] text-warning">{view.chatWarning}</p>
      ) : null}
      {view.notes.map((note) => (
        <p key={note} className="mt-1.5 text-[11.5px] text-muted-foreground">
          {note}
        </p>
      ))}
      {view.manual.map((item) => (
        <div
          key={item.key}
          className="mt-1.5 flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1 text-[11.5px] text-muted-foreground"
        >
          <span className="min-w-0">{item.text}</span>
          {item.command ? <CopyableCommand command={item.command} /> : null}
        </div>
      ))}
    </div>
  );
}
