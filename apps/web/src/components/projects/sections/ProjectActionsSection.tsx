import type { ProjectScript } from "@ryco/contracts";
import { PencilIcon, PlayIcon, PlusIcon } from "lucide-react";
import { useMemo, useRef, useState } from "react";

import { useAppKeybindings } from "../../../appKeybindings";
import { useProjectScriptMutations } from "../../../hooks/useProjectScriptMutations";
import { shortcutLabelForCommand } from "../../../keybindings";
import { commandForProjectScript } from "../../../projectScripts";
import {
  InboxMotionContext,
  INBOX_ROW_KEY_ATTRIBUTE,
  useInboxListMotion,
} from "../../inboxSidebar/useInboxListMotion";
import { ProjectScriptDialog, ScriptIcon } from "../../ProjectScriptDialog";
import { SettingsEmpty } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import type { SurfaceMorph } from "../../ui/surfaceMorph";
import { ProjectSection } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

const PROJECT_SCRIPT_ROW_ATTRIBUTE = "data-project-script-id";

/**
 * The project's actions (scripts): what they run, the shortcut, and which
 * one sets up new worktrees. Editing opens the same dialog as the chat
 * header's run control; it grows from the row and folds back into it.
 */
export function ProjectActionsSection({ member, canEdit }: ProjectSectionProps) {
  const scope = useMemo(
    () => ({ environmentId: member.environmentId, projectId: member.id }),
    [member.environmentId, member.id],
  );
  const keybindings = useAppKeybindings(scope);
  const mutations = useProjectScriptMutations(member.environmentId, member);
  const [editing, setEditing] = useState<ProjectScript | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [session, setSession] = useState(0);
  const originRef = useRef<HTMLElement | null>(null);
  const savedIdRef = useRef<string | null>(null);
  const listContainerRef = useRef<HTMLDivElement | null>(null);

  const morph: SurfaceMorph = {
    origin: () => originRef.current,
    target: () => {
      const savedId = savedIdRef.current;
      if (savedId !== null) {
        const row = listContainerRef.current?.querySelector<HTMLElement>(
          `[${PROJECT_SCRIPT_ROW_ATTRIBUTE}="${CSS.escape(savedId)}"]`,
        );
        if (row) return row;
      }
      return originRef.current?.isConnected ? originRef.current : null;
    },
  };

  const open = (script: ProjectScript | null, origin: HTMLElement) => {
    originRef.current = origin;
    savedIdRef.current = null;
    setEditing(script);
    setSession((value) => value + 1);
    setDialogOpen(true);
  };

  const orderSignature = member.scripts.map((script) => script.id).join("\0");
  const { listRef, gateRef } = useInboxListMotion({
    enabled: member.scripts.length > 0,
    orderSignature,
  });

  return (
    <ProjectSection
      section="actions"
      description="Run from the chat's top bar or their shortcut. The setup action runs once on every new worktree."
      action={
        member.scripts.length > 0 ? (
          <Button
            size="sm"
            variant="outline"
            disabled={!canEdit}
            onClick={(event) => open(null, event.currentTarget)}
          >
            <PlusIcon className="size-3.5" />
            Add action
          </Button>
        ) : undefined
      }
    >
      {member.scripts.length === 0 ? (
        <SettingsEmpty
          icon={<PlayIcon />}
          title="No actions yet"
          description="Save the commands you run in this project (tests, a dev server, a build) and run them with one click or a shortcut."
          action={
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit}
              onClick={(event) => open(null, event.currentTarget)}
            >
              <PlusIcon className="size-3.5" />
              Add action
            </Button>
          }
        />
      ) : (
        <InboxMotionContext.Provider value={gateRef}>
          <div
            ref={(node) => {
              listRef.current = node;
              listContainerRef.current = node;
            }}
            role="list"
            aria-label="Actions"
            className="relative"
          >
            {member.scripts.map((script) => {
              const shortcut = shortcutLabelForCommand(
                keybindings,
                commandForProjectScript(script.id),
              );
              return (
                <div
                  key={script.id}
                  role="listitem"
                  {...{
                    [INBOX_ROW_KEY_ATTRIBUTE]: script.id,
                    [PROJECT_SCRIPT_ROW_ATTRIBUTE]: script.id,
                  }}
                  className="group/action flex min-w-0 items-center gap-3 border-t border-border/60 px-4 py-3 first:border-t-0 @[36rem]/detail:px-5"
                >
                  <span className="grid size-8 shrink-0 place-items-center rounded-[min(var(--radius-lg),0.625rem)] bg-foreground/5 text-foreground/80">
                    <ScriptIcon icon={script.icon} className="size-3.5" />
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex min-w-0 items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{script.name}</span>
                      {script.runOnWorktreeCreate ? (
                        <span className="shrink-0 rounded-[min(var(--radius-sm),0.25rem)] bg-muted px-1.5 py-px text-[10px] text-muted-foreground">
                          setup
                        </span>
                      ) : null}
                    </div>
                    <code
                      className="block truncate font-mono text-[11px] text-muted-foreground"
                      title={script.command}
                    >
                      {script.command}
                    </code>
                  </div>
                  {shortcut ? (
                    <kbd className="hidden shrink-0 font-sans text-[11px] text-muted-foreground @[36rem]/detail:inline">
                      {shortcut}
                    </kbd>
                  ) : null}
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={`Edit ${script.name}`}
                    disabled={!canEdit}
                    className="shrink-0 opacity-60 transition-opacity duration-(--app-motion-duration-chip) group-hover/action:opacity-100 focus-visible:opacity-100"
                    onClick={(event) =>
                      open(
                        script,
                        event.currentTarget.closest<HTMLElement>(
                          `[${PROJECT_SCRIPT_ROW_ATTRIBUTE}]`,
                        ) ?? event.currentTarget,
                      )
                    }
                  >
                    <PencilIcon className="size-3.5" />
                  </Button>
                </div>
              );
            })}
          </div>
        </InboxMotionContext.Provider>
      )}
      <ProjectScriptDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        session={session}
        script={editing}
        scripts={member.scripts}
        keybindings={keybindings}
        morph={morph}
        onSave={(input, editingScriptId) =>
          editingScriptId
            ? mutations.updateProjectScript(editingScriptId, input)
            : mutations.saveProjectScript(input)
        }
        onSaved={(scriptId) => {
          savedIdRef.current = scriptId;
        }}
        onDelete={mutations.deleteProjectScript}
      />
    </ProjectSection>
  );
}
