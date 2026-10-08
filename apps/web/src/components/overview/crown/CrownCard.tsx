import { GitBranchIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { useId, type ReactNode, type Ref } from "react";

import type { OverviewLayoutProps } from "../overviewTypes";
import { CrownNotesDetail, CrownSectionDetail } from "./details/CrownSectionDetail";
import { CROWN_SECTION_LABEL, type CrownSection } from "./crownSections";
import type { CrownNotesBinding } from "./crownTypes";

/**
 * The expanded crown (prototype `.cr-card`): a header row and the selected
 * section's detail on the left, the rail's icons as a spine on the right. The
 * detail remounts per section, which plays the `crown-swapin` entrance.
 */
export function CrownCard({
  mainRef,
  closeButtonRef,
  ...props
}: {
  readonly section: CrownSection;
  readonly visible: boolean;
  /** False once the card has folded away, so its detail stops rendering. */
  readonly contentMounted: boolean;
  readonly layout: OverviewLayoutProps;
  readonly isGitRepo: boolean;
  readonly agentRunning: boolean;
  readonly branchName: string | null;
  /** Renders the Notes section; without it the section is never selected. */
  readonly notes?: CrownNotesBinding | undefined;
  /** The note a "Note saved" alert opened the card on. */
  readonly highlightNoteId?: string | null;
  readonly onCollapse: () => void;
  readonly spine: ReactNode;
  readonly mainRef?: Ref<HTMLDivElement>;
  readonly closeButtonRef?: Ref<HTMLButtonElement>;
}) {
  const { layout, section, visible } = props;
  const titleId = useId();
  const pullRequest = layout.pullRequest;
  const refreshing = layout.isRefreshingPullRequest === true;
  return (
    <div
      className="crown-layer crown-card-layer"
      data-slot="crown-card"
      data-visible={visible ? "true" : undefined}
      role="region"
      aria-labelledby={titleId}
      aria-hidden={visible ? undefined : true}
      inert={!visible || undefined}
    >
      <div ref={mainRef} className="crown-card-main">
        <div className="crown-card-head">
          <span
            aria-hidden="true"
            className="crown-agent-dot"
            data-running={props.agentRunning ? "true" : undefined}
          />
          <span id={titleId} className="crown-card-title">
            {CROWN_SECTION_LABEL[section]}
          </span>
          {props.branchName ? (
            <span className="crown-chip" title={props.branchName}>
              <GitBranchIcon aria-hidden="true" />
              <span className="truncate">{props.branchName}</span>
            </span>
          ) : null}
          <span className="flex shrink-0 items-center gap-0.5">
            {layout.onRefreshPullRequest ? (
              <button
                type="button"
                className="crown-icon-btn"
                aria-label={
                  pullRequest?.checksError
                    ? "Refresh pull request (last refresh failed)"
                    : "Refresh pull request"
                }
                aria-busy={refreshing || undefined}
                disabled={refreshing}
                onClick={layout.onRefreshPullRequest}
              >
                <RefreshCwIcon
                  aria-hidden="true"
                  className={refreshing ? "crown-refresh-spin" : undefined}
                />
                {pullRequest?.checksError ? (
                  <span aria-hidden="true" className="crown-refresh-warning" />
                ) : null}
              </button>
            ) : null}
            <button
              ref={closeButtonRef}
              type="button"
              className="crown-icon-btn"
              aria-label="Collapse overview"
              onClick={props.onCollapse}
            >
              <XIcon aria-hidden="true" />
            </button>
          </span>
        </div>
        <div className="crown-card-detail" data-slot="crown-card-detail">
          {props.contentMounted ? (
            <div key={section} className="crown-swapin">
              {section === "notes" ? (
                props.notes ? (
                  <CrownNotesDetail
                    notes={props.notes}
                    variant="card"
                    highlightId={props.highlightNoteId ?? null}
                    // The prototype focuses the composer whenever the section opens.
                    autoFocusComposer={visible}
                  />
                ) : null
              ) : (
                <CrownSectionDetail
                  section={section}
                  variant="card"
                  layout={layout}
                  isGitRepo={props.isGitRepo}
                />
              )}
            </div>
          ) : null}
        </div>
      </div>
      {props.spine}
    </div>
  );
}
