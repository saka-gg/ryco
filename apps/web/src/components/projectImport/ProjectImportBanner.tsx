import * as Schema from "effect/Schema";
import { XIcon } from "lucide-react";

import { useLocalStorage } from "../../hooks/useLocalStorage";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { openProjectImportDialog, preloadProjectImportDialog } from "./projectImportDialogStore";

export const PROJECT_IMPORT_BANNER_DISMISSED_KEY = "ryco:project-import-banner-dismissed:v1";

/**
 * Offers project import where there are no projects yet. Dismissing it hides
 * it for good on this device; the command palette and Settings still offer
 * the import.
 */
export function ProjectImportBanner(props: { readonly className?: string }) {
  const [dismissed, setDismissed] = useLocalStorage(
    PROJECT_IMPORT_BANNER_DISMISSED_KEY,
    false,
    Schema.Boolean,
  );
  if (dismissed) return null;
  return (
    <div
      role="region"
      aria-label="Import from Codex or Claude Code"
      className={cn(
        "relative rounded-lg border border-border/60 bg-card/40 p-3 pr-8 text-left",
        props.className,
      )}
    >
      <Button
        size="icon-xs"
        variant="ghost"
        aria-label="Dismiss import suggestion"
        className="absolute top-1.5 right-1.5 text-muted-foreground"
        onClick={() => setDismissed(true)}
      >
        <XIcon />
      </Button>
      <p className="text-xs font-medium text-foreground">Coming from Codex or Claude Code?</p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">
        Bring your projects and their conversations over, grouped by folder.
      </p>
      <Button
        size="xs"
        variant="outline"
        className="mt-2"
        onPointerEnter={preloadProjectImportDialog}
        onFocus={preloadProjectImportDialog}
        onClick={() => openProjectImportDialog()}
      >
        Import projects…
      </Button>
    </div>
  );
}
