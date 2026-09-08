import { Menu, MenuTrigger, MenuPopup, MenuItem } from "../ui/menu";
import {
  EllipsisIcon,
  BaselineIcon,
  ClipboardCopyIcon,
  Code2Icon,
  CopyIcon,
  DownloadIcon,
  GaugeIcon,
  PaletteIcon,
  PencilIcon,
  PlusIcon,
  RadiusIcon,
  Trash2Icon,
  TypeIcon,
  UploadIcon,
} from "lucide-react";
import {
  type ChangeEvent,
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTheme } from "../../hooks/useTheme";
import { cn } from "../../lib/utils";
import {
  APPEARANCE_PREFERENCES_STORAGE_KEY,
  FONT_FAMILY_MONO_OPTIONS,
  FONT_FAMILY_SANS_OPTIONS,
  FONT_SIZE_OPTIONS,
  PRIMARY_COLOR_OPTIONS,
  RADIUS_OPTIONS,
  SURFACE_TRANSPARENCY_OPTIONS,
  applyAppearancePreferencesToDocument,
  getAppearancePreferences,
  hasAppearancePreferenceOverride,
  resetAppearancePreference,
  setAppearancePreference,
  type AppearancePreferenceKey,
  type AppearancePreferenceOption,
} from "../../themes/appearancePreferences";
import {
  addCustomTheme,
  applyThemeToDocument,
  deleteCustomTheme,
  duplicateTheme,
  findTheme,
  generateCustomThemeId,
  getAllThemes,
  isBuiltInThemeId,
  setActiveThemeId,
  updateCustomTheme,
} from "../../themes/registry";
import { copyThemeToClipboard, downloadTheme, importThemeFromFile } from "../../themes/transport";
import type { ThemeDefinition } from "../../themes/types";
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
import { Button } from "../ui/button";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { ColorPicker } from "../ui/color-picker";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { DiffAppearanceSettings } from "./DiffAppearanceSettings";
import { ThemePreview } from "./ThemePreview";
import { ThemeEditor } from "./ThemeEditor";

const VARIANT_OPTIONS = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
] as const;

const TRANSPARENCY_PREVIEW_OPACITY: Record<string, number> = {
  default: 1,
  light: 0.92,
  medium: 0.84,
  high: 0.78,
  glass: 0.72,
};

export function AppearanceSettingsPanel({
  surface = "node",
}: {
  /**
   * Which product is showing this panel.
   *
   * `hub` is the Hub website's `/account/appearance` page, which offers only
   * the controls that mean something there — colour mode, theme palette, fonts,
   * text size, primary colour, transparency. The code font, the corner radius,
   * and the composer controls describe a node workspace,
   * and a hosted user may have no node at all; they stay in the node app's own
   * settings, reachable from inside a node session.
   */
  readonly surface?: "node" | "hub";
} = {}) {
  const isHub = surface === "hub";
  const { theme, setTheme, resolvedTheme, activeThemeId, setActiveTheme } = useTheme();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [draft, setDraft] = useState<ThemeDefinition | null>(null);
  const [pendingDeleteId, setPendingDeleteId] = useState<string | null>(null);
  const [appearancePreferences, setAppearancePreferencesState] = useState(() =>
    getAppearancePreferences(),
  );
  const [refreshTick, setRefreshTick] = useState(0);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  const themes = getAllThemes();
  const editing = useMemo(() => {
    void refreshTick;
    return editingId !== null && draft !== null ? { source: findTheme(editingId), draft } : null;
  }, [draft, editingId, refreshTick]);
  const pendingDeleteTheme = pendingDeleteId ? findTheme(pendingDeleteId) : null;

  const refresh = useCallback(() => setRefreshTick((tick) => tick + 1), []);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== APPEARANCE_PREFERENCES_STORAGE_KEY) return;
      setAppearancePreferencesState(getAppearancePreferences());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const handleAppearancePreferenceChange = useCallback(
    (key: AppearancePreferenceKey, value: string) => {
      setAppearancePreference(key, value);
      applyAppearancePreferencesToDocument();
      setAppearancePreferencesState(getAppearancePreferences());
    },
    [],
  );

  const handleAppearancePreferenceReset = useCallback((key: AppearancePreferenceKey) => {
    resetAppearancePreference(key);
    applyAppearancePreferencesToDocument();
    setAppearancePreferencesState(getAppearancePreferences());
  }, []);

  const handlePrimaryColorReset = useCallback(() => {
    resetAppearancePreference("primaryColorMode");
    resetAppearancePreference("primaryColor");
    applyAppearancePreferencesToDocument();
    setAppearancePreferencesState(getAppearancePreferences());
  }, []);

  const handlePrimaryColorModeChange = useCallback((custom: boolean) => {
    setAppearancePreference("primaryColorMode", custom ? "custom" : "theme");
    applyAppearancePreferencesToDocument();
    setAppearancePreferencesState(getAppearancePreferences());
  }, []);

  const handlePrimaryColorChange = useCallback((value: string) => {
    setAppearancePreference("primaryColor", value);
    setAppearancePreference("primaryColorMode", "custom");
    applyAppearancePreferencesToDocument();
    setAppearancePreferencesState(getAppearancePreferences());
  }, []);

  const startEditing = useCallback(
    (target: ThemeDefinition) => {
      if (isBuiltInThemeId(target.id)) {
        const copy = duplicateTheme(target);
        addCustomTheme(copy);
        setActiveThemeId(copy.id);
        setActiveTheme(copy.id);
        setEditingId(copy.id);
        setDraft(copy);
        refresh();
        return;
      }
      setActiveTheme(target.id);
      setEditingId(target.id);
      setDraft(target);
    },
    [refresh, setActiveTheme],
  );

  const handleDuplicate = useCallback(
    (target: ThemeDefinition) => {
      const copy = duplicateTheme(target);
      addCustomTheme(copy);
      setActiveTheme(copy.id);
      setEditingId(copy.id);
      setDraft(copy);
      refresh();
    },
    [refresh, setActiveTheme],
  );

  const handleAddNew = useCallback(() => {
    const fresh: ThemeDefinition = {
      id: generateCustomThemeId("new"),
      name: "New theme",
      builtIn: false,
    };
    addCustomTheme(fresh);
    setActiveTheme(fresh.id);
    setEditingId(fresh.id);
    setDraft(fresh);
    refresh();
  }, [refresh, setActiveTheme]);

  const handleSave = useCallback(() => {
    if (!editing) return;
    updateCustomTheme(editing.source.id, editing.draft);
    if (editing.source.id !== editing.draft.id) {
      setActiveTheme(editing.draft.id);
    } else {
      applyThemeToDocument(editing.draft);
    }
    setEditingId(null);
    setDraft(null);
    refresh();
  }, [editing, refresh, setActiveTheme]);

  const handleCancel = useCallback(() => {
    if (editing) applyThemeToDocument(editing.source);
    setEditingId(null);
    setDraft(null);
  }, [editing]);

  const confirmDelete = useCallback(() => {
    if (!pendingDeleteId) return;
    if (editingId === pendingDeleteId) {
      setEditingId(null);
      setDraft(null);
    }
    deleteCustomTheme(pendingDeleteId);
    setPendingDeleteId(null);
    refresh();
  }, [editingId, pendingDeleteId, refresh]);

  const handleExport = useCallback((target: ThemeDefinition) => {
    try {
      downloadTheme(target);
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not export theme",
        description: error instanceof Error ? error.message : "Download failed.",
      });
    }
  }, []);

  const handleCopyJson = useCallback(async (target: ThemeDefinition) => {
    try {
      await copyThemeToClipboard(target);
      toastManager.add({
        type: "success",
        title: "Copied theme JSON",
        description: `${target.name} is ready to paste.`,
      });
    } catch (error) {
      toastManager.add({
        type: "error",
        title: "Could not copy theme",
        description: error instanceof Error ? error.message : "Clipboard write failed.",
      });
    }
  }, []);

  const handleImportClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleImportChange = useCallback(
    async (event: ChangeEvent<HTMLInputElement>) => {
      const file = event.target.files?.[0];
      event.target.value = "";
      if (!file) return;
      try {
        const result = await importThemeFromFile(file, { collision: "rename", activate: true });
        setActiveTheme(result.theme.id);
        refresh();
        toastManager.add({
          type: "success",
          title: `Imported "${result.theme.name}"`,
          description:
            result.action === "renamed"
              ? `An existing theme used the same id, so it was imported as "${result.theme.id}".`
              : "Theme imported and activated.",
        });
      } catch (error) {
        toastManager.add({
          type: "error",
          title: "Could not import theme",
          description: error instanceof Error ? error.message : "Invalid theme file.",
        });
      }
    },
    [refresh, setActiveTheme],
  );

  return (
    <SettingsPageContainer>
      <SettingsSection title="Color mode">
        <div className="grid grid-cols-3 gap-3 p-4" role="group" aria-label="Color mode">
          {VARIANT_OPTIONS.map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={theme === option.value}
              onClick={() => setTheme(option.value)}
              className={cn(
                "min-w-0 rounded-xl border p-2 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-ring",
                theme === option.value
                  ? "border-primary bg-muted/40"
                  : "border-border hover:bg-muted/30",
              )}
            >
              <div className="relative overflow-hidden rounded-lg">
                <ThemePreview
                  compact
                  theme={findTheme(activeThemeId)}
                  variant={option.value === "dark" ? "dark" : "light"}
                />
                {option.value === "system" && (
                  <div className="absolute inset-0 [clip-path:inset(0_0_0_50%)]">
                    <ThemePreview compact theme={findTheme(activeThemeId)} variant="dark" />
                  </div>
                )}
              </div>
              <span className="mt-2 block font-medium">{option.label}</span>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection
        title="Theme palette"
        headerAction={
          <div className="flex items-center gap-1">
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="sr-only"
              onChange={handleImportChange}
              aria-hidden
              tabIndex={-1}
            />
            <Button
              size="xs"
              variant="ghost"
              onClick={handleAddNew}
              aria-label="Create a new theme"
              title="Create a new theme"
              className="text-muted-foreground"
            >
              <PlusIcon className="size-3.5" />
              New
            </Button>
            <Button
              size="xs"
              variant="ghost"
              onClick={handleImportClick}
              aria-label="Import a theme from file"
              title="Import a theme from disk"
              className="text-muted-foreground"
            >
              <UploadIcon className="size-3.5" />
              Import
            </Button>
          </div>
        }
      >
        <div role="radiogroup" aria-label="Theme palette" className="grid grid-cols-2 gap-4 p-4">
          {themes.map((entry) => {
            const isActive = entry.id === activeThemeId;
            const isEditing = editingId === entry.id;
            return (
              <Fragment key={entry.id}>
                <div
                  role="radio"
                  aria-checked={isActive}
                  tabIndex={isActive ? 0 : -1}
                  onClick={() => setActiveTheme(entry.id)}
                  onKeyDown={(event) => {
                    const direction =
                      event.key === "ArrowRight" || event.key === "ArrowDown"
                        ? 1
                        : event.key === "ArrowLeft" || event.key === "ArrowUp"
                          ? -1
                          : 0;
                    if (direction) {
                      event.preventDefault();
                      const index = themes.findIndex((theme) => theme.id === entry.id);
                      const next = (index + direction + themes.length) % themes.length;
                      setActiveTheme(themes[next]!.id);
                      const radios =
                        event.currentTarget.parentElement?.querySelectorAll<HTMLElement>(
                          '[role="radio"]',
                        );
                      radios?.item(next).focus();
                    }
                    if (event.key === " " || event.key === "Enter") {
                      event.preventDefault();
                      setActiveTheme(entry.id);
                    }
                  }}
                  className={cn(
                    "flex cursor-pointer flex-wrap items-center gap-3 rounded-xl border p-3 outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
                    isActive ? "border-primary" : "border-border",
                    isActive ? "bg-muted/40" : "hover:bg-muted/24",
                  )}
                >
                  <ThemePreview theme={entry} variant={resolvedTheme} />
                  <span
                    aria-hidden
                    className={cn(
                      "relative flex size-4 shrink-0 items-center justify-center rounded-full border-2 transition-colors",
                      isActive ? "border-primary" : "border-muted-foreground/40",
                    )}
                  >
                    {isActive ? (
                      <span className="size-2 rounded-full bg-primary" aria-hidden />
                    ) : null}
                  </span>
                  <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                    <span className="flex items-center gap-2">
                      <span
                        className="truncate text-sm font-medium text-foreground"
                        title={entry.name}
                      >
                        {entry.name}
                      </span>
                      <Badge variant="outline" size="sm">
                        {entry.builtIn ? "Built-in" : "Custom"}
                      </Badge>
                    </span>
                    {entry.description ? (
                      <span
                        className="truncate text-xs text-muted-foreground/80"
                        title={entry.description}
                      >
                        {entry.description}
                      </span>
                    ) : null}
                  </div>
                  <div
                    onClick={(event) => event.stopPropagation()}
                    onKeyDown={(event) => event.stopPropagation()}
                  >
                    <Menu>
                      <MenuTrigger
                        render={
                          <Button
                            size="icon-xs"
                            variant="ghost"
                            aria-label={`Theme actions for ${entry.name}`}
                          >
                            <EllipsisIcon className="size-4" />
                          </Button>
                        }
                      />
                      <MenuPopup align="end">
                        {!entry.builtIn && (
                          <MenuItem onClick={() => startEditing(entry)}>
                            <PencilIcon /> Edit
                          </MenuItem>
                        )}
                        <MenuItem onClick={() => handleDuplicate(entry)}>
                          <CopyIcon /> Duplicate
                        </MenuItem>
                        <MenuItem onClick={() => handleExport(entry)}>
                          <DownloadIcon /> Export
                        </MenuItem>
                        <MenuItem onClick={() => void handleCopyJson(entry)}>
                          <ClipboardCopyIcon /> Copy JSON
                        </MenuItem>
                        {!entry.builtIn && (
                          <MenuItem onClick={() => setPendingDeleteId(entry.id)}>
                            <Trash2Icon /> Delete
                          </MenuItem>
                        )}
                      </MenuPopup>
                    </Menu>
                  </div>
                </div>
                {isEditing && editing ? (
                  <div className="col-span-full">
                    <ThemeEditor
                      source={editing.source}
                      draft={editing.draft}
                      onDraftChange={(next) => setDraft(next)}
                      onSave={handleSave}
                      onCancel={handleCancel}
                      resolvedVariant={resolvedTheme}
                    />
                  </div>
                ) : null}
              </Fragment>
            );
          })}
        </div>
      </SettingsSection>

      {!isHub && <DiffAppearanceSettings />}
      <SettingsSection title="Typography">
        <SettingsRow
          title="Interface font"
          description="Normal app text, navigation, dialogs, and controls."
          resetAction={
            hasAppearancePreferenceOverride("fontFamilySans") ? (
              <SettingResetButton
                label="interface font"
                onClick={() => handleAppearancePreferenceReset("fontFamilySans")}
              />
            ) : null
          }
          control={
            <FontPreferencePicker
              ariaLabel="Interface font"
              icon={<TypeIcon className="size-3.5" />}
              options={FONT_FAMILY_SANS_OPTIONS}
              value={appearancePreferences.fontFamilySans}
              sample="The quick brown fox"
              onChange={(value) => handleAppearancePreferenceChange("fontFamilySans", value)}
            />
          }
        />
        {isHub ? null : (
          <SettingsRow
            title="Code font"
            description="Code blocks, diffs, file paths, and terminal surfaces."
            resetAction={
              hasAppearancePreferenceOverride("fontFamilyMono") ? (
                <SettingResetButton
                  label="code font"
                  onClick={() => handleAppearancePreferenceReset("fontFamilyMono")}
                />
              ) : null
            }
            control={
              <FontPreferencePicker
                ariaLabel="Code font"
                icon={<Code2Icon className="size-3.5" />}
                options={FONT_FAMILY_MONO_OPTIONS}
                value={appearancePreferences.fontFamilyMono}
                sample="const answer = 42"
                onChange={(value) => handleAppearancePreferenceChange("fontFamilyMono", value)}
              />
            }
          />
        )}
        <SettingsRow
          title="Text size"
          description="Scale the interface independently from the active theme."
          resetAction={
            hasAppearancePreferenceOverride("fontSizeBase") ? (
              <SettingResetButton
                label="text size"
                onClick={() => handleAppearancePreferenceReset("fontSizeBase")}
              />
            ) : null
          }
          control={
            <AppearancePreferenceSlider
              ariaLabel="Text size"
              icon={<BaselineIcon className="size-3.5" />}
              options={FONT_SIZE_OPTIONS}
              value={appearancePreferences.fontSizeBase}
              onChange={(value) => handleAppearancePreferenceChange("fontSizeBase", value)}
              preview={
                <span className="flex h-9 min-w-14 items-center justify-center rounded-md border border-border/70 bg-background px-2 font-semibold text-foreground shadow-xs/5">
                  <span style={{ fontSize: appearancePreferences.fontSizeBase }}>Aa</span>
                </span>
              }
            />
          }
        />
      </SettingsSection>
      <SettingsSection title="Interface">
        {isHub ? null : (
          <SettingsRow
            title="Corner radius"
            description="Adjust rounding for panels, buttons, inputs, and menus globally."
            resetAction={
              hasAppearancePreferenceOverride("radius") ? (
                <SettingResetButton
                  label="corner radius"
                  onClick={() => handleAppearancePreferenceReset("radius")}
                />
              ) : null
            }
            control={
              <AppearancePreferenceSlider
                ariaLabel="Corner radius"
                icon={<RadiusIcon className="size-3.5" />}
                options={RADIUS_OPTIONS}
                value={appearancePreferences.radius}
                onChange={(value) => handleAppearancePreferenceChange("radius", value)}
                preview={
                  <span className="grid h-9 min-w-14 grid-cols-2 gap-1 rounded-md border border-border/70 bg-background p-1.5 shadow-xs/5">
                    <span
                      className="border border-primary/55 bg-primary/15"
                      style={{ borderRadius: appearancePreferences.radius }}
                    />
                    <span
                      className="border border-muted-foreground/30 bg-muted"
                      style={{ borderRadius: appearancePreferences.radius }}
                    />
                  </span>
                }
              />
            }
          />
        )}
        <SettingsRow
          title="Primary color"
          description="Theme palettes control buttons by default; enable a custom color to pin one app accent."
          resetAction={
            hasAppearancePreferenceOverride("primaryColorMode") ||
            hasAppearancePreferenceOverride("primaryColor") ? (
              <SettingResetButton label="primary color" onClick={handlePrimaryColorReset} />
            ) : null
          }
          control={
            <PrimaryColorPreferencePicker
              mode={appearancePreferences.primaryColorMode}
              value={appearancePreferences.primaryColor}
              onModeChange={handlePrimaryColorModeChange}
              onColorChange={handlePrimaryColorChange}
            />
          }
        />
        <SettingsRow
          title="Transparency"
          description="Adjust glass and floating surfaces like dialogs, menus, popups, and toasts."
          resetAction={
            hasAppearancePreferenceOverride("surfaceTransparency") ? (
              <SettingResetButton
                label="transparency"
                onClick={() => handleAppearancePreferenceReset("surfaceTransparency")}
              />
            ) : null
          }
          control={
            <AppearancePreferenceSlider
              ariaLabel="Transparency"
              icon={<GaugeIcon className="size-3.5" />}
              options={SURFACE_TRANSPARENCY_OPTIONS}
              value={appearancePreferences.surfaceTransparency}
              onChange={(value) => handleAppearancePreferenceChange("surfaceTransparency", value)}
              preview={
                <span className="relative h-9 min-w-14 overflow-hidden rounded-md border border-border/70 bg-[linear-gradient(135deg,var(--color-sky-500)_0_20%,var(--color-emerald-500)_20%_40%,var(--color-amber-500)_40%_60%,var(--color-fuchsia-500)_60%_80%,var(--color-slate-500)_80%_100%)] p-1.5 shadow-xs/5">
                  <span
                    className="block h-full rounded border border-border/70 bg-popover"
                    style={{
                      opacity:
                        TRANSPARENCY_PREVIEW_OPACITY[appearancePreferences.surfaceTransparency] ??
                        TRANSPARENCY_PREVIEW_OPACITY.default,
                    }}
                  />
                </span>
              }
            />
          }
        />
      </SettingsSection>

      <AlertDialog
        open={pendingDeleteId !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDeleteId(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete custom theme?</AlertDialogTitle>
            <AlertDialogDescription>
              {pendingDeleteTheme
                ? `"${pendingDeleteTheme.name}" will be removed permanently. This action cannot be undone.`
                : "This action cannot be undone."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button variant="destructive" onClick={confirmDelete}>
              Delete theme
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsPageContainer>
  );
}

function FontPreferencePicker({
  ariaLabel,
  icon,
  options,
  value,
  sample,
  onChange,
}: {
  ariaLabel: string;
  icon: ReactNode;
  options: ReadonlyArray<AppearancePreferenceOption>;
  value: string;
  sample: string;
  onChange: (value: string) => void;
}) {
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[selectedIndex] ?? options[0];

  return (
    <div className="w-full sm:w-96">
      <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/60 text-muted-foreground">
            {icon}
          </span>
          <span className="min-w-0">
            <span
              className="block truncate text-sm font-semibold text-foreground"
              style={{ fontFamily: current?.value ?? value }}
            >
              {current?.label ?? value}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {current?.description ?? "Custom"}
            </span>
          </span>
        </div>
        <span
          className="flex h-9 min-w-30 max-w-44 items-center justify-start truncate rounded-md border border-border/70 bg-background px-2 text-xs text-foreground shadow-xs/5"
          style={{ fontFamily: current?.value ?? value }}
          title={sample}
        >
          {sample}
        </span>
      </div>
      <div
        role="radiogroup"
        aria-label={ariaLabel}
        className="grid grid-cols-2 gap-1.5 sm:grid-cols-3"
      >
        {options.map((option, index) => {
          const selected = index === selectedIndex;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={`Use ${option.label} for ${ariaLabel.toLowerCase()}`}
              title={`${option.label} (${option.description})`}
              onClick={() => onChange(option.value)}
              className={cn(
                "min-h-12 min-w-0 rounded-md border px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected
                  ? "border-primary bg-primary/8 text-foreground ring-1 ring-primary/35"
                  : "border-border/70 text-muted-foreground hover:border-foreground/25 hover:bg-muted/45",
              )}
            >
              <span
                className="block truncate text-[12px] font-semibold leading-4"
                style={{ fontFamily: option.value }}
              >
                {option.label}
              </span>
              <span className="block truncate text-[10px] leading-3 opacity-75">
                {option.description}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function PrimaryColorPreferencePicker({
  mode,
  value,
  onModeChange,
  onColorChange,
}: {
  mode: string;
  value: string;
  onModeChange: (custom: boolean) => void;
  onColorChange: (value: string) => void;
}) {
  const custom = mode === "custom";
  const normalizedValue = /^#[0-9a-f]{6}$/i.test(value)
    ? value.toLowerCase()
    : PRIMARY_COLOR_OPTIONS[0].value;
  const current = PRIMARY_COLOR_OPTIONS.find((option) => option.value === normalizedValue);
  const customPickerClassName = cn(
    "h-12 w-full rounded-md border px-2 py-1.5 text-left shadow-none",
    custom && !current
      ? "border-primary bg-primary/8 text-foreground ring-1 ring-primary/35"
      : "border-border/70 text-muted-foreground hover:border-foreground/25 hover:bg-muted/45",
    !custom && "cursor-not-allowed opacity-55 hover:border-border/70 hover:bg-transparent",
  );
  const customPickerContent = (
    <span className="flex size-full min-w-0 items-center gap-2">
      <span
        aria-hidden
        className="size-5 shrink-0 rounded-full border border-black/10 shadow-xs dark:border-white/20"
        style={{ backgroundColor: normalizedValue }}
      />
      <span className="min-w-0">
        <span className="block truncate text-[12px] font-semibold leading-4">Custom</span>
        <span className="block truncate font-mono text-[10px] leading-3 opacity-75">
          {normalizedValue}
        </span>
      </span>
    </span>
  );

  return (
    <div className="w-full sm:w-96">
      <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/60 text-muted-foreground">
            <PaletteIcon className="size-3.5" />
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">
              {custom ? (current?.label ?? "Custom") : "Theme color"}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {custom ? normalizedValue : "Active palette"}
            </span>
          </span>
        </div>
        <label className="flex h-9 shrink-0 items-center gap-2 rounded-md border border-border/70 bg-background px-2 text-xs text-muted-foreground shadow-xs/5">
          <span>Use theme</span>
          <Switch
            checked={!custom}
            onCheckedChange={(checked) => onModeChange(!checked)}
            aria-label="Use theme primary color"
          />
        </label>
      </div>
      <div
        role="radiogroup"
        aria-label="Primary color"
        className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
      >
        {PRIMARY_COLOR_OPTIONS.map((option) => {
          const selected = normalizedValue === option.value;
          return (
            <button
              key={option.value}
              type="button"
              role="radio"
              aria-checked={custom && selected}
              aria-label={`Use ${option.label} as primary color`}
              title={`${option.label} (${option.value})`}
              onClick={() => onColorChange(option.value)}
              disabled={!custom}
              className={cn(
                "flex min-h-12 min-w-0 items-center gap-2 rounded-md border px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                custom && selected
                  ? "border-primary bg-primary/8 text-foreground ring-1 ring-primary/35"
                  : "border-border/70 text-muted-foreground hover:border-foreground/25 hover:bg-muted/45",
                !custom &&
                  "cursor-not-allowed opacity-55 hover:border-border/70 hover:bg-transparent",
              )}
            >
              <span
                aria-hidden
                className="size-5 shrink-0 rounded-full border border-black/10 shadow-xs dark:border-white/20"
                style={{ backgroundColor: option.value }}
              />
              <span className="min-w-0">
                <span className="block truncate text-[12px] font-semibold leading-4">
                  {option.label}
                </span>
                <span className="block truncate text-[10px] leading-3 opacity-75">
                  {option.description}
                </span>
              </span>
            </button>
          );
        })}
        {custom ? (
          <ColorPicker
            value={normalizedValue}
            onChange={onColorChange}
            ariaLabel="Pick custom primary color"
            triggerClassName={customPickerClassName}
          >
            {customPickerContent}
          </ColorPicker>
        ) : (
          <button
            type="button"
            disabled
            aria-label="Pick custom primary color"
            className={customPickerClassName}
          >
            {customPickerContent}
          </button>
        )}
      </div>
    </div>
  );
}

function AppearancePreferenceSlider({
  ariaLabel,
  icon,
  options,
  value,
  onChange,
  preview,
}: {
  ariaLabel: string;
  icon: ReactNode;
  options: ReadonlyArray<AppearancePreferenceOption>;
  value: string;
  onChange: (value: string) => void;
  preview: ReactNode;
}) {
  const selectedIndex = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  const current = options[selectedIndex] ?? options[0];
  const progress = options.length > 1 ? (selectedIndex / (options.length - 1)) * 100 : 0;

  return (
    <div className="w-full sm:w-96">
      <div className="mb-2 flex min-h-9 items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-md border border-border/70 bg-muted/60 text-muted-foreground">
            {icon}
          </span>
          <span className="min-w-0">
            <span className="block truncate text-sm font-semibold text-foreground">
              {current?.label ?? value}
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              {current?.description ?? value}
            </span>
          </span>
        </div>
        {preview}
      </div>
      <input
        aria-label={ariaLabel}
        className={cn(
          "h-5 w-full cursor-pointer appearance-none bg-transparent outline-none",
          "[&::-webkit-slider-runnable-track]:h-1.5 [&::-webkit-slider-runnable-track]:rounded-full",
          "[&::-webkit-slider-thumb]:mt-[-5px] [&::-webkit-slider-thumb]:size-4 [&::-webkit-slider-thumb]:appearance-none [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-2 [&::-webkit-slider-thumb]:border-background [&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-sm",
          "[&::-moz-range-track]:h-1.5 [&::-moz-range-track]:rounded-full [&::-moz-range-track]:border-0",
          "[&::-moz-range-thumb]:size-4 [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-2 [&::-moz-range-thumb]:border-background [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-sm",
          "focus-visible:[&::-webkit-slider-thumb]:ring-2 focus-visible:[&::-webkit-slider-thumb]:ring-ring focus-visible:[&::-moz-range-thumb]:ring-2 focus-visible:[&::-moz-range-thumb]:ring-ring",
        )}
        max={Math.max(0, options.length - 1)}
        min={0}
        step={1}
        type="range"
        value={selectedIndex}
        style={{
          background: `linear-gradient(to right, var(--color-primary) 0%, var(--color-primary) ${progress}%, color-mix(in srgb, var(--color-muted-foreground) 18%, transparent) ${progress}%, color-mix(in srgb, var(--color-muted-foreground) 18%, transparent) 100%)`,
          borderRadius: "999px",
        }}
        onChange={(event) => {
          const next = options[Number(event.currentTarget.value)];
          if (next) onChange(next.value);
        }}
      />
      <div
        className="mt-1.5 grid gap-1"
        style={{ gridTemplateColumns: `repeat(${options.length}, minmax(0, 1fr))` }}
      >
        {options.map((option, index) => {
          const selected = index === selectedIndex;
          return (
            <button
              key={option.value}
              type="button"
              aria-label={`Set ${ariaLabel.toLowerCase()} to ${option.label}`}
              title={`${option.label} (${option.description})`}
              onClick={() => onChange(option.value)}
              className={cn(
                "flex min-h-7 min-w-0 flex-col items-center justify-start gap-1 rounded-md px-1 py-1 text-center outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring",
                selected ? "text-foreground" : "text-muted-foreground hover:bg-muted/50",
              )}
            >
              <span
                className={cn(
                  "size-1.5 rounded-full",
                  selected ? "bg-primary" : "bg-muted-foreground/35",
                )}
                aria-hidden
              />
              <span className="max-w-full truncate text-[10px] leading-none">{option.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
