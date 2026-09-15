import { useState } from "react";
import { Schema } from "effect";
import {
  AgentControlAutomationDefinition,
  AGENT_CONTROL_AUTOMATION_PROMPT_MAX_CHARS,
  AGENT_CONTROL_TITLE_MAX_CHARS,
  ProviderInstanceId,
  type AgentControlAutomation,
  type AgentControlAutomationId,
  type ProjectId,
  type ServerProvider,
  type ModelSelection,
} from "@ryco/contracts";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

function localDate(iso: string) {
  const date = new Date(iso);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
}
const fieldClass = "w-full rounded-md border border-input bg-background px-3 py-2 text-xs";
export function AutomationEditor(props: {
  projectId: ProjectId;
  automationId: AgentControlAutomationId;
  automation: AgentControlAutomation | null;
  providers: ReadonlyArray<ServerProvider>;
  disabled: boolean;
  onSave: (definition: AgentControlAutomationDefinition) => Promise<void>;
  onCancel: () => void;
}) {
  const original = props.automation?.definition;
  const [timeZone] = useState(() => new Intl.DateTimeFormat().resolvedOptions().timeZone);
  const [title, setTitle] = useState(original?.execution.title ?? "");
  const [prompt, setPrompt] = useState(original?.execution.prompt ?? "");
  const [selection, setSelection] = useState<ModelSelection>(
    original?.execution.modelSelection ?? {
      instanceId: ProviderInstanceId.make("unselected"),
      model: "",
    },
  );
  const [kind, setKind] = useState<"once" | "fixed-interval">(original?.schedule.kind ?? "once");
  const [start, setStart] = useState(() =>
    localDate(
      original
        ? original.schedule.kind === "once"
          ? original.schedule.runAt
          : original.schedule.startsAt
        : new Date(Date.now() + 3600000).toISOString(),
    ),
  );
  const [end, setEnd] = useState(() =>
    localDate(
      original?.schedule.kind === "fixed-interval"
        ? original.schedule.endsAt
        : new Date(Date.now() + 7 * 86400000).toISOString(),
    ),
  );
  const [interval, setInterval] = useState(
    original?.schedule.kind === "fixed-interval" ? original.schedule.intervalMs / 60000 : 60,
  );
  const [enabled, setEnabled] = useState(original?.enabled ?? true);
  const [runtimeMode, setRuntimeMode] = useState(
    original?.execution.runtimeMode ?? "approval-required",
  );
  const [envMode, setEnvMode] = useState(original?.execution.envMode ?? "worktree");
  const [baseRef, setBaseRef] = useState(original?.execution.baseRef ?? "");
  const [error, setError] = useState<string | null>(null);
  const provider = props.providers.find((p) => p.instanceId === selection.instanceId);
  const model = provider?.models.find((m) => m.slug === selection.model);
  const unavailable =
    !provider || !provider.enabled || provider.status !== "ready" || !provider.installed || !model;
  const submit = async () => {
    try {
      setError(null);
      const first = new Date(start).toISOString();
      const last = kind === "once" ? first : new Date(end).toISOString();
      if (
        Date.parse(first) <= Date.now() ||
        Date.parse(last) < Date.parse(first) ||
        Date.parse(last) > Date.now() + 90 * 86400000 ||
        (kind === "fixed-interval" && (!Number.isInteger(interval) || interval < 15))
      ) {
        setError(
          "Choose a future start, an end within 90 days, and an interval of at least 15 minutes.",
        );
        return;
      }
      const definition = Schema.decodeUnknownSync(AgentControlAutomationDefinition)({
        enabled,
        execution: {
          projectId: props.projectId,
          title,
          prompt,
          modelSelection: selection,
          runtimeMode,
          envMode,
          ...(baseRef.trim() ? { baseRef: baseRef.trim() } : {}),
        },
        schedule:
          kind === "once"
            ? { kind, runAt: first }
            : { kind, startsAt: first, endsAt: last, intervalMs: interval * 60000 },
      });
      await props.onSave(definition);
    } catch {
      setError("Check the title, prompt and schedule fields.");
    }
  };
  return (
    <form
      className="space-y-3 border-b border-border pb-5"
      aria-label="Schedule editor"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <h3 className="text-sm font-semibold">{original ? "Edit schedule" : "New schedule"}</h3>
      <fieldset className="space-y-3" disabled={props.disabled}>
        <label className="block space-y-1 text-xs">
          Title
          <Input
            aria-label="Title"
            value={title}
            required
            maxLength={AGENT_CONTROL_TITLE_MAX_CHARS}
            onChange={(e) => setTitle(e.target.value)}
          />
        </label>
        <label className="block space-y-1 text-xs">
          Task prompt
          <textarea
            aria-label="Task prompt"
            className={fieldClass}
            rows={4}
            required
            maxLength={AGENT_CONTROL_AUTOMATION_PROMPT_MAX_CHARS}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
          />
        </label>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs">
            Provider instance
            <select
              aria-label="Provider instance"
              className={fieldClass}
              value={provider ? selection.instanceId : ""}
              onChange={(e) =>
                setSelection({ instanceId: ProviderInstanceId.make(e.target.value), model: "" })
              }
              required
            >
              <option value="" disabled>
                Select instance
              </option>
              {props.providers.map((p) => (
                <option
                  key={p.instanceId}
                  value={p.instanceId}
                  disabled={!p.enabled || p.status !== "ready"}
                >
                  {p.displayName} ({p.instanceId})
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1 text-xs">
            Model
            <select
              aria-label="Model"
              className={fieldClass}
              value={model ? selection.model : ""}
              onChange={(e) =>
                setSelection({ instanceId: selection.instanceId, model: e.target.value })
              }
              required
            >
              <option value="" disabled>
                Select model
              </option>
              {provider?.models.map((m) => (
                <option key={m.slug} value={m.slug}>
                  {m.name}
                </option>
              ))}
            </select>
          </label>
        </div>
        {model?.capabilities?.optionDescriptors?.map((option) => (
          <label key={option.id} className="block space-y-1 text-xs">
            {option.label}
            <select
              aria-label={option.label}
              className={fieldClass}
              value={String(selection.options?.find((v) => v.id === option.id)?.value ?? "")}
              onChange={(e) =>
                setSelection({
                  ...selection,
                  options: [
                    ...(selection.options ?? []).filter((v) => v.id !== option.id),
                    ...(e.target.value === ""
                      ? []
                      : [
                          {
                            id: option.id,
                            value:
                              option.type === "boolean"
                                ? e.target.value === "true"
                                : e.target.value,
                          },
                        ]),
                  ],
                })
              }
            >
              <option value="">Provider default</option>
              {option.type === "boolean" ? (
                <>
                  <option value="true">On</option>
                  <option value="false">Off</option>
                </>
              ) : (
                option.options.map((o) => (
                  <option key={o.id} value={o.id}>
                    {o.label}
                  </option>
                ))
              )}
            </select>
          </label>
        ))}
        {unavailable && (
          <p className="text-xs text-muted-foreground">
            Select an available provider instance and model. Saved selections are never silently
            replaced.
          </p>
        )}
        <label className="block space-y-1 text-xs">
          Schedule
          <select
            aria-label="Schedule"
            className={fieldClass}
            value={kind}
            onChange={(e) => setKind(e.target.value as typeof kind)}
          >
            <option value="once">Once</option>
            <option value="fixed-interval">Fixed interval</option>
          </select>
        </label>
        <label className="block space-y-1 text-xs">
          Starts at
          <input
            aria-label="Starts at"
            className={fieldClass}
            type="datetime-local"
            required
            value={start}
            onChange={(e) => setStart(e.target.value)}
          />
        </label>
        {kind === "fixed-interval" && (
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1 text-xs">
              Every (minutes)
              <input
                aria-label="Every (minutes)"
                className={fieldClass}
                type="number"
                min={15}
                required
                value={interval}
                onChange={(e) => setInterval(Number(e.target.value))}
              />
            </label>
            <label className="space-y-1 text-xs">
              Ends at
              <input
                aria-label="Ends at"
                className={fieldClass}
                type="datetime-local"
                required
                value={end}
                onChange={(e) => setEnd(e.target.value)}
              />
            </label>
          </div>
        )}
        <p className="text-xs text-muted-foreground">
          Times use {timeZone}. Intervals are elapsed time; missed occurrences coalesce into one
          approval.
        </p>
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1 text-xs">
            Workspace
            <select
              aria-label="Workspace"
              className={fieldClass}
              value={envMode}
              onChange={(e) => setEnvMode(e.target.value as typeof envMode)}
            >
              <option value="worktree">Isolated worktree</option>
              <option value="local">Shared checkout</option>
            </select>
          </label>
          <label className="space-y-1 text-xs">
            Permissions
            <select
              aria-label="Permissions"
              className={fieldClass}
              value={runtimeMode}
              onChange={(e) => setRuntimeMode(e.target.value as typeof runtimeMode)}
            >
              <option value="approval-required">Require approvals</option>
              <option value="auto-accept-edits">Accept edits</option>
              <option value="auto">Auto</option>
              <option value="full-access">Full access</option>
            </select>
          </label>
        </div>
        <label className="block space-y-1 text-xs">
          Base ref (optional)
          <Input
            aria-label="Base ref (optional)"
            value={baseRef}
            maxLength={256}
            onChange={(e) => setBaseRef(e.target.value)}
            placeholder="HEAD"
          />
        </label>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          Enable after schedule approval
        </label>
        <p className="text-xs text-muted-foreground">
          Each occurrence still needs its own approval. No automatic retries or result-based
          stopping.
        </p>
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        <div className="flex gap-2">
          <Button size="sm" type="submit" disabled={unavailable}>
            Review schedule
          </Button>
          <Button size="sm" variant="ghost" type="button" onClick={props.onCancel}>
            Discard edit
          </Button>
        </div>
      </fieldset>
    </form>
  );
}
