import { SendIcon } from "lucide-react";

import { cn } from "~/lib/utils";

/**
 * The paper plane on every send button: composer, collapsed composer, side chat.
 * The plane's mass sits up and right of its box (its points average to
 * 13.1, 11 on the 24 grid), so it is shifted toward its tail until its ink is
 * centred in the button. Percentages keep that true at every icon size.
 */
export function SendGlyph({ className }: { className?: string }) {
  return (
    <SendIcon
      aria-hidden="true"
      strokeWidth={2}
      className={cn("size-3.5 translate-x-[-7%] translate-y-[8%]", className)}
    />
  );
}
