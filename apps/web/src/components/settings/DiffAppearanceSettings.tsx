import { CheckIcon } from "lucide-react";
import { useDiffLayout, type DiffRenderMode } from "../../hooks/useDiffLayout";
import { cn } from "../../lib/utils";
import { SettingsSection } from "./settingsLayout";

const LAYOUTS = [
  {
    value: "stacked",
    label: "Unified",
    description: "Removed and added lines together in one column.",
  },
  {
    value: "split",
    label: "Split",
    description: "Compare the original and updated code side by side.",
  },
] as const;

function CodeLine({
  number,
  kind,
  children,
}: {
  number: number;
  kind?: "added" | "removed";
  children: string;
}) {
  return (
    <div
      className="flex whitespace-pre leading-6"
      style={
        kind
          ? {
              backgroundColor: `color-mix(in srgb, var(--background) 92%, var(--${kind === "added" ? "success" : "destructive"}))`,
            }
          : undefined
      }
    >
      <span className="w-7 shrink-0 select-none text-center text-muted-foreground/60">
        {number}
      </span>
      <span
        className="w-4 shrink-0"
        style={{ color: kind === "added" ? "var(--success)" : "var(--destructive)" }}
      >
        {kind === "added" ? "+" : kind === "removed" ? "−" : " "}
      </span>
      <span>{children}</span>
    </div>
  );
}

function DiffPreview({ layout }: { layout: DiffRenderMode }) {
  return (
    <div
      aria-hidden="true"
      className="overflow-hidden rounded-lg border border-border bg-background text-left font-mono text-[10px] text-foreground"
    >
      <div className="flex justify-between border-b border-border bg-muted/30 px-3 py-2">
        <span>greeting.ts</span>
        <span>
          <span className="text-success">+1</span> <span className="text-destructive">−1</span>
        </span>
      </div>
      <div
        className={cn(
          "min-h-32 py-3",
          layout === "split" && "grid grid-cols-2 divide-x divide-border",
        )}
      >
        {layout === "split" ? (
          <>
            <div className="overflow-hidden">
              <CodeLine number={1}>{"// Greeting"}</CodeLine>
              <CodeLine number={2} kind="removed">
                {'hello("world");'}
              </CodeLine>
              <CodeLine number={3}>{""}</CodeLine>
            </div>
            <div className="overflow-hidden">
              <CodeLine number={1}>{"// Greeting"}</CodeLine>
              <CodeLine number={2} kind="added">
                {'hello("Ryco");'}
              </CodeLine>
              <CodeLine number={3}>{""}</CodeLine>
            </div>
          </>
        ) : (
          <div>
            <CodeLine number={1}>{"// Greeting"}</CodeLine>
            <CodeLine number={2} kind="removed">
              {'hello("world");'}
            </CodeLine>
            <CodeLine number={2} kind="added">
              {'hello("Ryco");'}
            </CodeLine>
            <CodeLine number={3}>{""}</CodeLine>
          </div>
        )}
      </div>
    </div>
  );
}

export function DiffAppearanceSettings() {
  const [layout, setLayout] = useDiffLayout();
  return (
    <SettingsSection title="Diff style">
      <p className="px-4 pt-4 text-xs text-muted-foreground">
        Choose how code changes appear in the diff viewer. You can also switch from its toolbar.
      </p>
      <div role="group" aria-label="Diff style" className="grid gap-4 p-4 lg:grid-cols-2">
        {LAYOUTS.map((option) => (
          <button
            key={option.value}
            type="button"
            aria-pressed={layout === option.value}
            aria-label={`${option.label} diff style`}
            onClick={() => setLayout(option.value)}
            className={cn(
              "min-w-0 rounded-xl border p-3 text-left transition-colors focus-visible:outline-2 focus-visible:outline-ring",
              layout === option.value
                ? "border-primary bg-muted/40"
                : "border-border hover:bg-muted/20",
            )}
          >
            <DiffPreview layout={option.value} />
            <span className="mt-3 flex items-center justify-between text-sm font-medium">
              {option.label}
              {layout === option.value && <CheckIcon aria-hidden="true" className="size-4" />}
            </span>
            <span className="mt-1 block text-xs text-muted-foreground">{option.description}</span>
          </button>
        ))}
      </div>
    </SettingsSection>
  );
}
