import { NotesPane } from "../../notes/NotesPane";
import type { CrownNotesBinding, CrownSectionDetailProps } from "../crownTypes";
import { AgentsDetail } from "./AgentsDetail";
import { BranchDetail } from "./BranchDetail";
import { ChangesDetail } from "./ChangesDetail";
import { ChecksDetail } from "./ChecksDetail";
import {
  crownRailItemForSection,
  CrownDetailEmpty,
  CrownDetailHeading,
  type CrownDetailViewProps,
} from "./crownDetailPrimitives";
import { PlanDetail } from "./PlanDetail";
import { PullRequestDetail } from "./PullRequestDetail";

function SectionBody({
  section,
  ...props
}: CrownDetailViewProps & { section: CrownSectionDetailProps["section"] }) {
  switch (section) {
    case "branch":
      return <BranchDetail {...props} />;
    case "changes":
      return <ChangesDetail {...props} />;
    case "checks":
      return <ChecksDetail {...props} />;
    case "plan":
      return <PlanDetail {...props} />;
    case "agents":
      return <AgentsDetail {...props} />;
    case "pr":
      return <PullRequestDetail {...props} />;
  }
}

/**
 * One Crown section's detail, shared by the hover flyout (`variant="flyout"`,
 * with a heading row) and the expanded card (`variant="card"`, whose header
 * already titles the section). Mirrors the prototype's `D.*` builders.
 */
export function CrownSectionDetail(props: CrownSectionDetailProps) {
  const { section, variant, isGitRepo } = props;
  const needsGit = crownRailItemForSection(section)?.requiresGit ?? false;
  return (
    <div
      className="min-w-0 text-[12px] leading-[1.45]"
      data-slot="crown-section-detail"
      data-section={section}
      data-variant={variant}
    >
      {needsGit && !isGitRepo ? (
        <>
          <CrownDetailHeading section={section} variant={variant} />
          <CrownDetailEmpty>Not a git repository</CrownDetailEmpty>
        </>
      ) : (
        <SectionBody {...props} />
      )}
    </div>
  );
}

/**
 * The Notes section: the shared NotesPane bound to the thread's notes. The
 * card titles the section itself, so its pane is compact; the flyout keeps the
 * pane's own header, as in the prototype. Both share the binding's scope view.
 */
export function CrownNotesDetail(props: {
  readonly notes: CrownNotesBinding;
  readonly variant: "flyout" | "card";
  readonly highlightId?: string | null;
  readonly autoFocusComposer?: boolean;
}) {
  const { notes, variant } = props;
  return (
    <div
      className="min-w-0"
      data-slot="crown-section-detail"
      data-section="notes"
      data-variant={variant}
    >
      <NotesPane
        view={notes.view}
        onViewChange={notes.setView}
        notes={notes.notesFor(notes.view)}
        breadcrumb={notes.breadcrumb}
        threadTitle={notes.threadTitle}
        composerDisabledReason={notes.composerDisabledReason}
        actionsDisabledReason={notes.disabledReason}
        error={notes.error}
        onSave={notes.save}
        onToggleTodo={notes.toggleTodo}
        onTogglePin={notes.togglePin}
        onDelete={notes.remove}
        onOpenThread={notes.openThread ?? undefined}
        worktreeViewDisabledReason={notes.worktreeViewDisabledReason}
        truncatedLimit={notes.truncatedLimit}
        highlightId={props.highlightId ?? null}
        compact={variant === "card"}
        autoFocusComposer={props.autoFocusComposer === true}
      />
    </div>
  );
}
