import type { CSSProperties } from "react";
import { materializeTokens, resolveTokens } from "../../themes/registry";
import type { ThemeDefinition, ThemeVariant } from "../../themes/types";

/** A miniature workspace scoped to its own tokens, independent of the active theme. */
export function ThemePreview({
  theme,
  variant,
  compact = false,
}: {
  theme: ThemeDefinition;
  variant: ThemeVariant;
  compact?: boolean;
}) {
  const style = Object.fromEntries(
    Object.entries(materializeTokens(resolveTokens(theme, variant))).map(([key, value]) => [
      `--${key}`,
      value,
    ]),
  ) as CSSProperties;
  return (
    <div
      aria-hidden="true"
      style={style}
      className="w-full overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--background)] text-[var(--foreground)]"
    >
      <div className="flex aspect-[16/9] text-[9px] leading-relaxed">
        <div className="flex w-[26%] flex-col gap-2 border-r border-[var(--sidebar-border)] bg-[var(--sidebar)] p-[4%]">
          <span className="font-semibold">Ryco</span>
          <span className="h-1.5 w-4/5 rounded bg-[var(--muted-foreground)] opacity-40" />
          <span className="h-3 rounded bg-[var(--sidebar-accent)]" />
          <span className="h-1.5 w-3/4 rounded bg-[var(--muted-foreground)] opacity-25" />
          <span className="h-1.5 w-4/5 rounded bg-[var(--muted-foreground)] opacity-25" />
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-2 p-[4%]">
          {compact ? (
            <div className="h-3 w-2/3 shrink-0 self-end rounded bg-[var(--secondary)]" />
          ) : (
            <div className="self-end rounded bg-[var(--secondary)] px-2 py-1">
              Build something great
            </div>
          )}
          <div className="h-1.5 w-4/5 rounded bg-[var(--muted-foreground)] opacity-40" />
          {compact ? (
            <div className="h-1.5 w-2/3 rounded bg-[var(--muted-foreground)] opacity-25" />
          ) : (
            <div className="rounded border border-[var(--border)] bg-[var(--card)] p-2 font-mono">
              <span style={{ color: "var(--info)" }}>const </span>theme ={" "}
              <span style={{ color: "var(--success)" }}>"ryco"</span>;<br />
              <span style={{ color: "var(--muted-foreground)" }}>{"// Make it yours"}</span>
            </div>
          )}
          <div className="mt-auto flex items-center justify-between rounded-md border border-[var(--input)] px-2 py-1.5">
            {compact ? (
              <span className="h-1 w-1/2 rounded bg-[var(--muted-foreground)] opacity-30" />
            ) : (
              <span style={{ color: "var(--muted-foreground)" }}>Ask anything…</span>
            )}
            <span className="size-3 rounded-full bg-[var(--primary)]" />
          </div>
        </div>
      </div>
      <div className="flex h-2">
        {["sidebar", "background", "primary", "info", "success", "warning", "destructive"].map(
          (token) => (
            <span key={token} className="flex-1" style={{ backgroundColor: `var(--${token})` }} />
          ),
        )}
      </div>
    </div>
  );
}
