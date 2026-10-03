import { preferredUpdateBranchMethod } from "@ryco/shared/sourceControl";
import type { RefObject } from "react";

import { cn } from "../../../lib/utils";
import { InboxMotionContext, useInboxListMotion } from "../../inboxSidebar/useInboxListMotion";
import { Skeleton } from "../../ui/skeleton";
import { usePullRequestAgentHandoff } from "../agentHandoff";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { FactGlyph } from "./FactGlyph";
import type { MergeStatusLine, MergeVerdict } from "./mergeFacts.logic";
import { NextActionControl } from "./NextActionButton";
import { useMergeCommands, type MergeCommands } from "./useMergeCommands";
import { useMergeModel } from "./useMergeModel";

/**
 * The merge box, unboxed: the verdict and who it waits on, up to four status
 * lines that each jump to what they describe, and the next-action button.
 * In the band it folds to verdict + button on one line and the lines in a row.
 */
export function MergeSection(props: { readonly layout: "rail" | "band" }) {
  const { model: page } = usePullRequestsPage();
  const selection = usePullRequestSelection();
  const model = useMergeModel();
  const commands = useMergeCommands(model);
  // One motion gate for the whole section: marks (verdict and lines) that
  // remount after the first paint pop, and reordered lines glide.
  const { listRef, gateRef } = useInboxListMotion({
    enabled: true,
    orderSignature: model?.lines.map((line) => line.key).join(",") ?? "",
  });
  // A host that reports no merge readiness gets no verdict rather than a guessed one.
  if (!page.capabilities.mergeReadiness) return null;
  if (!model) {
    // A failed detail read is reported by the reader; the rail stays quiet.
    return selection.detail.error && !selection.detail.isLoading ? null : (
      <MergeSkeleton layout={props.layout} />
    );
  }

  if (props.layout === "band") {
    return (
      <InboxMotionContext.Provider value={gateRef}>
        <section aria-label="Merge status" className="flex flex-col gap-2">
          <div className="flex min-h-8 items-center gap-3">
            <VerdictLine verdict={model.verdict} className="min-w-0 flex-1" />
            <NextActionControl
              model={model}
              commands={commands}
              size="default"
              shortcutTab="conversation"
            />
          </div>
          {model.verdict.reason ? <VerdictReason text={model.verdict.reason} /> : null}
          <StatusLines listRef={listRef} lines={model.lines} commands={commands} layout="band" />
        </section>
      </InboxMotionContext.Provider>
    );
  }

  return (
    <InboxMotionContext.Provider value={gateRef}>
      <section aria-label="Merge status" className="flex flex-col">
        <VerdictLine verdict={model.verdict} />
        {model.verdict.reason ? (
          <VerdictReason text={model.verdict.reason} className="mt-1" />
        ) : null}
        {model.lines.length > 0 ? (
          <StatusLines
            listRef={listRef}
            lines={model.lines}
            commands={commands}
            layout="rail"
            className="mt-2"
          />
        ) : null}
        <NextActionControl
          model={model}
          commands={commands}
          size="default"
          shortcutTab="conversation"
          className="mt-3 self-start"
        />
      </section>
    </InboxMotionContext.Provider>
  );
}

function VerdictLine(props: { readonly verdict: MergeVerdict; readonly className?: string }) {
  const { verdict } = props;
  return (
    <div className={cn("flex min-w-0 items-center gap-2", props.className)}>
      <FactGlyph key={verdict.tone} tone={verdict.tone} />
      <p className="min-w-0 truncate text-[13px]">
        <span className="font-medium text-foreground">{verdict.text}</span>
        {verdict.owner ? (
          <span className="text-muted-foreground">
            <span aria-hidden> · </span>
            <span className="sr-only">, </span>
            {verdict.owner}
          </span>
        ) : null}
      </p>
    </div>
  );
}

function VerdictReason(props: { readonly text: string; readonly className?: string }) {
  return (
    <p className={cn("pl-[22px] text-xs leading-relaxed text-muted-foreground", props.className)}>
      {props.text}
    </p>
  );
}

/**
 * Status lines, most urgent first. Rows glide when their order changes and a
 * line whose tone changes remounts its mark so it pops (never on first view).
 */
function StatusLines({
  listRef,
  lines,
  commands,
  layout,
  className,
}: {
  readonly listRef: RefObject<HTMLDivElement | null>;
  readonly lines: ReadonlyArray<MergeStatusLine>;
  readonly commands: MergeCommands;
  readonly layout: "rail" | "band";
  readonly className?: string;
}) {
  return (
    <div
      ref={listRef}
      role="list"
      aria-label="Merge requirements"
      className={cn(
        "relative",
        layout === "rail" ? "flex flex-col" : "flex flex-wrap items-center gap-x-4 gap-y-1",
        className,
      )}
    >
      {lines.map((line) => (
        <StatusLineRow key={line.key} line={line} commands={commands} layout={layout} />
      ))}
    </div>
  );
}

function StatusLineRow(props: {
  readonly line: MergeStatusLine;
  readonly commands: MergeCommands;
  readonly layout: "rail" | "band";
}) {
  const { nav, model } = usePullRequestsPage();
  const handoff = usePullRequestAgentHandoff();
  const { line, layout } = props;
  const target = line.target;
  const open = () => {
    if (!target) return;
    switch (target.kind) {
      case "job":
        nav.revealJob(target.jobId);
        return;
      case "checks":
        nav.setTab("checks");
        return;
      case "thread":
        nav.revealThread(target.threadId);
        return;
    }
  };
  // Agent fixes need a hand-off; branch updates need the host's mutation, not an agent.
  const fix =
    line.fix &&
    (line.fix.kind === "update-branch"
      ? preferredUpdateBranchMethod(model.capabilities) !== null
      : handoff.available)
      ? line.fix
      : null;
  const body = (
    <>
      <FactGlyph key={line.tone} tone={line.tone} />
      <span
        className={cn(
          "min-w-0 truncate",
          line.tone === "success" || line.tone === "neutral"
            ? "text-foreground/80"
            : "text-foreground",
        )}
      >
        {line.text}
      </span>
      {/* Stays whole while a long check name truncates before it. */}
      {line.note ? (
        <span className="shrink-0 text-[11px] text-muted-foreground">
          <span className="sr-only">, </span>
          {line.note}
        </span>
      ) : null}
    </>
  );
  const meta = line.meta ? (
    <span
      className={cn("shrink-0 text-xs text-muted-foreground tabular-nums", fix && "pr-swap-out")}
    >
      {line.meta}
    </span>
  ) : null;

  return (
    <div
      role="listitem"
      data-inbox-row-key={line.key}
      data-status-line={line.key}
      className={cn(
        "pr-swap relative flex min-w-0 items-center",
        layout === "rail" ? "-mx-1.5 h-7 rounded-md" : "h-6",
        layout === "rail" && target && "hover:bg-accent/50",
        "transition-colors duration-(--app-motion-duration-chip)",
      )}
    >
      {target ? (
        <button
          type="button"
          onClick={open}
          className={cn(
            "flex h-full min-w-0 items-center gap-2 rounded-md text-left text-[13px] outline-hidden focus-visible:ring-2 focus-visible:ring-ring",
            layout === "rail" ? "flex-1 px-1.5" : "hover:[&>span]:text-foreground",
          )}
        >
          {body}
        </button>
      ) : (
        <span
          className={cn(
            "flex h-full min-w-0 items-center gap-2 text-[13px]",
            layout === "rail" && "flex-1 px-1.5",
          )}
        >
          {body}
        </span>
      )}
      {/* The meta gives way to the ghost fix (see `.pr-swap` in rail.css). */}
      {layout === "rail" ? (
        meta || fix ? (
          <span className="pr-swap-slot shrink-0 justify-items-end pr-1.5">
            {meta}
            {fix ? (
              <FixGhost label={fix.label} onClick={() => props.commands.runFix(line)} />
            ) : null}
          </span>
        ) : null
      ) : meta || fix ? (
        <span className="pr-swap-slot ml-1.5 shrink-0 justify-items-start">
          {meta}
          {fix ? (
            <FixGhost
              label={fix.label}
              onClick={() => props.commands.runFix(line)}
              className="-ml-1.5"
            />
          ) : null}
        </span>
      ) : null}
    </div>
  );
}

function FixGhost(props: {
  readonly label: string;
  readonly onClick: () => void;
  readonly className?: string;
}) {
  return (
    <button
      type="button"
      onClick={props.onClick}
      className={cn(
        "pr-swap-in h-5 rounded px-1.5 text-[11px] text-muted-foreground outline-hidden hover:bg-background/80 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
        props.className,
      )}
    >
      {props.label}
    </button>
  );
}

function MergeSkeleton(props: { readonly layout: "rail" | "band" }) {
  if (props.layout === "band") {
    return (
      <div className="flex flex-col gap-2" aria-hidden>
        <div className="flex items-center gap-3">
          <Skeleton className="h-3.5 w-40" />
          <span className="flex-1" />
          <Skeleton className="h-8 w-36 rounded-lg" />
        </div>
        <Skeleton className="h-3 w-3/4" />
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-2.5" aria-hidden>
      <Skeleton className="h-3.5 w-32" />
      <Skeleton className="h-3 w-48" />
      <Skeleton className="h-3 w-40" />
      <Skeleton className="h-3 w-44" />
      <Skeleton className="mt-1 h-8 w-36 rounded-lg" />
    </div>
  );
}
