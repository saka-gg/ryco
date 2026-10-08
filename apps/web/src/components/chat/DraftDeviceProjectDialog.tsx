import type { Project } from "@ryco/client-runtime/state/threads";
import type { EnvironmentId, ProjectId } from "@ryco/contracts";
import { MessageCircleDashedIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useShallow } from "zustand/react/shallow";
import { CHAT_PROJECT_LABEL } from "../../composerDraftStore";
import { useChatsAvailability } from "../../hooks/useChatsAvailability";
import { excludeChatProjects } from "@ryco/shared/projectKind";
import { selectProjectsForEnvironment, useStore } from "../../store";
import { ProjectFavicon } from "../ProjectFavicon";
import { Button } from "../ui/button";
import { Dialog, DialogDescription, DialogHeader, DialogPopup, DialogTitle } from "../ui/dialog";
import { Input } from "../ui/input";

const ROW_CLASS_NAME =
  "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function DraftDeviceProjectDialog(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly phase: "connecting" | "project" | "error";
  readonly error?: string | undefined;
  readonly onCancel: () => void;
  readonly onRetry: () => void;
  readonly onSelect: (projectId: ProjectId) => void;
  /** Continue the draft as a "No project" chat on this device; absent hides the choice. */
  readonly onSelectNoProject?: (() => void) | undefined;
}) {
  const [query, setQuery] = useState("");
  const allProjects = useStore(
    useShallow((state) => selectProjectsForEnvironment(state, props.environmentId)),
  );
  // Chats are not projects to pick; "No project" stands in for all of them.
  const projects = useMemo(() => excludeChatProjects(allProjects), [allProjects]);
  const chatsAvailability = useChatsAvailability(props.environmentId);
  const filtered = useMemo(() => {
    const search = query.trim().toLowerCase();
    return projects.filter((project) =>
      `${project.name}\n${project.cwd}`.toLowerCase().includes(search),
    );
  }, [projects, query]);
  const showNoProject =
    props.onSelectNoProject !== undefined &&
    chatsAvailability.available &&
    `${CHAT_PROJECT_LABEL} chat`.toLowerCase().includes(query.trim().toLowerCase());
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
    >
      <DialogPopup bottomStickOnMobile={false}>
        <DialogHeader>
          <DialogTitle>
            {props.phase === "connecting"
              ? `Connecting to ${props.label}…`
              : `Choose a project on ${props.label}`}
          </DialogTitle>
          <DialogDescription>
            Your draft stays intact while you choose where to work.
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 flex-col gap-3 px-6 pb-6">
          {props.phase === "connecting" ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading device projects…
            </p>
          ) : null}
          {props.phase === "error" ? (
            <>
              <p role="alert" className="text-sm text-destructive">
                {props.error}
              </p>
              <Button onClick={props.onRetry}>Try again</Button>
            </>
          ) : null}
          {props.phase === "project" ? (
            <>
              <Input
                autoFocus
                placeholder="Search projects…"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
              />
              <div className="max-h-72 overflow-y-auto" aria-label={`Projects on ${props.label}`}>
                {showNoProject ? (
                  <button
                    type="button"
                    data-testid="draft-device-no-project"
                    onClick={props.onSelectNoProject}
                    className={`${ROW_CLASS_NAME} mb-1 border-border/60 border-b pb-2.5`}
                  >
                    <MessageCircleDashedIcon
                      aria-hidden
                      className="size-5 shrink-0 text-muted-foreground"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{CHAT_PROJECT_LABEL}</span>
                      <span className="truncate text-xs text-muted-foreground">
                        A chat in its own folder on this device
                      </span>
                    </span>
                  </button>
                ) : null}
                {filtered.map((project: Project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => props.onSelect(project.id)}
                    className={ROW_CLASS_NAME}
                  >
                    <ProjectFavicon
                      environmentId={project.environmentId}
                      cwd={project.cwd}
                      projectId={project.id}
                      customAvatarContentHash={project.customAvatarContentHash ?? null}
                      className="size-5 shrink-0"
                    />
                    <span className="flex min-w-0 flex-col">
                      <span className="truncate text-sm font-medium">{project.name}</span>
                      <span className="truncate text-xs text-muted-foreground">{project.cwd}</span>
                    </span>
                  </button>
                ))}
                {filtered.length === 0 && !showNoProject ? (
                  <p className="py-4 text-sm text-muted-foreground">
                    {projects.length === 0
                      ? "No projects on this device yet. Add a project from the device’s workspace."
                      : "No matching projects."}
                  </p>
                ) : null}
              </div>
            </>
          ) : null}
          <Button variant="ghost" onClick={props.onCancel}>
            Cancel
          </Button>
        </div>
      </DialogPopup>
    </Dialog>
  );
}
