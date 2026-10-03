import type {
  SourceControlChangeRequestMergeMethod,
  SourceControlChangeRequestStack,
} from "@ryco/contracts";
import { useMemo, useState, type RefObject } from "react";

import { cn } from "../../../lib/utils";
import { useMergeChangeRequestMutation } from "../../../rpc/useSourceControl";
import { pullRequestMergeConfirmation } from "../../projectExplorer/pullRequestStack.logic";
import { Button } from "../../ui/button";
import { Checkbox } from "../../ui/checkbox";
import { Popover, PopoverDescription, PopoverPopup, PopoverTitle } from "../../ui/popover";
import { rovingRadioGroup } from "../../ui/roving-radio-group";
import { Spinner } from "../../ui/spinner";
import { stackedThreadToast, toastManager } from "../../ui/toast";
import { usePullRequestSelection, usePullRequestsPage } from "../PullRequestsPageContext";
import { FACT_TONE_TEXT } from "./FactGlyph";
import { isHeadMovedError, MERGE_METHOD_LABEL, mergeMethodOptions } from "./mergeFacts.logic";
import { StackBaseFoot, SpineCell, StackMark, useStackSpine } from "./StackLayerList";
import {
  defaultMergeThroughLayer,
  stackLayerWord,
  stackMergeThroughPlan,
} from "./stackFacts.logic";
import { useMergeModel } from "./useMergeModel";

const EMPTY_STACK: SourceControlChangeRequestStack = {
  number: 1,
  size: 1,
  position: 1,
  baseRefName: "main",
  entries: [],
};

const METHOD_SHORT: Record<SourceControlChangeRequestMergeMethod, string> = {
  squash: "Squash",
  rebase: "Rebase",
  merge: "Merge commit",
};

/**
 * Pick the layer to merge through: every open layer from the base up to it
 * lands in one go. The spine lights up from the base to the picked layer;
 * layers that cannot land are disabled with the reason.
 */
export function MergeThroughPopover(props: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly anchor: RefObject<Element | null>;
  /** Layer to open on; falls back to the highest layer that can land. */
  readonly initialThrough: number | null;
  readonly side?: "bottom" | "left" | "top" | "right";
  readonly align?: "start" | "center" | "end";
}) {
  const model = useMergeModel();
  const stack = model?.detail.stack ?? null;
  return (
    <Popover open={props.open && stack !== null} onOpenChange={props.onOpenChange}>
      <PopoverPopup
        anchor={props.anchor}
        side={props.side ?? "bottom"}
        align={props.align ?? "end"}
        className="w-80"
        viewportClassName="p-0 [--viewport-inline-padding:0px]"
      >
        {model && stack ? (
          <MergeThroughForm
            key={String(props.open)}
            initialThrough={props.initialThrough}
            onDone={() => props.onOpenChange(false)}
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

function MergeThroughForm(props: {
  readonly initialThrough: number | null;
  readonly onDone: () => void;
}) {
  const model = useMergeModel();
  const selection = usePullRequestSelection();
  const { capabilities } = usePullRequestsPage().model;
  const stack = model?.detail.stack ?? null;
  const [picked, setPicked] = useState<number | null>(() =>
    stack ? defaultMergeThroughLayer(stack, props.initialThrough ?? selection.number) : null,
  );
  // Keep the pick valid when the stack refreshes underneath the open picker.
  const through =
    stack &&
    picked !== null &&
    !stack.entries.some((entry) => entry.number === picked && entry.state !== "merged")
      ? defaultMergeThroughLayer(stack, null)
      : picked;
  const [deleteBranches, setDeleteBranches] = useState(model?.deleteBranch ?? false);
  const merge = useMergeChangeRequestMutation({
    environmentId: selection.mutationTarget.environmentId,
    cwd: selection.mutationTarget.cwd,
    reference: String(through ?? selection.number),
  });
  const spine = useStackSpine(stack ?? EMPTY_STACK, through);
  const plan = useMemo(
    () => (stack && through !== null ? stackMergeThroughPlan(stack, through) : null),
    [stack, through],
  );
  if (!model || !stack) return null;
  const method = model.method;
  const throughEntry = stack.entries.find((entry) => entry.number === through) ?? null;
  const count = plan?.layers.length ?? 0;
  const confirmation =
    throughEntry !== null
      ? pullRequestMergeConfirmation({
          selectedNumber: throughEntry.number,
          mergeMethod: method,
          stack: { ...stack, position: throughEntry.position },
        })
      : null;
  const blocked = plan === null || plan.blocker !== null || count === 0;
  // Merged layers are shown on the spine but are not choices.
  const layerPlans = new Map(
    spine.rows
      .filter(({ entry }) => entry.state !== "merged")
      .map(({ entry }) => [entry.number, stackMergeThroughPlan(stack, entry.number)] as const),
  );
  const layerGroup = rovingRadioGroup({
    options: [...layerPlans].map(([number, layerPlan]) => ({
      value: String(number),
      disabled: layerPlan.blocker !== null,
    })),
    value: through === null ? null : String(through),
    onChange: (value) => setPicked(Number(value)),
  });

  const submit = async () => {
    if (blocked || throughEntry === null) return;
    try {
      const result = await merge.mutateAsync({
        mergeMethod: method,
        ...(capabilities.merge.deleteBranch ? { deleteBranch: deleteBranches } : {}),
        // Only the selected layer's head is known here; other layers merge as the host sees them.
        ...(throughEntry.number === selection.number && capabilities.merge.expectedHeadSha
          ? { expectedHeadSha: selection.headSha }
          : {}),
      });
      if (result.outcome === "enqueued") {
        toastManager.add(
          stackedThreadToast({
            type: "info",
            title: "Queued to merge",
            description: `${count === 1 ? "#" + throughEntry.number : `${count} pull requests`} merge when the queue reaches ${count === 1 ? "it" : "them"}.`,
          }),
        );
      }
      props.onDone();
    } catch (error) {
      toastManager.add(
        stackedThreadToast(
          isHeadMovedError(error)
            ? {
                type: "warning",
                title: "New commits were pushed",
                description: "Review the latest changes, then try again.",
              }
            : {
                type: "error",
                title: count > 1 ? "Couldn’t merge the stack" : "Couldn’t merge",
                description: error instanceof Error ? error.message : String(error),
              },
        ),
      );
    }
  };

  return (
    <div className="flex flex-col">
      <div className="px-4 pt-3.5 pb-2">
        <PopoverTitle className="text-[13px] font-medium">
          Merge into <span className="font-mono text-xs">{stack.baseRefName}</span>
        </PopoverTitle>
      </div>
      <div
        role="radiogroup"
        aria-label="Merge through"
        className="flex flex-col px-2"
        onKeyDown={layerGroup.onKeyDown}
      >
        {spine.rows.map(({ entry, above, below }) => {
          const word = stackLayerWord(entry);
          const layerPlan = layerPlans.get(entry.number) ?? null;
          const reason = layerPlan?.blocker ?? null;
          const disabled = entry.state === "merged" || reason !== null;
          // The state word already explains a layer that blocks itself; a
          // layer held back by one beneath it names that layer instead.
          const heldBy =
            layerPlan?.blockedBy !== null &&
            layerPlan?.blockedBy !== undefined &&
            layerPlan.blockedBy !== entry.number
              ? layerPlan.blockedBy
              : null;
          const checked = entry.number === through;
          return (
            <label
              key={entry.number}
              title={reason ?? undefined}
              className={cn(
                "flex min-h-7 items-center gap-2 rounded-md px-1.5 transition-colors duration-(--app-motion-duration-chip)",
                disabled ? "cursor-default" : "cursor-pointer hover:bg-accent/50",
                checked && "bg-accent",
              )}
            >
              <SpineCell above={above} below={below}>
                <StackMark tone={word.tone} filled={entry.number === selection.number} />
              </SpineCell>
              <span className="flex min-w-0 flex-1 flex-col py-1">
                <span className="flex min-w-0 items-baseline gap-1.5">
                  <span className="shrink-0 text-xs text-muted-foreground tabular-nums">
                    #{entry.number}
                  </span>
                  <span
                    className={cn(
                      "min-w-0 truncate text-[13px]",
                      disabled ? "text-muted-foreground" : "text-foreground",
                    )}
                  >
                    {entry.title}
                  </span>
                </span>
                {heldBy !== null ? (
                  <span className="truncate text-[11px] text-muted-foreground">
                    Held by #{heldBy}
                  </span>
                ) : null}
              </span>
              <span className={cn("shrink-0 text-xs", FACT_TONE_TEXT[word.tone])}>{word.text}</span>
              {entry.state === "merged" ? (
                <span className="size-3.5 shrink-0" />
              ) : (
                <button
                  {...layerGroup.radio(String(entry.number))}
                  aria-label={`Merge through #${entry.number}`}
                  className="relative inline-flex size-3.5 shrink-0 items-center justify-center rounded-full border border-input bg-background outline-none transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring data-checked:border-foreground data-disabled:opacity-40"
                >
                  {checked ? (
                    <span aria-hidden className="block size-1.5 rounded-full bg-foreground" />
                  ) : null}
                </button>
              )}
            </label>
          );
        })}
        <StackBaseFoot baseRefName={stack.baseRefName} above={spine.footAbove} />
      </div>
      <div className="mt-2 flex flex-col gap-3 border-t border-border/60 px-4 pt-3 pb-4">
        <MethodSegment
          value={method}
          options={mergeMethodOptions(model.detail, capabilities.merge.methods)}
          onChange={model.setMethod}
        />
        {capabilities.merge.deleteBranch ? (
          <label className="flex cursor-pointer items-center gap-2 text-xs text-foreground/85">
            <Checkbox
              checked={deleteBranches}
              onCheckedChange={(checked) => setDeleteBranches(checked === true)}
            />
            Delete merged branches
          </label>
        ) : null}
        {confirmation ? (
          <PopoverDescription className="text-xs leading-relaxed text-muted-foreground">
            {plan?.blocker ?? confirmation.description}
          </PopoverDescription>
        ) : null}
        <Button
          size="sm"
          className="h-8 w-full text-[13px]"
          disabled={blocked || merge.isPending}
          onClick={() => void submit()}
        >
          {merge.isPending ? <Spinner className="size-3.5" /> : null}
          {merge.isPending
            ? "Merging…"
            : `Merge ${count} ${count === 1 ? "pull request" : "pull requests"}`}
        </Button>
      </div>
    </div>
  );
}

function MethodSegment(props: {
  readonly value: SourceControlChangeRequestMergeMethod;
  readonly options: ReturnType<typeof mergeMethodOptions>;
  readonly onChange: (method: SourceControlChangeRequestMergeMethod) => void;
}) {
  const group = rovingRadioGroup({
    options: props.options.map((option) => ({
      value: option.method,
      disabled: option.disabledReason !== null,
    })),
    value: props.value,
    onChange: props.onChange,
  });
  return (
    <div
      role="radiogroup"
      aria-label="Merge method"
      className="flex items-center gap-0.5"
      onKeyDown={group.onKeyDown}
    >
      {props.options.map((option) => {
        const selected = option.method === props.value;
        return (
          <button
            key={option.method}
            {...group.radio(option.method)}
            title={option.disabledReason ?? MERGE_METHOD_LABEL[option.method]}
            className={cn(
              "h-6 rounded-md px-2 text-xs outline-hidden transition-colors duration-(--app-motion-duration-chip) focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-45",
              selected
                ? "bg-accent text-foreground"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground",
            )}
          >
            {METHOD_SHORT[option.method]}
          </button>
        );
      })}
    </div>
  );
}
