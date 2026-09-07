import { useState } from "react";
import { GlobeIcon } from "lucide-react";
import { Popover, PopoverPopup, PopoverTrigger } from "../components/ui/popover";
import type { BrowserProject } from "./BrowserPanel";
import { LazyBrowserPanel } from "./LazyBrowserPanel";

/** Mounted only on demand; the popup and workspace reuse the same project tabs. */
export function ProjectBrowserPreview(props: BrowserProject) {
  const [open, setOpen] = useState(false);
  return (
    <div className="phone:hidden">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
          <GlobeIcon className="size-3.5" />
          Live preview
        </PopoverTrigger>
        <PopoverPopup
          side="right"
          align="start"
          className="w-[min(640px,calc(100vw-32px))]"
          viewportClassName="p-0"
        >
          <div
            className="flex h-[min(520px,75vh)] min-h-0 flex-col"
            aria-label="Project live preview"
          >
            {open ? <LazyBrowserPanel {...props} /> : null}
          </div>
        </PopoverPopup>
      </Popover>
    </div>
  );
}
