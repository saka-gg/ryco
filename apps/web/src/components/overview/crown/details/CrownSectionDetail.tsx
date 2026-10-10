import { FolderGit2Icon } from "lucide-react";

import { PROMOTE_CHAT_SUMMARY } from "../../../chat/ChatProjectActions";
import { Button } from "../../../ui/button";
import { NotesPane } from "../../notes/NotesPane";
import type { CrownChatBinding, CrownNotesBinding, CrownSectionDetailProps } from "../crownTypes";
import { AgentsDetail } from "./AgentsDetail";
import { BranchDetail } from "./BranchDetail";
import { ChangesDetail } from "./ChangesDetail";
import { ChecksDetail } from "./ChecksDetail";
import {
  CROWN_PILL_BUTTON_CLASS,
  crownRailItemForSection,
  CrownDetailActions,
  CrownDetailEmpty,
  CrownDetailFootnote,
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
 * pane's own header, as in the prototype. Both share the binding's scope view
 * and its unsaved text.
 */
export function CrownNotesDetail(props: {
  readonly notes: CrownNotesBinding;
  readonly variant: "flyout" | "card";
  readonly autoFocus?: boolean;
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
        body={notes.bodyFor(notes.view)}
        onChange={notes.edit}
        onFlush={notes.flush}
        saveState={notes.saveStateFor(notes.view)}
        breadcrumb={notes.breadcrumb}
        disabledReason={notes.editDisabledReasonFor(notes.view)}
        error={notes.error}
        worktreeViewDisabledReason={notes.worktreeViewDisabledReason}
        compact={variant === "card"}
        autoFocus={props.autoFocus === true}
      />
    </div>
  );
}

/**
 * A chat's "Turn into project" section, in place of the source-control ones.
 * The flyout previews what promotion does; the card holds the button, and the
 * dialog grows out of it.
 */
export function CrownChatDetail(props: {
  readonly chat: CrownChatBinding;
  readonly variant: "flyout" | "card";
}) {
  const { chat, variant } = props;
  return (
    <div
      className="min-w-0 text-[12px] leading-[1.45]"
      data-slot="crown-section-detail"
      data-section="project"
      data-variant={variant}
    >
      <CrownDetailHeading section="project" variant={variant} />
      <p className="mx-1 text-muted-foreground">{PROMOTE_CHAT_SUMMARY}</p>
      {variant === "flyout" ? (
        <CrownDetailFootnote>Click to choose where it goes</CrownDetailFootnote>
      ) : (
        <CrownDetailActions>
          <Button
            variant="ghost"
            size="sm"
            className={CROWN_PILL_BUTTON_CLASS}
            data-testid="crown-promote-chat"
            onPointerEnter={chat.preload}
            onFocus={chat.preload}
            onClick={(event) => chat.turnIntoProject(event.currentTarget)}
          >
            <FolderGit2Icon aria-hidden="true" className="size-3.5" />
            Turn into project…
          </Button>
        </CrownDetailActions>
      )}
    </div>
  );
}
