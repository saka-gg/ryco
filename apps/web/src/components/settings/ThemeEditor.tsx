"use client";

import { XIcon } from "lucide-react";
import { useEffect, useMemo, useState } from "react";

import { cn } from "../../lib/utils";
import { DEFAULT_THEME } from "../../themes/builtin";
import {
  applyThemeToDocument,
  isValidColorValue,
  isValidTheme,
  isValidTokenValue,
  materializeTokenValue,
  parseLength,
  SUPPORTED_LENGTH_UNITS,
  type SupportedLengthUnit,
} from "../../themes/registry";
import {
  getTokenKind,
  THEME_TOKEN_NAMES,
  type ThemeDefinition,
  type ThemeTokenKind,
  type ThemeTokenName,
  type ThemeTokens,
  type ThemeVariant,
} from "../../themes/types";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { SettingsSelect } from "./SettingsSelect";
import { Button } from "../ui/button";
import { ColorPicker } from "../ui/color-picker";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

type Mode = "form" | "json";

type TokenCategory = {
  title: string;
  tokens: ReadonlyArray<ThemeTokenName>;
};

const TOKEN_CATEGORIES: ReadonlyArray<TokenCategory> = [
  {
    title: "Surfaces",
    tokens: [
      "background",
      "app-chrome-background",
      "foreground",
      "card",
      "card-foreground",
      "popover",
      "popover-foreground",
    ],
  },
  {
    title: "Brand & focus",
    tokens: ["primary", "primary-foreground", "ring"],
  },
  {
    title: "Neutrals",
    tokens: [
      "secondary",
      "secondary-foreground",
      "muted",
      "muted-foreground",
      "accent",
      "accent-foreground",
    ],
  },
  {
    title: "Status",
    tokens: [
      "destructive",
      "destructive-foreground",
      "info",
      "info-foreground",
      "success",
      "success-foreground",
      "warning",
      "warning-foreground",
    ],
  },
  {
    title: "Borders & inputs",
    tokens: ["border", "input"],
  },
  {
    title: "Scrollbars",
    tokens: [
      "scrollbar-thumb",
      "scrollbar-thumb-hover",
      "scrollbar-thumb-thin",
      "scrollbar-thumb-thin-hover",
    ],
  },
];

const KNOWN_TOKEN_SET = new Set<string>(THEME_TOKEN_NAMES);

let probeEl: HTMLDivElement | null = null;
let probeCanvas: HTMLCanvasElement | null = null;

function deriveHex(value: string): string {
  if (typeof document === "undefined" || typeof document.body === "undefined" || !value) {
    return "#000000";
  }
  if (!probeEl) {
    probeEl = document.createElement("div");
    probeEl.style.position = "absolute";
    probeEl.style.visibility = "hidden";
    probeEl.style.pointerEvents = "none";
    document.body.append(probeEl);
  }
  probeEl.style.color = "";
  probeEl.style.color = value;
  const computed = getComputedStyle(probeEl).color;
  if (!probeCanvas) probeCanvas = document.createElement("canvas");
  probeCanvas.width = 1;
  probeCanvas.height = 1;
  const ctx = probeCanvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return "#000000";
  ctx.clearRect(0, 0, 1, 1);
  try {
    ctx.fillStyle = computed;
  } catch {
    return "#000000";
  }
  ctx.fillRect(0, 0, 1, 1);
  const pixel = ctx.getImageData(0, 0, 1, 1).data;
  return `#${[pixel[0], pixel[1], pixel[2]]
    .map((c) => (c ?? 0).toString(16).padStart(2, "0"))
    .join("")}`;
}

export function setTokenValue(
  theme: ThemeDefinition,
  variant: ThemeVariant,
  token: ThemeTokenName,
  value: string,
): ThemeDefinition {
  const current: ThemeTokens = { ...theme[variant] };
  if (value.length === 0) delete current[token];
  else current[token] = value;
  if (variant === "light") return { ...theme, light: current };
  return { ...theme, dark: current };
}

export function setThemeName(theme: ThemeDefinition, name: string): ThemeDefinition {
  return { ...theme, name };
}

export function setThemeDescription(theme: ThemeDefinition, description: string): ThemeDefinition {
  const next: ThemeDefinition = { ...theme };
  if (description.length === 0) delete next.description;
  else next.description = description;
  return next;
}

function isSupportedUnit(unit: string): unit is SupportedLengthUnit {
  return (SUPPORTED_LENGTH_UNITS as ReadonlyArray<string>).includes(unit);
}

export type ThemeEditorProps = {
  source: ThemeDefinition;
  draft: ThemeDefinition;
  onDraftChange: (next: ThemeDefinition) => void;
  onSave: () => void;
  onCancel: () => void;
  resolvedVariant: ThemeVariant;
};

export function ThemeEditor({
  source,
  draft,
  onDraftChange,
  onSave,
  onCancel,
  resolvedVariant,
}: ThemeEditorProps) {
  const [mode, setMode] = useState<Mode>("form");
  const [variant, setVariant] = useState<ThemeVariant>(resolvedVariant);
  const [jsonText, setJsonText] = useState(() => JSON.stringify(draft, null, 2));
  const [jsonError, setJsonError] = useState<string | null>(null);
  const [discardOpen, setDiscardOpen] = useState(false);

  const dirty = useMemo(() => JSON.stringify(source) !== JSON.stringify(draft), [source, draft]);

  useEffect(() => {
    applyThemeToDocument(draft);
  }, [draft, resolvedVariant]);

  useEffect(() => {
    if (mode === "form") setJsonText(JSON.stringify(draft, null, 2));
  }, [draft, mode]);

  const handleNameChange = (value: string) => {
    onDraftChange(setThemeName(draft, value));
  };

  const handleDescriptionChange = (value: string) => {
    onDraftChange(setThemeDescription(draft, value));
  };

  const handleTokenChange = (token: ThemeTokenName, value: string) => {
    onDraftChange(setTokenValue(draft, variant, token, value));
  };

  const handleJsonChange = (value: string) => {
    setJsonText(value);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch (error) {
      setJsonError(error instanceof Error ? error.message : "Invalid JSON");
      return;
    }
    if (!isValidTheme(parsed)) {
      setJsonError("Invalid theme schema. Need string id/name and string-only light/dark tokens.");
      return;
    }
    setJsonError(null);
    onDraftChange(parsed);
  };

  const handleCancel = () => {
    if (dirty) {
      setDiscardOpen(true);
      return;
    }
    onCancel();
  };

  const variantTokens: ThemeTokens = (variant === "dark" ? draft.dark : draft.light) ?? {};
  const inheritedTokens: ThemeTokens = useMemo(
    () => (variant === "dark" ? DEFAULT_THEME.dark : DEFAULT_THEME.light) ?? {},
    [variant],
  );
  const unknownTokenEntries = Object.entries(variantTokens).filter(
    ([token]) => !KNOWN_TOKEN_SET.has(token),
  );

  const hasInvalidValueIn = (tokens: ThemeTokens | undefined): boolean =>
    Object.entries(tokens ?? {}).some(([token, value]) => {
      if (typeof value !== "string" || value.length === 0) return false;
      const kind = getTokenKind(token);
      if (!kind) return false;
      return !isValidTokenValue(kind, value);
    });
  const hasInvalidValue = hasInvalidValueIn(draft.light) || hasInvalidValueIn(draft.dark);
  const saveDisabled = jsonError !== null || draft.name.trim().length === 0 || hasInvalidValue;

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2 border-b border-border/60 bg-muted/40 px-4 py-2.5 sm:px-5">
        <span className="text-xs text-muted-foreground">Editing</span>
        <span className="truncate text-[13px] font-medium text-foreground" title={draft.name}>
          {draft.name || "Untitled"}
        </span>
        {dirty ? (
          <Badge size="sm" variant="warning">
            Unsaved
          </Badge>
        ) : null}
        <div className="ms-auto flex items-center gap-2">
          <Button size="xs" variant="ghost" onClick={handleCancel}>
            Cancel
          </Button>
          <Button size="xs" onClick={onSave} disabled={saveDisabled}>
            Save
          </Button>
        </div>
      </div>

      <div className="px-4 py-4 sm:px-5">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <ToggleGroup
            value={[mode]}
            variant="outline"
            size="sm"
            onValueChange={(values) => {
              const next = values[0];
              if (next === "form" || next === "json") setMode(next);
            }}
          >
            <Toggle value="form" aria-label="Form editor" className="px-3 sm:px-3">
              Form
            </Toggle>
            <Toggle value="json" aria-label="JSON editor" className="px-3 sm:px-3">
              JSON
            </Toggle>
          </ToggleGroup>
          <ToggleGroup
            value={[variant]}
            variant="outline"
            size="sm"
            onValueChange={(values) => {
              const next = values[0];
              if (next === "light" || next === "dark") setVariant(next);
            }}
          >
            <Toggle value="light" aria-label="Light variant" className="px-3 sm:px-3">
              Light
            </Toggle>
            <Toggle value="dark" aria-label="Dark variant" className="px-3 sm:px-3">
              Dark
            </Toggle>
          </ToggleGroup>
        </div>

        <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Name</span>
            <Input
              value={draft.name}
              nativeInput
              onChange={(event) => handleNameChange(event.currentTarget.value)}
              aria-invalid={draft.name.trim().length === 0 || undefined}
            />
          </label>
          <label className="space-y-1.5">
            <span className="text-xs font-medium text-foreground">Description</span>
            <Input
              value={draft.description ?? ""}
              nativeInput
              onChange={(event) => handleDescriptionChange(event.currentTarget.value)}
              placeholder="Optional, shown under the picker."
            />
          </label>
        </div>

        {mode === "form" ? (
          <div className="mt-5 space-y-5">
            {TOKEN_CATEGORIES.map((category) => (
              <div key={category.title} className="space-y-2">
                <h4 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">
                  {category.title}
                </h4>
                <div className="grid gap-2 sm:grid-cols-2">
                  {category.tokens.map((token) => {
                    const value = variantTokens[token] ?? "";
                    const inherited = inheritedTokens[token] ?? "";
                    const kind = getTokenKind(token);
                    if (!kind) return null;
                    return (
                      <TokenRow
                        key={token}
                        token={token}
                        kind={kind}
                        value={value}
                        inherited={inherited}
                        onChange={(next) => handleTokenChange(token, next)}
                      />
                    );
                  })}
                </div>
              </div>
            ))}
            {unknownTokenEntries.length > 0 ? (
              <p className="text-xs text-warning-foreground">
                {unknownTokenEntries.length} token{unknownTokenEntries.length === 1 ? "" : "s"} not
                in the allow-list will be ignored on save.
              </p>
            ) : null}
          </div>
        ) : (
          <div className="mt-5 space-y-2">
            <Textarea
              value={jsonText}
              size="sm"
              className="font-mono text-xs"
              spellCheck={false}
              rows={18}
              onChange={(event) => handleJsonChange(event.currentTarget.value)}
              aria-invalid={jsonError !== null || undefined}
            />
            {jsonError ? (
              <p className="text-xs text-destructive-foreground">{jsonError}</p>
            ) : (
              <p className="text-xs text-muted-foreground/80">
                Edit the JSON directly. Save is disabled while the schema is invalid.
              </p>
            )}
          </div>
        )}
      </div>

      <AlertDialog open={discardOpen} onOpenChange={setDiscardOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard your changes?</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved edits to {source.name}. Discarding will revert any token changes you
              made.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep editing</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setDiscardOpen(false);
                onCancel();
              }}
            >
              Discard changes
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}

type TokenRowProps = {
  token: ThemeTokenName;
  kind: ThemeTokenKind;
  value: string;
  inherited: string;
  onChange: (next: string) => void;
};

function TokenRow({ token, kind, value, inherited, onChange }: TokenRowProps) {
  const overridden = value.length > 0;
  const spanFull = kind === "font-family";

  return (
    <div
      className={cn(
        "rounded-md border border-border/60 bg-background px-2 py-1.5",
        spanFull && "sm:col-span-2",
      )}
    >
      {kind === "color" ? (
        <ColorRow
          token={token}
          value={value}
          inherited={inherited}
          overridden={overridden}
          onChange={onChange}
        />
      ) : kind === "opacity" ? (
        <OpacityRow
          token={token}
          value={value}
          inherited={inherited}
          overridden={overridden}
          onChange={onChange}
        />
      ) : kind === "length" ? (
        <LengthRow
          token={token}
          value={value}
          inherited={inherited}
          overridden={overridden}
          onChange={onChange}
        />
      ) : (
        <FontFamilyRow
          token={token}
          value={value}
          inherited={inherited}
          overridden={overridden}
          onChange={onChange}
        />
      )}
    </div>
  );
}

type RowProps = {
  token: ThemeTokenName;
  value: string;
  inherited: string;
  overridden: boolean;
  onChange: (next: string) => void;
};

function ResetButton({ token, onChange }: { token: string; onChange: (next: string) => void }) {
  return (
    <Button
      size="icon-xs"
      variant="ghost"
      aria-label={`Reset --${token}`}
      onClick={() => onChange("")}
      className="text-muted-foreground"
    >
      <XIcon className="size-3.5" aria-hidden />
    </Button>
  );
}

function TokenLabel({ token, overridden }: { token: string; overridden: boolean }) {
  return (
    <span
      className={cn(
        "truncate font-mono text-[11px]",
        overridden ? "text-foreground" : "text-muted-foreground/70",
      )}
      title={`--${token}`}
    >
      --{token}
    </span>
  );
}

function ColorRow({ token, value, inherited, overridden, onChange }: RowProps) {
  const resolvedRaw = value || inherited;
  const swatchSource = materializeTokenValue(resolvedRaw);
  const invalid = value.length > 0 && !isValidColorValue(value);

  return (
    <div className="flex items-center gap-2">
      <ColorPicker
        value={deriveHex(swatchSource)}
        onChange={(hex) => onChange(hex)}
        ariaLabel={`Pick a color for --${token}`}
      >
        <span
          className="pointer-events-none absolute inset-0"
          style={{
            backgroundColor: invalid ? "transparent" : swatchSource || "transparent",
          }}
          aria-hidden
        />
      </ColorPicker>
      <div className="flex min-w-0 flex-1 flex-col">
        <TokenLabel token={token} overridden={overridden} />
        <Input
          value={value}
          nativeInput
          unstyled
          size="sm"
          className="border-0 bg-transparent p-0 shadow-none focus-within:shadow-none"
          placeholder={inherited || "inherit default"}
          aria-invalid={invalid || undefined}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      </div>
      {overridden ? <ResetButton token={token} onChange={onChange} /> : null}
    </div>
  );
}

function OpacityRow({ token, value, inherited, overridden, onChange }: RowProps) {
  const resolved = value || inherited;
  const numeric = Number(resolved);
  const sliderValue = Number.isFinite(numeric) ? Math.min(1, Math.max(0, numeric)) : 0;
  const invalid = value.length > 0 && !isValidTokenValue("opacity", value);

  return (
    <div className="flex flex-col gap-1.5">
      <TokenLabel token={token} overridden={overridden} />
      <div className="flex items-center gap-2">
        <input
          type="range"
          min={0}
          max={1}
          step={0.005}
          value={sliderValue}
          onChange={(event) => onChange(event.currentTarget.value)}
          aria-label={`--${token} value`}
          className="settings-range h-7.5 flex-1 cursor-pointer"
        />
        <div className="w-20 shrink-0">
          <Input
            value={value}
            nativeInput
            type="number"
            min={0}
            max={1}
            step={0.005}
            size="sm"
            placeholder={inherited || "0"}
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </div>
        {overridden ? <ResetButton token={token} onChange={onChange} /> : null}
      </div>
    </div>
  );
}

function LengthRow({ token, value, inherited, overridden, onChange }: RowProps) {
  const parsedValue = parseLength(value);
  const parsedInherited = parseLength(inherited);
  const inheritedSupported = parsedInherited ? isSupportedUnit(parsedInherited.unit) : false;
  const valueSupported = parsedValue ? isSupportedUnit(parsedValue.unit) : false;

  // If either current value or the inherited default uses an unsupported unit (e.g. clamp,
  // percentages), fall back to a free-text input so we don't silently drop precision.
  const useFallback =
    (value.length > 0 && !valueSupported) ||
    (value.length === 0 && inherited.length > 0 && !inheritedSupported);

  if (useFallback) {
    const invalid = value.length > 0 && !isValidTokenValue("length", value);
    return (
      <div className="flex flex-col gap-1.5">
        <TokenLabel token={token} overridden={overridden} />
        <div className="flex items-center gap-2">
          <Input
            value={value}
            nativeInput
            size="sm"
            placeholder={inherited || "e.g. 1rem"}
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
          {overridden ? <ResetButton token={token} onChange={onChange} /> : null}
        </div>
      </div>
    );
  }

  const numberValue = parsedValue ? String(parsedValue.number) : "";
  const unit: SupportedLengthUnit =
    parsedValue && isSupportedUnit(parsedValue.unit)
      ? parsedValue.unit
      : parsedInherited && isSupportedUnit(parsedInherited.unit)
        ? parsedInherited.unit
        : "rem";
  const numberPlaceholder = parsedInherited ? String(parsedInherited.number) : "";

  const commitNumber = (raw: string) => {
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      onChange("");
      return;
    }
    const num = Number(trimmed);
    if (!Number.isFinite(num)) return;
    onChange(`${num}${unit}`);
  };

  const commitUnit = (nextUnit: SupportedLengthUnit) => {
    if (parsedValue) {
      onChange(`${parsedValue.number}${nextUnit}`);
      return;
    }
    if (parsedInherited) onChange(`${parsedInherited.number}${nextUnit}`);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <TokenLabel token={token} overridden={overridden} />
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            value={numberValue}
            nativeInput
            type="number"
            step={token === "font-size-base" ? 1 : 0.05}
            size="sm"
            placeholder={numberPlaceholder}
            onChange={(event) => commitNumber(event.currentTarget.value)}
          />
        </div>
        <SettingsSelect<SupportedLengthUnit>
          ariaLabel={`--${token} unit`}
          size="sm"
          width="sm"
          className="w-20 min-w-0 sm:w-20"
          value={unit}
          onValueChange={commitUnit}
          options={SUPPORTED_LENGTH_UNITS.map((u) => ({ value: u, label: u }))}
        />
        {overridden ? <ResetButton token={token} onChange={onChange} /> : null}
      </div>
    </div>
  );
}

function FontFamilyRow({ token, value, inherited, overridden, onChange }: RowProps) {
  const resolved = value || inherited;
  const invalid = value.length > 0 && !isValidTokenValue("font-family", value);

  return (
    <div className="flex flex-col gap-1.5">
      <TokenLabel token={token} overridden={overridden} />
      <div className="flex items-center gap-2">
        <div className="min-w-0 flex-1">
          <Input
            value={value}
            nativeInput
            size="sm"
            placeholder={inherited || "system-ui, sans-serif"}
            style={{ fontFamily: resolved || undefined }}
            aria-invalid={invalid || undefined}
            onChange={(event) => onChange(event.currentTarget.value)}
          />
        </div>
        {overridden ? <ResetButton token={token} onChange={onChange} /> : null}
      </div>
    </div>
  );
}
