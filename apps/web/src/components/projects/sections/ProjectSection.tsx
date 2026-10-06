import { CheckIcon } from "lucide-react";
import { useCallback, useState, type ReactNode } from "react";

import { cn } from "../../../lib/utils";
import { SettingsSection } from "../../settings/settingsLayout";
import type { ProjectSection as ProjectSectionId } from "../projectsSearch";
import { PROJECT_SECTION_LABELS, projectSectionId } from "./projectSectionTypes";

/**
 * Confirmation for edits that save on their own (no Save button): a token
 * that bumps on every successful write and re-keys the "Saved" tick.
 */
export function useSavedFlash(): { readonly token: number; readonly flash: () => void } {
  const [token, setToken] = useState(0);
  const flash = useCallback(() => setToken((value) => value + 1), []);
  return { token, flash };
}

/** "Saved", rising in and fading out once per save. Announced politely. */
export function SavedTick(props: { readonly token: number; readonly className?: string }) {
  return (
    <span aria-live="polite" className={cn("inline-flex", props.className)}>
      {props.token > 0 ? (
        <span
          key={props.token}
          className="projects-saved-tick inline-flex items-center gap-1 text-[11px] text-muted-foreground"
        >
          <CheckIcon aria-hidden className="size-3 text-success" />
          Saved
        </span>
      ) : null}
    </span>
  );
}

/**
 * One section of a project's page: the settings page's heading and card, an
 * anchor the section navigation and deep links find, and the "Saved" tick
 * for edits that apply immediately.
 */
export function ProjectSection(props: {
  readonly section: ProjectSectionId;
  readonly description?: ReactNode;
  readonly action?: ReactNode;
  /** From `useSavedFlash`; omitted for sections that save with a button. */
  readonly savedToken?: number;
  /** Content that is its own surface (no card). */
  readonly bare?: boolean;
  /** Destructive work: the card takes a faint destructive edge. */
  readonly tone?: "danger";
  readonly children: ReactNode;
}) {
  const hasHeaderAction = props.savedToken !== undefined || props.action !== undefined;
  return (
    <SettingsSection
      id={projectSectionId(props.section)}
      data-project-section={props.section}
      title={PROJECT_SECTION_LABELS[props.section]}
      description={props.description}
      bare={props.bare ?? false}
      className={cn(
        "scroll-mt-8",
        props.tone === "danger" &&
          "[&_[data-slot=settings-card]]:border-destructive/30 dark:[&_[data-slot=settings-card]]:border-destructive/35",
      )}
      headerAction={
        hasHeaderAction ? (
          <>
            {props.savedToken !== undefined ? <SavedTick token={props.savedToken} /> : null}
            {props.action}
          </>
        ) : undefined
      }
    >
      {props.children}
    </SettingsSection>
  );
}
