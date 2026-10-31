import { useRef, useState } from "react";

import { useTheme } from "../../hooks/useTheme";
import { getClientSettingsSnapshot } from "../../hooks/clientSettingsStore";
import { persistClientSettingsUpdate } from "../../hooks/useSettings";
import {
  applyClientSettingsImport,
  buildClientSettingsFile,
  type ClientSettingsFileState,
  type ClientSettingsImportPlan,
  readClientSettingsImportFile,
} from "../../settingsFile/clientSettingsFile";
import {
  applyAppearancePreferencesToDocument,
  getAppearancePreferences,
  setAppearancePreference,
} from "../../themes/appearancePreferences";
import {
  addCustomTheme,
  deleteCustomTheme,
  generateCustomThemeId,
  getAllThemes,
  getCustomThemes,
} from "../../themes/registry";
import { downloadJsonFile } from "../../themes/transport";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";

/** Export and Import of this app's own preferences, beside Restore defaults. */
export function ClientSettingsFileActions() {
  const { theme, setTheme, activeThemeId, setActiveTheme } = useTheme();
  const inputRef = useRef<HTMLInputElement>(null);
  const [plan, setPlan] = useState<ClientSettingsImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);

  const currentState = (): ClientSettingsFileState => ({
    client: getClientSettingsSnapshot(),
    appearance: getAppearancePreferences(),
    colorMode: theme,
    activeThemeId,
    customThemes: getCustomThemes(),
  });

  const exportFile = () => {
    const file = buildClientSettingsFile(currentState(), new Date());
    downloadJsonFile("ryco-client-settings.json", `${JSON.stringify(file, null, 2)}\n`);
  };

  const readFile = (file: File) => {
    setError(null);
    void readClientSettingsImportFile(file, currentState(), {
      newThemeId: (imported) => generateCustomThemeId(imported.id),
      themeExists: (id) => getAllThemes().some((entry) => entry.id === id),
    })
      .then(setPlan)
      .catch((cause: unknown) =>
        setError(cause instanceof Error ? cause.message : "Could not read the file."),
      );
  };

  const apply = () => {
    if (!plan) return;
    setApplying(true);
    setError(null);
    void applyClientSettingsImport(plan, currentState(), {
      addTheme: addCustomTheme,
      removeTheme: deleteCustomTheme,
      setAppearance: (key, value) => {
        setAppearancePreference(key, value);
        applyAppearancePreferencesToDocument();
      },
      setColorMode: setTheme,
      setActiveTheme,
      saveClientSettings: persistClientSettingsUpdate,
    })
      .then(() => setPlan(null))
      .catch((cause: unknown) =>
        setError(
          `Nothing was imported: ${cause instanceof Error ? cause.message : "saving failed."}`,
        ),
      )
      .finally(() => setApplying(false));
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex gap-2">
        <Button size="sm" variant="outline" onClick={exportFile}>
          Export
        </Button>
        <Button size="sm" variant="outline" onClick={() => inputRef.current?.click()}>
          Import
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".json,application/json"
          className="hidden"
          aria-label="Preferences file to import"
          onChange={(event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (file) readFile(file);
          }}
        />
      </div>
      {error && !plan ? (
        <span role="alert" className="text-xs text-destructive">
          {error}
        </span>
      ) : null}
      <Dialog open={plan !== null} onOpenChange={(open) => !open && setPlan(null)}>
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Import preferences</DialogTitle>
            <DialogDescription>
              Only this app's preferences change. Nodes, accounts and connections stay as they are.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {plan && plan.changes.length === 0 ? (
              <p className="text-sm">These preferences match yours; nothing would change.</p>
            ) : (
              <ul aria-label="Changes" className="space-y-1 font-mono text-xs">
                {plan?.changes.map((change) => (
                  <li key={change}>{change}</li>
                ))}
              </ul>
            )}
            {plan && plan.warnings.length > 0 ? (
              <ul
                aria-label="Left as they are"
                className="mt-3 space-y-1 text-xs text-muted-foreground"
              >
                {plan.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
            {error ? (
              <p role="alert" className="mt-3 text-xs text-destructive">
                {error}
              </p>
            ) : null}
          </DialogPanel>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPlan(null)}>
              Cancel
            </Button>
            <Button disabled={applying || plan?.changes.length === 0} onClick={apply}>
              Apply
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
    </div>
  );
}
