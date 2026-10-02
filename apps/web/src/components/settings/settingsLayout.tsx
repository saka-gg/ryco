import { useSettingsEditingScope } from "../../settingsTarget";
import { AlertCircleIcon, InfoIcon, TriangleAlertIcon, Undo2Icon } from "lucide-react";
import { type ComponentPropsWithoutRef, type ReactNode, useEffect, useState } from "react";

import { createVisibilityAwarePoller } from "../../lib/visibilityPolling";
import { webAppLifecycle } from "../../platform/appLifecycle";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/**
 * The settings design language, in one place.
 *
 * Every settings panel composes these instead of drawing its own chrome, so a
 * page reads as one system: a quiet heading, one solid card per group, rows
 * divided by hairlines, and nothing nested more than that. Containers cap the
 * user's corner radius — a pill-shaped input is a preference, but a pill-shaped
 * card clips its own content.
 */

/** Card corner radius, capped so a large global radius never clips content. */
export const SETTINGS_CARD_RADIUS_CLASS = "rounded-[min(var(--radius-xl),0.875rem)]";

/** Inline padding every row and block inside a card shares. */
export const SETTINGS_INSET_CLASS = "px-4 sm:px-5";

/** Standard widths for a row's trailing control, so selects line up down a page. */
export const SETTINGS_CONTROL_WIDTH = {
  sm: "w-full sm:w-36",
  md: "w-full sm:w-48",
  lg: "w-full sm:w-64",
} as const;

/** Re-render while visible; refresh once after returning from the background. */
export function useRelativeTimeTick(intervalMs = 1_000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const poller = createVisibilityAwarePoller({
      lifecycle: webAppLifecycle,
      run: () => {
        setNowMs(Date.now());
        return Promise.resolve();
      },
      resolveDelayMs: () => intervalMs,
      runImmediately: false,
    });
    return poller.stop;
  }, [intervalMs]);
  return nowMs;
}

export function SettingsSection({
  title,
  description,
  owner,
  icon,
  headerAction,
  children,
  className,
  bare = false,
  ...sectionProps
}: ComponentPropsWithoutRef<"section"> & {
  title: string;
  description?: ReactNode;
  owner?: "client" | "node";
  icon?: ReactNode;
  headerAction?: ReactNode;
  /** Render children without the card, for content that is its own surface. */
  bare?: boolean;
  children: ReactNode;
}) {
  const editingScope = useSettingsEditingScope();
  if (owner && editingScope !== "all" && editingScope !== owner) return null;
  return (
    <section
      data-settings-section={title}
      {...sectionProps}
      className={cn("min-w-0 scroll-mt-6", className)}
    >
      <div className="mb-2.5 flex min-h-7 items-end justify-between gap-3 px-0.5">
        <div className="min-w-0">
          <h2 className="flex items-center gap-1.5 text-[13px] font-semibold tracking-[-0.005em] text-foreground [&_svg]:size-3.5 [&_svg]:text-muted-foreground">
            {icon}
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
          ) : null}
        </div>
        {headerAction ? (
          <div className="flex shrink-0 items-center gap-1.5">{headerAction}</div>
        ) : null}
      </div>
      {bare ? children : <SettingsCard>{children}</SettingsCard>}
    </section>
  );
}

/** The one card surface settings uses. Solid, hairline-bordered, never glass. */
export function SettingsCard({ className, children, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      data-slot="settings-card"
      {...props}
      className={cn(
        "relative min-w-0 overflow-hidden border border-border/70 bg-card text-card-foreground shadow-xs/5 dark:border-border/60",
        SETTINGS_CARD_RADIUS_CLASS,
        className,
      )}
    >
      {children}
    </div>
  );
}

export function SettingsRow({
  id,
  title,
  owner,
  description,
  scope,
  status,
  resetAction,
  control,
  children,
  className,
}: {
  id?: string;
  title: ReactNode;
  owner?: "client" | "node";
  description?: ReactNode;
  /**
   * Which destination this row writes to. Kept as data for tests and tooling;
   * the destination is shown once by the page, never as a chip on every row.
   */
  scope?: string;
  status?: ReactNode;
  resetAction?: ReactNode;
  control?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const editingScope = useSettingsEditingScope();
  if (owner && editingScope !== "all" && editingScope !== owner) return null;
  return (
    <div
      id={id}
      data-setting-scope={scope}
      data-slot="settings-row"
      className={cn(
        "min-w-0 border-t border-border/60 py-3.5 first:border-t-0",
        SETTINGS_INSET_CLASS,
        className,
      )}
    >
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-center sm:gap-6">
        <div className="min-w-0 flex-1">
          <div className="flex min-h-5 min-w-0 items-center gap-1">
            <h3 className="min-w-0 text-[13px] font-medium leading-5 text-foreground">{title}</h3>
            {resetAction ? (
              <span className="inline-flex shrink-0 items-center">{resetAction}</span>
            ) : null}
          </div>
          {description ? (
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground text-pretty">
              {description}
            </p>
          ) : null}
          {status ? (
            <div className="mt-1.5 text-xs leading-relaxed text-muted-foreground">{status}</div>
          ) : null}
        </div>
        {control ? (
          // Capped so a wide control can never squeeze the label column away.
          <div className="flex min-w-0 shrink-0 flex-wrap items-center gap-2 sm:max-w-[55%] sm:justify-end">
            {control}
          </div>
        ) : null}
      </div>
      {children ? <div className="mt-3 min-w-0">{children}</div> : null}
    </div>
  );
}

/**
 * Free-form content inside a card — lists, forms, previews — with the same
 * inset and hairline as a row, so it never sits flush against the border.
 */
export function SettingsBlock({
  className,
  children,
  flush = false,
  ...props
}: ComponentPropsWithoutRef<"div"> & { flush?: boolean }) {
  return (
    <div
      data-slot="settings-block"
      {...props}
      className={cn(
        "min-w-0 border-t border-border/60 first:border-t-0",
        !flush && cn(SETTINGS_INSET_CLASS, "py-3.5"),
        className,
      )}
    >
      {children}
    </div>
  );
}

const NOTICE_TONE = {
  info: {
    icon: InfoIcon,
    className: "border-info/24 bg-info/6 text-foreground [&_[data-notice-icon]]:text-info",
  },
  warning: {
    icon: TriangleAlertIcon,
    className:
      "border-warning/28 bg-warning/8 text-foreground [&_[data-notice-icon]]:text-warning-foreground",
  },
  error: {
    icon: AlertCircleIcon,
    className:
      "border-destructive/28 bg-destructive/6 text-foreground [&_[data-notice-icon]]:text-destructive-foreground",
  },
} as const;

/** An inline callout for warnings, errors, and one-off explanations. */
export function SettingsNotice({
  tone = "info",
  title,
  children,
  action,
  className,
  role,
}: {
  tone?: keyof typeof NOTICE_TONE;
  title?: ReactNode;
  children?: ReactNode;
  action?: ReactNode;
  className?: string;
  role?: "alert" | "status";
}) {
  const { icon: Icon, className: toneClassName } = NOTICE_TONE[tone];
  return (
    <div
      role={role ?? (tone === "error" ? "alert" : undefined)}
      className={cn(
        "flex min-w-0 items-start gap-2.5 rounded-[min(var(--radius-lg),0.625rem)] border px-3 py-2.5 text-xs leading-relaxed",
        toneClassName,
        className,
      )}
    >
      <Icon data-notice-icon aria-hidden className="mt-px size-3.5 shrink-0" />
      <div className="min-w-0 flex-1 break-words">
        {title ? <p className="font-medium text-foreground">{title}</p> : null}
        {children ? <div className="text-muted-foreground">{children}</div> : null}
      </div>
      {action ? <div className="shrink-0">{action}</div> : null}
    </div>
  );
}

/** A quiet empty state for a card or a list inside one. */
export function SettingsEmpty({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: ReactNode;
  title: ReactNode;
  description?: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col items-center px-6 py-10 text-center [&_svg]:size-5",
        className,
      )}
    >
      {icon ? (
        <div className="mb-3 flex size-9 items-center justify-center rounded-[min(var(--radius-lg),0.625rem)] bg-muted text-muted-foreground">
          {icon}
        </div>
      ) : null}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {description ? (
        <p className="mt-1 max-w-sm text-xs leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

/** A label/control pair for forms laid out inside a SettingsBlock. */
export function SettingsField({
  label,
  description,
  htmlFor,
  children,
  className,
}: {
  label: ReactNode;
  description?: ReactNode;
  htmlFor?: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("grid min-w-0 gap-1.5", className)}>
      <label htmlFor={htmlFor} className="text-xs font-medium text-foreground">
        {label}
      </label>
      {children}
      {description ? (
        <p className="text-[11px] leading-relaxed text-muted-foreground">{description}</p>
      ) : null}
    </div>
  );
}

export function SettingResetButton({
  label,
  onClick,
  tooltip = "Reset to default",
  ariaLabel,
  disabled,
}: {
  label: string;
  onClick: () => void;
  tooltip?: string | undefined;
  ariaLabel?: string | undefined;
  disabled?: boolean | undefined;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={ariaLabel ?? `Reset ${label} to default`}
            disabled={disabled}
            className="size-5 rounded-sm p-0 text-muted-foreground hover:text-foreground sm:size-5"
            onClick={(event) => {
              event.stopPropagation();
              onClick();
            }}
          >
            <Undo2Icon className="size-3" />
          </Button>
        }
      />
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}

/**
 * Panel-level status and actions (refresh, pause) without a second page title:
 * the host already names the section, so a panel only adds what it knows.
 */
export function SettingsToolbar({
  children,
  actions,
  className,
}: {
  children?: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      data-slot="settings-toolbar"
      className={cn(
        "-mb-3 flex min-h-7 flex-wrap items-center justify-between gap-x-4 gap-y-2",
        className,
      )}
    >
      <div className="min-w-0 text-xs text-muted-foreground">{children}</div>
      {actions ? <div className="flex shrink-0 items-center gap-1.5">{actions}</div> : null}
    </div>
  );
}

/**
 * The stack of sections a panel renders. Hosts own the scroll container and
 * the page gutter; panels only own their vertical rhythm.
 */
export function SettingsPageContainer({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cn("flex w-full min-w-0 flex-col gap-9", className)}>{children}</div>;
}
