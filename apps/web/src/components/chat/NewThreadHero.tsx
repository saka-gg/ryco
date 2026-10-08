import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { isChatProject } from "@ryco/shared/projectKind";
import { MessageCircleDashedIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";

import { CHAT_PROJECT_LABEL, type DraftId } from "../../composerDraftStore";
import { selectProjectsAcrossEnvironments, useStore } from "../../store";
import { ProjectSwitcher } from "../ProjectSwitcher";
import { RycoLetterMark } from "../RycoLetterMark";
import {
  canStartNewThreadWithoutProject,
  canSwitchNewThreadProject,
  resolveNewThreadHeadline,
} from "./NewThreadHero.logic";

export interface NewThreadHeroProps {
  readonly projectName: string | null;
  readonly activeProjectId: ProjectId | null;
  readonly activeProjectEnvironmentId: EnvironmentId | null;
  readonly routeKind: "draft" | "server";
  readonly envLocked: boolean;
  /** Present only on the draft route; without it the project is fixed. */
  readonly draftId: DraftId | undefined;
  /** The "Work in …" row rendered beneath the headline. */
  readonly workLocation: ReactNode;
  /** The draft is a "No project" chat that has not been sent yet. */
  readonly pendingChat?: boolean;
  /** Whether the draft's node can host chats ("No project" entries are hidden otherwise). */
  readonly chatsAvailable?: boolean;
  /** Turns this draft into a "No project" chat ("or start without a project"). */
  readonly onStartWithoutProject?: (() => void) | undefined;
}

const HERO_REVEAL_CLASS_NAME =
  "motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300";

/**
 * Empty-thread starting screen: the app mark over "What should we do in
 * <project>?". `ChatView` renders this in place of the timeline while a thread
 * has no messages; the composer and `BranchToolbar` sit directly beneath it and
 * the three read as one vertically centered block.
 *
 * A "No project" chat draft drops the project from the headline and explains
 * where its files go instead; a project draft offers "or start without a
 * project" where the node supports chats.
 */
export function NewThreadHero({
  projectName,
  activeProjectId,
  activeProjectEnvironmentId,
  routeKind,
  envLocked,
  draftId,
  workLocation,
  pendingChat = false,
  chatsAvailable = false,
  onStartWithoutProject,
}: NewThreadHeroProps) {
  const headline = resolveNewThreadHeadline({ projectName: pendingChat ? null : projectName });
  const projectCount = useStore(
    useShallow(
      (store) =>
        selectProjectsAcrossEnvironments(store).filter((project) => !isChatProject(project)).length,
    ),
  );
  const switchable =
    activeProjectId !== null &&
    activeProjectEnvironmentId !== null &&
    draftId !== undefined &&
    canSwitchNewThreadProject({ routeKind, envLocked, projectCount, chatsAvailable });
  const canSwitchProject = headline.projectName !== null && switchable;
  const showStartWithoutProject =
    onStartWithoutProject !== undefined &&
    canStartNewThreadWithoutProject({ routeKind, envLocked, chatsAvailable, pendingChat });

  return (
    <div
      className="flex shrink-0 flex-col items-center gap-4 px-6 pb-6 sm:gap-5 sm:pb-8"
      data-testid="new-thread-hero"
    >
      <RycoLetterMark className="h-10 text-foreground sm:h-12" />
      <div className="flex flex-col items-center gap-2">
        <h1 className="max-w-208 text-balance text-center font-medium text-2xl text-foreground tracking-tight sm:text-3xl">
          {headline.projectName === null ? (
            headline.text
          ) : (
            <>
              {headline.prefix}
              {canSwitchProject && activeProjectId && activeProjectEnvironmentId && draftId ? (
                <ProjectSwitcher
                  activeProjectId={activeProjectId}
                  activeProjectEnvironmentId={activeProjectEnvironmentId}
                  appearance="headline"
                  draftId={draftId}
                  label={headline.projectName}
                />
              ) : (
                <span className="text-foreground">{headline.projectName}</span>
              )}
              {headline.suffix}
            </>
          )}
        </h1>
        {showStartWithoutProject ? (
          <button
            type="button"
            data-testid="new-thread-start-without-project"
            title="Start a chat in its own folder. You can turn it into a project later."
            className={`${HERO_REVEAL_CLASS_NAME} rounded-sm text-muted-foreground text-sm underline-offset-4 transition-colors hover:text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring`}
            onClick={onStartWithoutProject}
          >
            or start without a project
          </button>
        ) : null}
      </div>
      {pendingChat ? (
        <div
          data-testid="new-thread-chat-location"
          className={`${HERO_REVEAL_CLASS_NAME} flex max-w-full flex-col items-center gap-1 text-center text-muted-foreground text-sm`}
        >
          <span className="inline-flex min-w-0 items-center gap-1.5">
            {switchable && activeProjectId && activeProjectEnvironmentId && draftId ? (
              <ProjectSwitcher
                activeProjectId={activeProjectId}
                activeProjectEnvironmentId={activeProjectEnvironmentId}
                appearance="sentence"
                draftId={draftId}
                label={CHAT_PROJECT_LABEL}
              />
            ) : (
              <span className="inline-flex items-center gap-1.5 font-medium text-foreground/85">
                <MessageCircleDashedIcon aria-hidden className="size-3.5 shrink-0 opacity-80" />
                {CHAT_PROJECT_LABEL}
              </span>
            )}
          </span>
          <span className="text-muted-foreground/80 text-xs">
            Files go to a new folder in Chats. You can turn it into a project later.
          </span>
        </div>
      ) : (
        workLocation
      )}
    </div>
  );
}
