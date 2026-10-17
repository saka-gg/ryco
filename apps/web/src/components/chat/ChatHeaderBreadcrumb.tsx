import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { ChevronRightIcon } from "lucide-react";
import { Fragment, memo, type ReactNode } from "react";
import { ProjectFavicon } from "../ProjectFavicon";

/** What the project segment needs to draw the project's artwork beside its name. */
export interface ChatHeaderBreadcrumbProjectIcon {
  readonly environmentId: EnvironmentId;
  readonly cwd: string;
  readonly projectId: ProjectId;
  readonly customAvatarContentHash: string | null;
}

export interface ChatHeaderBreadcrumbProps {
  projectName: string | null | undefined;
  projectIcon?: ChatHeaderBreadcrumbProjectIcon | null | undefined;
  sessionTitle: string;
  onSelectProject?: (() => void) | undefined;
}

export const ChatHeaderBreadcrumb = memo(function ChatHeaderBreadcrumb(
  props: ChatHeaderBreadcrumbProps,
) {
  const projectName = props.projectName?.trim() || null;
  const projectIcon = props.projectIcon ?? null;

  // A chevron only ever separates two segments: never one in front of the
  // first, so a missing project leaves no empty step behind.
  const segments: Array<{ readonly key: string; readonly node: ReactNode }> = [];
  if (projectName) {
    segments.push({
      key: "project",
      node: (
        <Segment
          label={projectName}
          icon={
            projectIcon ? (
              <ProjectFavicon
                environmentId={projectIcon.environmentId}
                cwd={projectIcon.cwd}
                projectId={projectIcon.projectId}
                customAvatarContentHash={projectIcon.customAvatarContentHash}
                className="size-4 shrink-0"
              />
            ) : null
          }
          onSelect={props.onSelectProject}
        />
      ),
    });
  }
  segments.push({
    key: "session",
    node: (
      <span className="min-w-0 truncate text-foreground/85" title={props.sessionTitle}>
        {props.sessionTitle}
      </span>
    ),
  });

  return (
    <nav
      aria-label="Breadcrumb"
      className="flex min-w-0 flex-1 items-center gap-1.5 text-sm font-medium"
    >
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 ? (
            <ChevronRightIcon
              className="size-3 shrink-0 text-muted-foreground/60"
              aria-hidden
              data-slot="breadcrumb-separator"
            />
          ) : null}
          {segment.node}
        </Fragment>
      ))}
    </nav>
  );
});

function Segment(props: { label: string; icon: ReactNode; onSelect: (() => void) | undefined }) {
  const content = (
    <>
      {props.icon}
      <span className="min-w-0 truncate" title={props.label}>
        {props.label}
      </span>
    </>
  );
  if (props.onSelect) {
    return (
      <button
        type="button"
        onClick={props.onSelect}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 -mx-1 text-foreground hover:bg-accent/50 focus-visible:outline-hidden focus-visible:ring-1 focus-visible:ring-ring"
      >
        {content}
      </button>
    );
  }
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5 text-foreground">{content}</span>
  );
}
