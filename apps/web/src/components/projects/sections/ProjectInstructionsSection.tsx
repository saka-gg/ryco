import { PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS } from "@ryco/contracts";
import { useState } from "react";

import { cn } from "../../../lib/utils";
import { updateProjectMeta } from "../../../projectMutations";
import { SettingsBlock } from "../../settings/settingsLayout";
import { Button } from "../../ui/button";
import { Textarea } from "../../ui/textarea";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { ProjectSection, useSavedFlash } from "./ProjectSection";
import type { ProjectSectionProps } from "./projectSectionTypes";

/**
 * Instructions appended to every agent prompt in this project. A draft is
 * held locally; Save and Revert appear only while it differs from the saved
 * text, so the section never shows buttons that do nothing.
 */
export function ProjectInstructionsSection({ member, canEdit }: ProjectSectionProps) {
  const saved = member.customSystemPrompt ?? "";
  const savedFlash = useSavedFlash();
  const [draft, setDraft] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const value = draft ?? saved;
  const dirty = draft !== null && draft.trim() !== saved.trim();
  const limit = PROJECT_CUSTOM_SYSTEM_PROMPT_MAX_CHARS;
  const length = value.length;

  const save = async () => {
    const next = value.trim();
    setSaving(true);
    try {
      await updateProjectMeta(member, { customSystemPrompt: next.length > 0 ? next : null });
      setDraft(null);
      savedFlash.flash();
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Failed to save the instructions",
          description: error instanceof Error ? error.message : "An error occurred.",
        }),
      );
    } finally {
      setSaving(false);
    }
  };

  return (
    <ProjectSection
      section="instructions"
      description="Appended to every agent prompt in this project, on this device."
      savedToken={savedFlash.token}
    >
      <SettingsBlock>
        <div className="relative">
          <Textarea
            aria-label="Agent instructions"
            value={value}
            maxLength={limit}
            disabled={!canEdit}
            placeholder="Prefer Effect Schema over zod. Run bun run test before committing."
            className="min-h-32 resize-y pb-6"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && dirty) {
                event.preventDefault();
                void save();
              }
            }}
          />
          <span
            aria-live="polite"
            className={cn(
              "pointer-events-none absolute right-3 bottom-2 text-[11px] tabular-nums",
              length >= limit
                ? "text-destructive"
                : length >= Math.floor(limit * 0.9)
                  ? "text-warning-foreground"
                  : "text-muted-foreground/70",
            )}
          >
            {length.toLocaleString()} / {limit.toLocaleString()}
          </span>
        </div>
        {dirty ? (
          <div className="mt-3 flex justify-end gap-2">
            <Button size="sm" variant="ghost" disabled={saving} onClick={() => setDraft(null)}>
              Revert
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={!canEdit || saving}
              onClick={() => void save()}
            >
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </SettingsBlock>
    </ProjectSection>
  );
}
