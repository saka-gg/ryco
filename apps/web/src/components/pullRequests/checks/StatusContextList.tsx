import { ArrowUpRightIcon } from "lucide-react";
import { memo } from "react";

import { openExternalLink } from "../../../lib/openExternalLink";
import { CheckStateGlyph, RelativeTime } from "../primitives";
import { CHECK_STATE_LABEL, checkStateOverall, type ChecksStatusEntry } from "./checksModel";
import { RequiredTag } from "./checksUi";

/**
 * Checks no Actions run accounts for — commit statuses (deployments, external
 * CI) and third-party check runs. There is nothing to expand, so each is a
 * plain link to wherever the host points.
 */
export const StatusContextList = memo(function StatusContextList(props: {
  readonly statuses: ReadonlyArray<ChecksStatusEntry>;
  /** "Other checks" under workflows; untitled when nothing else is listed. */
  readonly title: string | null;
}) {
  const worst = props.statuses[0]?.check.state ?? "unknown";
  const worstOverall = checkStateOverall(worst);
  return (
    <section
      data-inbox-row-key="statuses"
      aria-label={props.title ?? "Checks"}
      className="relative pt-5 first:pt-1"
    >
      {props.title ? (
        <div className="flex h-9 items-center gap-2 pr-1 pl-1">
          <CheckStateGlyph
            key={worstOverall}
            overall={worstOverall}
            label={CHECK_STATE_LABEL[worst]}
          />
          <h3 className="min-w-0 truncate text-[13px] font-semibold text-foreground">
            {props.title}
          </h3>
        </div>
      ) : null}
      <ul className="border-t border-border/60">
        {props.statuses.map((status) => (
          <StatusRow key={status.key} status={status} />
        ))}
      </ul>
    </section>
  );
});

function StatusRow(props: { readonly status: ChecksStatusEntry }) {
  const { check } = props.status;
  const overall = checkStateOverall(check.state);
  const time = check.completedAtMs ?? check.startedAtMs;
  const content = (
    <>
      <span aria-hidden className="size-3 shrink-0" />
      <CheckStateGlyph key={overall} overall={overall} label={CHECK_STATE_LABEL[check.state]} />
      <span className="min-w-0 truncate text-[13px] font-medium text-foreground">
        {check.label}
      </span>
      <span className="flex-1" />
      {check.required === true ? <RequiredTag /> : null}
      {time !== null ? (
        <RelativeTime
          value={new Date(time).toISOString()}
          className="w-16 text-right text-xs text-muted-foreground"
        />
      ) : null}
      <span className="inline-flex size-6 shrink-0 items-center justify-center">
        {check.url ? (
          <ArrowUpRightIcon
            aria-hidden
            className="size-3.5 text-muted-foreground/70 transition-colors duration-(--app-motion-duration-chip) group-hover/row:text-foreground"
          />
        ) : null}
      </span>
    </>
  );
  const rowClass =
    "group/row flex h-10 w-full items-center gap-2 rounded-md pr-1 pl-1 text-left outline-hidden";
  return (
    <li data-inbox-row-key={`status:${props.status.key}`} className="border-b border-border/60">
      {check.url ? (
        <button
          type="button"
          onClick={() => openExternalLink(check.url!, `Couldn't open ${check.label}`)}
          className={`${rowClass} transition-colors duration-(--app-motion-duration-chip) hover:bg-foreground/[0.025] focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset`}
        >
          {content}
        </button>
      ) : (
        <div className={rowClass}>{content}</div>
      )}
    </li>
  );
}
