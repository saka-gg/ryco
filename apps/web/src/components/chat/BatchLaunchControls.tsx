import type { ModelSelection } from "@ryco/contracts";
import { BATCH_LAUNCH_MAX_TARGETS, batchSelectionKey } from "@ryco/client-runtime/state/composer";

export function BatchLaunchControls(props: {
  selections: readonly ModelSelection[];
  disabled: boolean;
  reason: string | null;
  onAdd: () => void;
  onRemove: (key: string) => void;
}) {
  return (
    <section aria-label="Compare models" className="mx-auto mb-2 w-full max-w-208 px-4 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="rounded border px-2 py-1 disabled:opacity-40"
          disabled={props.disabled || props.selections.length >= BATCH_LAUNCH_MAX_TARGETS}
          onClick={props.onAdd}
        >
          {props.selections.length === 0 ? "Compare models…" : "Add current selection"}
        </button>
        {props.selections.map((selection) => (
          <button
            type="button"
            key={batchSelectionKey(selection)}
            disabled={props.disabled}
            onClick={() => props.onRemove(batchSelectionKey(selection))}
            aria-label={`Remove ${selection.instanceId} ${selection.model} ${selection.options?.map((option) => `${option.id} ${option.value}`).join(" ") ?? ""}`}
            className="rounded bg-muted px-2 py-1 text-left disabled:opacity-40"
          >
            {selection.instanceId} · {selection.model}
            {selection.options?.map((option) => ` · ${option.id}: ${option.value}`).join("")} ×
          </button>
        ))}
      </div>
      {props.selections.length > 0 && (
        <p className="mt-1 text-muted-foreground">
          {props.reason ??
            (props.selections.length < 2
              ? "Choose another provider, model or effort in the model picker, then add it here."
              : `Send launches ${props.selections.length} isolated worktrees with the same prompt and context. Up to 2 launch at once.`)}
        </p>
      )}
    </section>
  );
}
