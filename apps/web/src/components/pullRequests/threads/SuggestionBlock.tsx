import { CheckIcon, CopyIcon, SparklesIcon } from "lucide-react";
import { memo } from "react";

import { useCopyToClipboard } from "../../../hooks/useCopyToClipboard";
import { cn } from "../../../lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";

const ACTION_CLASS =
  "inline-flex h-6 items-center gap-1 rounded-md px-1.5 text-[11px] text-muted-foreground outline-hidden transition-colors duration-(--app-motion-duration-chip) hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50";

/**
 * A host ` ```suggestion ` block drawn as the change it proposes: the lines it
 * replaces (when the thread's hunk still has them) over the suggested lines.
 * The only nested box a thread may contain, so it is a hairline, not a card.
 */
export const SuggestionBlock = memo(function SuggestionBlock(props: {
  readonly lines: ReadonlyArray<string>;
  readonly baseLines: ReadonlyArray<string> | null;
  readonly onApply?: (() => void) | undefined;
  /** Shown instead of applying when hand-offs are unavailable. */
  readonly applyUnavailableReason?: string | undefined;
  readonly className?: string | undefined;
}) {
  const { copyToClipboard, isCopied } = useCopyToClipboard<void>({ timeout: 1600 });
  return (
    <div
      data-review-suggestion
      className={cn("overflow-hidden rounded-md border border-border/60", props.className)}
    >
      <div className="flex h-7 items-center gap-0.5 border-b border-border/60 pr-1 pl-2.5">
        <span className="flex-1 text-[11px] text-muted-foreground">Suggested change</span>
        <button
          type="button"
          className={ACTION_CLASS}
          aria-label={isCopied ? "Copied suggestion" : "Copy suggestion"}
          onClick={() => copyToClipboard(props.lines.join("\n"), undefined)}
        >
          {isCopied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
          {isCopied ? "Copied" : "Copy"}
        </button>
        {props.onApply || props.applyUnavailableReason ? (
          <Tooltip>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className={ACTION_CLASS}
                  disabled={!props.onApply}
                  onClick={props.onApply}
                >
                  <SparklesIcon className="size-3" />
                  Apply with agent
                </button>
              }
            />
            <TooltipPopup side="top" sideOffset={4}>
              {props.onApply
                ? "Open an agent thread on the pull request's branch to apply this"
                : props.applyUnavailableReason}
            </TooltipPopup>
          </Tooltip>
        ) : null}
      </div>
      <div className="overflow-x-auto py-1 font-mono text-[12px] leading-5">
        {(props.baseLines ?? []).map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- suggestion lines are positional
          <SuggestionLine key={`base-${index}`} kind="del" text={line} />
        ))}
        {props.lines.map((line, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- suggestion lines are positional
          <SuggestionLine key={`next-${index}`} kind="add" text={line} />
        ))}
      </div>
    </div>
  );
});

function SuggestionLine(props: { readonly kind: "add" | "del"; readonly text: string }) {
  return (
    <div
      className={cn(
        "flex min-w-max pr-3",
        props.kind === "add"
          ? "bg-[color-mix(in_srgb,var(--background)_90%,var(--success))]"
          : "bg-[color-mix(in_srgb,var(--background)_90%,var(--destructive))]",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "w-6 shrink-0 text-center select-none",
          props.kind === "add" ? "text-success" : "text-destructive",
        )}
      >
        {props.kind === "add" ? "+" : "−"}
      </span>
      <span className="sr-only">{props.kind === "add" ? "Added: " : "Removed: "}</span>
      <span className="whitespace-pre text-foreground/90">{props.text || " "}</span>
    </div>
  );
}
